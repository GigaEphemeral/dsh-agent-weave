/**
 * state-graph 事件桥接单测（MVP-4 P4.0.1 / P1-1 / P1-2）。
 *
 * 覆盖：
 * - eventSink 收到每个 graph/* 事件（P4.0.1）
 * - ledger 记录 node 级事件（P1-1）
 * - node-end 后 tokenCollector 按节点/角色分账（P1-2）
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createStateGraph } from '../../src/l2-engine/state-graph'
import { createRunLedger } from '../../src/l5-observability/run-ledger'
import { createTokenCollector } from '../../src/l5-observability/token-collector'

interface DemoState extends Record<string, unknown> {
  messages: string[]
  retry_count: number
}

describe('P4.0.1 eventSink + P1-1 ledger + P1-2 tokenCollector', () => {
  it('eventSink 收到每个 graph/* 事件', async () => {
    const ctx = new Context()
    const sink = vi.fn()
    const g = createStateGraph<DemoState>(ctx, 25, 8, undefined, sink)
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addEdge('a', '__END__')
    await g.run(
      { messages: [], retry_count: 0 },
      { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' },
    )
    const types = sink.mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types).toContain('graph/start')
    expect(types).toContain('graph/node-start')
    expect(types).toContain('graph/node-end')
    expect(types).toContain('graph/end')
  })

  it('ledger 记录 node 级事件（只追加、不可变）', async () => {
    const ctx = new Context()
    const ledger = createRunLedger()
    const g = createStateGraph<DemoState>(ctx, 25, 8, undefined, undefined, ledger)
    g.addNode('dev', async (s, nodeCtx) => {
      nodeCtx.reportTokenUsage?.({ input: 100, output: 50 })
      return { messages: ['dev'] }
    })
    g.addEdge('dev', '__END__')
    await g.run(
      { messages: [], retry_count: 0 },
      { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' },
    )
    const events = ledger.events()
    // node-start + node-end（node 级事件进 ledger）
    const types = events.map((e) => e.type)
    expect(types).toContain('graph/node-start')
    expect(types).toContain('graph/node-end')
    const before = ledger.events().length
    expect(ledger.append({ type: 'graph/node-end', graphId: 'x', node: 'n', timestamp: 1 })).toBe(before)
    expect(ledger.events().length).toBe(before + 1) // 只追加
  })

  it('node-end 后 tokenCollector 按节点/角色分账', async () => {
    const ctx = new Context()
    const tokens = createTokenCollector()
    const g = createStateGraph<DemoState>(ctx, 25, 8, undefined, undefined, undefined, tokens)
    g.addNode('dev', async (_s, nodeCtx) => {
      nodeCtx.reportTokenUsage?.({ input: 100, output: 50, cacheRead: 20 })
      return { messages: ['dev'] }
    }, { role: 'R6-developer' })
    g.addEdge('dev', '__END__')
    await g.run(
      { messages: [], retry_count: 0 },
      { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' },
    )
    const row = tokens.byNode('dev')
    expect(row?.role).toBe('R6-developer')
    expect(row?.usage.inputTokens).toBe(100)
    expect(row?.usage.outputTokens).toBe(50)
    expect(row?.usage.cacheReadTokens).toBe(20)
    expect(row?.usage.totalTokens).toBe(170) // 含 cacheRead
    expect(tokens.byRole('R6-developer').totalTokens).toBe(170)
    expect(tokens.total().totalTokens).toBe(170)
  })
})
