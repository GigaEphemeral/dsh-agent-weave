/**
 * P3.A.1 + 问题三 addSubagent 验证（MVP-4 最小版：startContinuable + subagent/end 事件）。
 *
 * mock ctx.subagents（零 LLM）验证：
 * - addSubagent 注册真实子代理节点
 * - startContinuable 收到 provider + prompt（含 user_input/upstream）
 * - 子代理 childId 持久化（同一节点复用）
 * - 产物落盘 artifactsRoot/graph-artifacts/<node>/<artifact>
 * - 输出经 subagent/end 事件映射回 State（messages/artifacts）
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStateGraph } from '../../src/l2-engine/state-graph'

const RO = { graphVersion: '0.1.0', graphSchemaHash: 'hash' }
const fakeAgent = { sessionId: 'parent-1', options: {} }

/** mock ctx：subagents.startContinuable 记录调用 + 支持触发 subagent/end。 */
function mockCtx() {
  const calls: Array<{ provider: string; prompt: string; signal?: AbortSignal }> = []
  const endListeners: Array<(info: { id: string; stopReason: string; lastAssistantMessage?: Array<{ type: string; text?: string }> }) => void> = []
  const started: Array<{ provider: string; childId: string }> = []
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
      // 问题三最小版：startContinuable 建 durable child
      startContinuable: async (spec: { provider: string; request: { prompt: Array<{ type: string; text: string }>; parent?: unknown }; signal?: AbortSignal }) => {
        const provider = spec.provider
        const prompt = spec.request.prompt[0]?.text ?? ''
        calls.push({ provider, prompt, signal: spec.signal })
        const childId = `child-${calls.length}`
        started.push({ provider, childId })
        // 模拟子代理执行完成 → 异步触发 subagent/end
        setTimeout(() => {
          for (const cb of [...endListeners]) {
            cb({ id: childId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: `产出-${provider}` }] })
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
  return { ctx: ctx as never, calls, started }
}

describe('P3.A.1 + 问题三 addSubagent（continuable）', () => {
  it('role 节点 startContinuable 建 durable child 并落盘产物', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-sub-'))
    try {
      const { ctx, calls } = mockCtx()
      const g = createStateGraph<Record<string, unknown>>(ctx, 25, 8, root)
      g.addSubagent('dev', { provider: 'R6-developer', artifactName: 'main.ts', role: 'R6-developer' })
      const r = await g.run(
        { messages: [], user_input: '写个计算器' } as Record<string, unknown>,
        { checkpoint: async () => {}, ...RO, agent: fakeAgent as never },
      )
      expect(r.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.provider).toBe('R6-developer')
      expect(calls[0]?.prompt).toContain('写个计算器')
      // 产物落盘（经 subagent/end 事件输出）
      const file = join(root, 'graph-artifacts', 'dev', 'main.ts')
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8')).toContain('产出-R6-developer')
      // State 映射
      expect(r.finalState.artifacts).toEqual({ dev: file })
      expect(r.finalState.messages).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缺 agent 时报错（fail-fast）', async () => {
    const { ctx } = mockCtx()
    const g = createStateGraph<Record<string, unknown>>(ctx)
    g.addSubagent('dev', { provider: 'R6-developer' })
    const r = await g.run({ messages: [] } as Record<string, unknown>, { checkpoint: async () => {}, ...RO })
    expect(r.success).toBe(false)
    expect(r.error?.message).toContain('需要 RunOptions.agent')
  })

  it('上游产物摘要注入 prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-sub2-'))
    try {
      const { ctx, calls } = mockCtx()
      const g = createStateGraph<Record<string, unknown>>(ctx, 25, 8, root)
      g.addSubagent('req', { provider: 'R1-requirement', artifactName: 'prd.md' })
      g.addSubagent('dev', { provider: 'R6-developer', artifactName: 'main.ts' })
      g.addEdge('req', 'dev')
      const r = await g.run({ messages: [], user_input: '任务' } as Record<string, unknown>, {
        checkpoint: async () => {},
        ...RO,
        agent: fakeAgent as never,
      })
      expect(r.success).toBe(true)
      // dev 的 prompt 含 req 产物路径
      const devCall = calls.find((c) => c.provider === 'R6-developer')
      expect(devCall?.prompt).toContain('prd.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('P3.A.3：run 的 signal 贯通到 startContinuable', async () => {
    const { ctx, calls } = mockCtx()
    const g = createStateGraph<Record<string, unknown>>(ctx)
    g.addSubagent('dev', { provider: 'R6-developer' })
    const ctrl = new AbortController()
    const r = await g.run({ messages: [] } as Record<string, unknown>, {
      checkpoint: async () => {},
      ...RO,
      agent: fakeAgent as never,
      signal: ctrl.signal,
    })
    expect(r.success).toBe(true)
    expect(calls[0]?.signal).toBe(ctrl.signal) // 同一 signal 对象
  })
})
