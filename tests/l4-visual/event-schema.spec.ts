/**
 * 事件契约单测（MVP-4 P4.A.5）。
 *
 * 覆盖：TrajectoryEvent → WsEvent 字段完整 / schema 解析通过 / OTEL 用法字段映射。
 */
import { describe, expect, it } from 'vitest'
import { WsEventSchema, trajectoryToWsEvent } from '../../src/l4-visual/shared/event-schema'
import type { TrajectoryEvent } from '../../src/l2-engine/types'

describe('P4.A.5 事件契约', () => {
  it('TrajectoryEvent → WsEvent 字段完整', () => {
    const evt: TrajectoryEvent = {
      type: 'graph/node-end',
      graphId: 'g1',
      node: 'develop',
      timestamp: 1000,
      durationMs: 500,
      data: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 },
    }
    const ws = trajectoryToWsEvent(evt, { develop: 'R6-developer' })
    expect(ws.trace_id).toBe('g1')
    expect(ws.span_id).toBe('develop')
    expect(ws['gen_ai.agent.name']).toBe('R6-developer')
    expect(ws['gen_ai.operation.name']).toBe('node_end')
    expect(ws['gen_ai.usage.input_tokens']).toBe(100)
    expect(ws['gen_ai.usage.output_tokens']).toBe(50)
    expect(ws['gen_ai.usage.cache_read_tokens']).toBe(20)
    expect(ws.event_type).toBe('node-end')
    expect(() => WsEventSchema.parse(ws)).not.toThrow()
  })

  it('node-start 映射 node_start 操作', () => {
    const evt: TrajectoryEvent = {
      type: 'graph/node-start',
      graphId: 'g1',
      node: 'a',
      timestamp: 10,
      data: { role: 'R1' },
    }
    const ws = trajectoryToWsEvent(evt, {})
    expect(ws['gen_ai.operation.name']).toBe('node_start')
    expect(ws.event_type).toBe('node-start')
    expect(() => WsEventSchema.parse(ws)).not.toThrow()
  })

  it('无 role 映射时省略 agent.name 与 usage', () => {
    const evt: TrajectoryEvent = {
      type: 'graph/start',
      graphId: 'g1',
      timestamp: 5,
    }
    const ws = trajectoryToWsEvent(evt, {})
    expect(ws['gen_ai.agent.name']).toBeUndefined()
    expect(ws['gen_ai.usage.input_tokens']).toBeUndefined()
    expect(() => WsEventSchema.parse(ws)).not.toThrow()
  })
})
