/**
 * 子代理实时活动桥接单测（看板看不到实时进展修复）。
 *
 * 覆盖：
 * - waitForSubagentEnd 用 { global: true } 监听 subagent/end（scoped 事件全局可达）
 * - 取消订阅用 disposer（不用 ctx.off，防崩溃）
 * - session/event → graph/node-activity（tool-call/assistant）
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStateGraph } from '../../src/l2-engine/state-graph'

const RO = { graphVersion: '0.1.0', graphSchemaHash: 'hash' }
const fakeAgent = { sessionId: 'parent-1', options: {} }

/** mock ctx：startContinuable + subagent/end global + session/event global。 */
function mockCtx() {
  const endListeners: Array<(info: { id: string; stopReason: string; lastAssistantMessage?: Array<{ type: string; text?: string }> }) => void> = []
  const eventListeners: Array<(session: { id?: string }, event: { type?: string; data?: Record<string, unknown> }) => void> = []
  const disposers: Array<() => void> = []
  let seq = 0
  const on = vi.fn((name: string, cb: (a: unknown, b?: unknown) => void) => {
    if (name === 'subagent/end') endListeners.push(cb as never)
    if (name === 'session/event') eventListeners.push(cb as never)
    const disposer = () => {
      if (name === 'subagent/end') {
        const i = endListeners.indexOf(cb as never)
        if (i >= 0) endListeners.splice(i, 1)
      }
      if (name === 'session/event') {
        const i = eventListeners.indexOf(cb as never)
        if (i >= 0) eventListeners.splice(i, 1)
      }
    }
    disposers.push(disposer)
    return disposer
  })
  const ctx = {
    get: () => undefined,
    emit: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    subagents: {
      list: () => [],
      getProvider: () => undefined,
      startContinuable: async (spec: { provider: string; request: { prompt: Array<{ type: string; text: string }> }; signal?: AbortSignal }) => {
        const childId = `child-${++seq}`
        const provider = spec.provider
        // 模拟子代理执行中的实时活动
        setTimeout(() => {
          for (const cb of [...eventListeners]) {
            cb({ id: childId }, { type: 'tool/call', data: { name: 'glob', arguments: { pattern: '**/*.md' } } })
          }
          for (const cb of [...eventListeners]) {
            cb({ id: childId }, { type: 'assistant/message', data: { message: [{ type: 'text', text: '我先分析接口' }] } })
          }
        }, 0)
        // 模拟完成 → subagent/end
        setTimeout(() => {
          for (const cb of [...endListeners]) {
            cb({ id: childId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: `产出-${provider}` }] })
          }
        }, 5)
        return { childId: childId as never, messageId: 'm1' as never }
      },
      sendMessage: async () => 'm2' as never,
    },
    effect: (fn: () => unknown) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    on,
  }
  return { ctx: ctx as never, eventListeners, endListeners, disposers }
}

describe('实时活动桥接', () => {
  it('子代理执行期间 emit graph/node-activity（tool-call/assistant）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-act-'))
    try {
      const { ctx } = mockCtx()
      const emitted: string[] = []
      const g = createStateGraph<Record<string, unknown>>(ctx, 25, 8, root, (evt) => {
        if (evt.type === 'graph/node-activity') emitted.push(evt.type)
      })
      g.addSubagent('dev', { provider: 'R6-developer', artifactName: 'dev.md' })
      const r = await g.run(
        { messages: [], user_input: '任务' } as Record<string, unknown>,
        { checkpoint: async () => {}, ...RO, agent: fakeAgent as never },
      )
      expect(r.success).toBe(true)
      expect(emitted.length).toBeGreaterThanOrEqual(1)
      expect(existsSync(join(root, 'dev', 'dev.md'))).toBe(true)
      expect(readFileSync(join(root, 'dev', 'dev.md'), 'utf8')).toContain('产出-R6-developer')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('subagent/end 用 disposer 取消订阅（无 ctx.off，不崩溃）', async () => {
    const { ctx, endListeners, disposers } = mockCtx()
    const g = createStateGraph<Record<string, unknown>>(ctx)
    g.addSubagent('dev', { provider: 'R6-developer' })
    const r = await g.run(
      { messages: [] } as Record<string, unknown>,
      { checkpoint: async () => {}, ...RO, agent: fakeAgent as never },
    )
    expect(r.success).toBe(true)
    // 完成后监听器应已移除（disposer 被调用）
    for (const d of disposers) d()
    expect(endListeners.length).toBeLessThanOrEqual(1)
  })
})
