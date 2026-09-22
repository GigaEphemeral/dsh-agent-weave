/**
 * l2-engine/chain-runner.ts 单测（P1.2.1 核心逻辑，零 LLM）。
 *
 * 用 fake ctx.subagents 验证：
 * - 串行按序执行每个角色
 * - 产物落盘 productions/<角色ID>/
 * - 下游 prompt 只携带上游摘要+路径（不传全文）
 * - fail-fast：角色 start 抛错则中止
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import {
  runChain,
  resultToText,
  stripCodeFence,
  chainLogPath,
  stopFlagPath,
  type ChainStep,
} from '../../src/l2-engine/chain-runner'

/** 构造一个 fake Context：subagents.start 记录请求并按序返回。 */
function fakeCtx(steps: Array<{ stopReason?: string; output?: string }>) {
  const calls: Array<{ provider: string; prompt: string }> = []
  let index = 0
  const ctx = {
    subagents: {
      start: vi.fn(async (provider: string, request: { prompt: Array<{ text: string }> }) => {
        calls.push({ provider, prompt: request.prompt.map((b) => b.text).join('') })
        const step = steps[index] ?? { stopReason: 'completed', output: 'output' }
        index++
        return {
          id: `child-${index}`,
          localAgent: undefined,
          result: Promise.resolve({
            output: [{ type: 'text', text: step.output ?? 'output' }],
            stopReason: step.stopReason ?? 'completed',
          }),
          dispose: async () => {},
        }
      }),
      getProvider: vi.fn(() => undefined),
    },
  } as unknown as Context
  return { ctx, calls }
}

const parent = {} as never

function makeStep(roleId: string, artifactName: string, phase: string): ChainStep {
  return {
    roleId,
    artifactName,
    phase,
    prompt: ({ upstream }) => {
      const up = upstream.map((u) => `${u.roleId}@${u.path}:${u.summary}`).join(' | ')
      return `${phase} 任务, 上游: ${up}`
    },
  }
}

describe('runChain', () => {
  it('串行按序执行全部角色并落盘产物', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-chain-'))
    try {
      const { ctx, calls } = fakeCtx([
        { output: 'PRD 内容' },
        { output: '架构内容' },
        { output: '设计内容' },
      ])
      const steps = [
        makeStep('R1-requirement', 'prd.md', '需求分析'),
        makeStep('R2-architect', 'arch.md', '架构设计'),
        makeStep('R4-designer', 'design.md', '详细设计'),
      ]
      const result = await runChain(ctx, parent, steps, '做一个计算器', root)

      expect(calls.map((c) => c.provider)).toEqual(['R1-requirement', 'R2-architect', 'R4-designer'])
      expect(result.steps).toHaveLength(3)
      expect(result.productionsRoot).toBe(root)

      // 产物落盘
      expect(readFileSync(join(root, 'R1-requirement', 'prd.md'), 'utf8')).toBe('PRD 内容')
      expect(readFileSync(join(root, 'R2-architect', 'arch.md'), 'utf8')).toBe('架构内容')
      expect(readFileSync(join(root, 'R4-designer', 'design.md'), 'utf8')).toBe('设计内容')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('下游 prompt 携带上游摘要与路径，不含上游全文', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-chain-'))
    try {
      const longOutput = 'A'.repeat(2000)
      const { ctx, calls } = fakeCtx([{ output: longOutput }, { output: '下游产物' }])
      const steps = [
        makeStep('R1-requirement', 'prd.md', '需求分析'),
        makeStep('R2-architect', 'arch.md', '架构设计'),
      ]
      await runChain(ctx, parent, steps, '任务', root)

      const secondPrompt = calls[1]?.prompt ?? ''
      // 含上游路径与截断摘要
      expect(secondPrompt).toContain('R1-requirement@')
      expect(secondPrompt).toContain('prd.md')
      // 不含上游全文（2000 字符被截断为 500）
      expect(secondPrompt).not.toContain('A'.repeat(1000))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('角色 start 抛错则 fail-fast 中止', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-chain-'))
    try {
      const ctx = {
        subagents: {
          start: vi.fn(async () => {
            throw new Error('subagent start failed')
          }),
          getProvider: vi.fn(() => undefined),
        },
      } as unknown as Context
      const steps = [
        makeStep('R1-requirement', 'prd.md', '需求分析'),
        makeStep('R2-architect', 'arch.md', '架构设计'),
      ]
      await expect(runChain(ctx, parent, steps, '任务', root)).rejects.toThrow('subagent start failed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('非 completed 结果也落盘现场（便于排查）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-chain-'))
    try {
      const { ctx, calls } = fakeCtx([{ output: '部分输出', stopReason: 'error' }])
      const steps = [makeStep('R1-requirement', 'prd.md', '需求分析')]
      const result = await runChain(ctx, parent, steps, '任务', root)
      expect(calls).toHaveLength(1)
      expect(result.steps[0]?.stopReason).toBe('error')
      expect(readFileSync(join(root, 'R1-requirement', 'prd.md'), 'utf8')).toBe('部分输出')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('stripCodeFence（纯代码产物剥离 Markdown 包裹）', () => {
  it('剥离 ```html 包裹', () => {
    const wrapped = '```html\n<!DOCTYPE html>\n<html><body>hi</body></html>\n```'
    expect(stripCodeFence(wrapped)).toBe('<!DOCTYPE html>\n<html><body>hi</body></html>')
  })

  it('剥离无语言标记的 ``` 包裹', () => {
    expect(stripCodeFence('```\ncode here\n```')).toBe('code here')
  })

  it('无包裹时原样返回', () => {
    expect(stripCodeFence('<!DOCTYPE html>\n<html></html>')).toBe('<!DOCTYPE html>\n<html></html>')
  })

  it('仅剥离最外层包裹（内部代码块保留）', () => {
    const text = '```html\n<html>\n```\ninner\n```\n</html>\n```'
    // 贪婪匹配最外层，内部保留
    expect(stripCodeFence(text)).toContain('inner')
  })
})

describe('纯代码产物落盘（.html 自动剥离包裹）', () => {
  it('R6 的 index.html 产物落盘时剥离 ```html 包裹', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-chain-'))
    try {
      const wrapped = '```html\n<!DOCTYPE html>\n<html><body><h1>井字棋</h1></body></html>\n```'
      const { ctx } = fakeCtx([{ output: wrapped }])
      const steps = [makeStep('R6-developer', 'index.html', '开发实现')]
      await runChain(ctx, parent, steps, '做一个井字棋', root)
      const content = readFileSync(join(root, 'R6-developer', 'index.html'), 'utf8')
      expect(content.startsWith('<!DOCTYPE html>')).toBe(true)
      expect(content).not.toContain('```')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('Markdown 产物（.md）不做剥离', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-chain-'))
    try {
      const { ctx } = fakeCtx([{ output: '```md\n# 标题\n```' }])
      const steps = [makeStep('R1-requirement', 'prd.md', '需求分析')]
      await runChain(ctx, parent, steps, '任务', root)
      const content = readFileSync(join(root, 'R1-requirement', 'prd.md'), 'utf8')
      expect(content).toContain('```md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('可观测性与中止（chain.log + STOP）', () => {
  it('chain.log 记录链开始/阶段开始/阶段完成/链结束', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-chain-'))
    try {
      const { ctx } = fakeCtx([{ output: 'PRD 内容' }, { output: '架构内容' }])
      const steps = [
        makeStep('R1-requirement', 'prd.md', '需求分析'),
        makeStep('R2-architect', 'arch.md', '架构设计'),
      ]
      await runChain(ctx, parent, steps, '任务', root)
      const log = readFileSync(join(root, 'chain.log'), 'utf8')
      expect(log).toContain('链开始')
      expect(log).toContain('阶段开始：需求分析')
      expect(log).toContain('阶段完成：需求分析')
      expect(log).toContain('阶段完成：架构设计')
      expect(log).toContain('链结束')
      // 含耗时字段
      expect(log).toContain('elapsed_s')
      // 含产物路径
      expect(log).toContain('prd.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('STOP 标志在阶段边界中止链（不执行任何阶段）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-chain-'))
    try {
      writeFileSync(join(root, 'STOP'), '', 'utf8')
      const { ctx, calls } = fakeCtx([{ output: 'x' }])
      const steps = [makeStep('R1-requirement', 'prd.md', '需求分析')]
      const result = await runChain(ctx, parent, steps, '任务', root)
      expect(result.stopped).toBe(true)
      expect(calls).toHaveLength(0)
      const log = readFileSync(join(root, 'chain.log'), 'utf8')
      expect(log).toContain('检测到 STOP 标志')
      expect(log).toContain('链已中止')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('无 STOP 标志时正常跑完（stopped=false）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-chain-'))
    try {
      const { ctx } = fakeCtx([{ output: 'PRD' }])
      const steps = [makeStep('R1-requirement', 'prd.md', '需求分析')]
      const result = await runChain(ctx, parent, steps, '任务', root)
      expect(result.stopped).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('chainLogPath / stopFlagPath 路径正确', () => {
    expect(chainLogPath('C:/x')).toMatch(/chain\.log$/)
    expect(stopFlagPath('C:/x')).toMatch(/STOP$/)
  })
})

describe('resultToText', () => {
  it('提取 text 块并过滤空内容', () => {
    const text = resultToText({
      output: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '' },
        { type: 'text', text: '第二段' },
      ],
      stopReason: 'completed',
    })
    expect(text).toBe('第一段\n第二段')
  })

  it('无文本块返回空串', () => {
    const text = resultToText({ output: [], stopReason: 'completed' })
    expect(text).toBe('')
  })
})
