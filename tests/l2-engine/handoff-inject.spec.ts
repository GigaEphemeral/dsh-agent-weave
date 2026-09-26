/**
 * MVP-5B B2：引擎接入层验证（handoff 注入 + handoff.json 落盘 + 恢复扫描）。
 *
 * 验收 10.2（运行时，mock 图）：
 *  1. 跑 3 节点图 → productions/<节点>/handoff.json 出现 3 个
 *  2. 节点 B 的 prompt 含"【上游交接单】"和节点 A 的 artifacts
 *  3. 节点 C 的 prompt 含 A+B 累积的 verified 事实
 *  4. scanHandoffEnvelopes 恢复扫描（按 at 升序）
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStateGraph } from '../../src/l2-engine/state-graph'
import { ProjectMemory } from '../../src/l2-engine/project-memory'
import { readHandoffJson, scanHandoffEnvelopes, writeHandoffJson } from '../../src/l2-engine/handoff'

const RO = { graphVersion: '0.1.0', graphSchemaHash: 'hash' }
const fakeAgent = { sessionId: 'parent-1', options: {} }

/** mock ctx.subagents（零 LLM）：按 provider 返回固定产物文本（含 front-matter）。 */
function mockCtx(outputByProvider: Record<string, string>) {
  const calls: Array<{ provider: string; prompt: string }> = []
  const endListeners: Array<(info: { id: string; stopReason: string; lastAssistantMessage?: Array<{ type: string; text?: string }> }) => void> = []
  const on = vi.fn((name: string, cb: (info: unknown) => void) => {
    if (name === 'subagent/end') endListeners.push(cb as never)
    return () => {}
  })
  const off = vi.fn((name: string, cb: (info: unknown) => void) => {
    if (name === 'subagent/end') {
      const i = endListeners.indexOf(cb as never)
      if (i >= 0) endListeners.splice(i, 1)
    }
  })
  const ctx = {
    get: () => undefined,
    emit: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    subagents: {
      list: () => [],
      getProvider: () => undefined,
      startContinuable: async (spec: { provider: string; request: { prompt: Array<{ type: string; text: string }>; parent?: unknown }; signal?: AbortSignal }) => {
        const provider = spec.provider
        const prompt = spec.request.prompt[0]?.text ?? ''
        calls.push({ provider, prompt })
        const childId = `child-${calls.length}`
        setTimeout(() => {
          for (const cb of [...endListeners]) {
            cb({ id: childId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: outputByProvider[provider] ?? `产出-${provider}` }] })
          }
        }, 0)
        return { childId: childId as never, messageId: 'm1' as never }
      },
      sendMessage: async () => 'm2' as never,
    },
    effect: (fn: () => unknown) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on,
    off,
  }
  return { ctx: ctx as never, calls }
}

describe('B2：handoff 引擎注入', () => {
  it('3 节点图 → 3 个 handoff.json；下游 prompt 含上游交接单与累积事实（验收 10.2#1/#2/#3）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-hi-'))
    try {
      const outputByProvider = {
        'R1-requirement': `---
environment:
  verified:
    - key: env.python.version
      value: "3.14.6"
      cmd: "python --version"
facts:
  - key: env.python.version
    category: environment
    value: "3.14.6"
    summary: "Python 3.14.6 已安装"
---
# 需求文档（A）`,
        'R2-architect': `---
environment:
  verified:
    - key: env.node.version
      value: "22.23"
      cmd: "node --version"
---
# 架构文档（B）`,
        'R4-designer': `---
# 设计文档（C）
`,
      }
      const { ctx, calls } = mockCtx(outputByProvider)
      const g = createStateGraph<Record<string, unknown>>(
        ctx, 25, 8, root, undefined, undefined, undefined, undefined,
        new ProjectMemory({ artifactsRoot: root }), // MVP-5B B2：交接单共享
      )
      g.addSubagent('node-a', { provider: 'R1-requirement', artifactName: 'a.md' })
      g.addSubagent('node-b', { provider: 'R2-architect', artifactName: 'b.md' })
      g.addSubagent('node-c', { provider: 'R4-designer', artifactName: 'c.md' })
      g.addEdge('node-a', 'node-b')
      g.addEdge('node-b', 'node-c')

      const r = await g.run(
        { messages: [], user_input: '任务' } as Record<string, unknown>,
        { checkpoint: async () => {}, ...RO, agent: fakeAgent as never },
      )
      expect(r.success).toBe(true)

      // 验收 10.2#1：productions/<节点>/handoff.json 出现 3 个
      expect(existsSync(join(root, 'node-a', 'handoff.json'))).toBe(true)
      expect(existsSync(join(root, 'node-b', 'handoff.json'))).toBe(true)
      expect(existsSync(join(root, 'node-c', 'handoff.json'))).toBe(true)

      // handoff.json 结构合法（nodeId/artifacts 自引用补全）
      const envA = readHandoffJson(join(root, 'node-a'))
      expect(envA?.nodeId).toBe('node-a')
      expect(envA?.roleRef).toBe('R1-requirement')
      expect(envA?.artifacts.some((a) => a.path.endsWith('a.md') && a.hash !== '')).toBe(true)
      expect(envA?.environment.verified[0]?.key).toBe('env.python.version')

      // 验收 10.2#2：节点 B 的 prompt 含【上游交接单】+ 节点 A 的 artifacts
      const promptB = calls.find((c) => c.provider === 'R2-architect')?.prompt ?? ''
      expect(promptB).toContain('【上游交接单】')
      expect(promptB).toContain('你必须读取的产物')
      expect(promptB).toContain('node-a/a.md')
      expect(promptB).toContain('已确认的事实（禁止重复探测）')
      expect(promptB).toContain('env.python.version = 3.14.6')

      // 验收 10.2#3：节点 C 的 prompt 含 A+B 累积的 verified 事实
      const promptC = calls.find((c) => c.provider === 'R4-designer')?.prompt ?? ''
      expect(promptC).toContain('env.python.version = 3.14.6')
      expect(promptC).toContain('env.node.version = 22.23')

      // 目录下恰好 3 个节点目录（无 graph-artifacts 中间层；traces/ 为引擎轨迹目录，忽略）
      const nodeDirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== 'traces')
        .map((d) => d.name)
      expect(nodeDirs.sort()).toEqual(['node-a', 'node-b', 'node-c'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('scanHandoffEnvelopes 恢复扫描：按 at 升序返回（B2 恢复场景）', () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-scan-'))
    try {
      // 手写三份 handoff.json（时间倒序写入目录，验证排序）
      const base = {
        schemaVersion: '1.0',
        graphId: 'g-1',
        nodeId: '',
        roleRef: 'R1',
        at: 0,
        artifacts: [],
        facts: [],
        environment: { verified: [], unmet: [] },
        openIssues: [],
        handoff: { upstream: [], downstream: [], completed: false },
      }
      writeHandoffJson(join(root, 'node-b'), { ...base, nodeId: 'node-b', at: 200 })
      writeHandoffJson(join(root, 'node-a'), { ...base, nodeId: 'node-a', at: 100 })
      writeHandoffJson(join(root, 'node-c'), { ...base, nodeId: 'node-c', at: 300 })

      const scanned = scanHandoffEnvelopes(root)
      expect(scanned.map((s) => s.nodeId)).toEqual(['node-a', 'node-b', 'node-c'])
      expect(scanned[0]?.envelope.at).toBe(100)
      expect(scanHandoffEnvelopes(join(root, 'no-such'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
