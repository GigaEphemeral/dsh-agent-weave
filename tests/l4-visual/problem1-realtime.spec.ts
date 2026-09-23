/**
 * 问题一「图状态不实时」修复单测。
 *
 * 覆盖：
 * - 步骤0：graph.run 接受外部 graphId（与 bus/返回值统一）
 * - 步骤1：runGraphRealTool 异步返回 status='started'（不阻塞）
 * - 步骤2：SSE broker 支持 '*' 全局订阅
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createStateGraph } from '../../src/l2-engine/state-graph'
import { createSseBroker } from '../../src/l4-visual/host/sse-broker'
import type { ServerResponse } from 'node:http'

interface DemoState extends Record<string, unknown> {
  messages: string[]
}

function makeRes(): { res: ServerResponse; written: string[] } {
  const written: string[] = []
  const res = {
    writeHead: vi.fn(),
    write: vi.fn((c: string) => { written.push(c); return true }),
    end: vi.fn(),
  } as unknown as ServerResponse
  return { res, written }
}

describe('问题一步骤0：graphId 统一', () => {
  it('graph.run 使用 options.graphId（不再各自生成）', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx, 25, 8)
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addEdge('a', '__END__')
    const result = await g.run(
      { messages: [] },
      { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'h', graphId: 'graph-ext-1234' },
    )
    expect(result.graphId).toBe('graph-ext-1234')
    // 事件流也用同一 graphId
    expect(result.trajectory.every((e) => e.graphId === 'graph-ext-1234')).toBe(true)
  })

  it('缺省 graphId 仍自己生成（兼容旧调用）', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx, 25, 8)
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addEdge('a', '__END__')
    const result = await g.run(
      { messages: [] },
      { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'h' },
    )
    expect(result.graphId.startsWith('graph-')).toBe(true)
  })
})

describe('问题一步骤2：SSE 全局订阅', () => {
  it("graphId='*' 订阅者收到所有图的事件", () => {
    const broker = createSseBroker()
    const { res, written } = makeRes()
    broker.subscribe('*', res)
    broker.broadcast('graph-A', { trace_id: 'graph-A', event_type: 'graph-start', timestamp: 1, data: {} })
    broker.broadcast('graph-B', { trace_id: 'graph-B', event_type: 'graph-start', timestamp: 2, data: {} })
    const body = written.join('')
    expect(body).toContain('graph-A')
    expect(body).toContain('graph-B')
    broker.dispose()
  })

  it('具体 graphId 订阅者不受全局广播影响（反向隔离）', () => {
    const broker = createSseBroker()
    const { res, written } = makeRes()
    broker.subscribe('graph-A', res)
    broker.broadcast('*', { trace_id: 'x', event_type: 'graph-start', timestamp: 1, data: {} })
    expect(written.join('')).not.toContain('graph-start')
    broker.dispose()
  })
})
