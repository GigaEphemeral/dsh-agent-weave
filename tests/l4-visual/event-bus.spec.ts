/**
 * event-bus.ts 单测（MVP-2 T11 Exit Gate：4 用例全绿）。
 *
 * 覆盖：订阅收到事件 / 快照状态完整 / reset 清空 / 8 种事件可处理。
 */
import { describe, expect, it, vi } from 'vitest'
import { createEventBus } from '../../src/l4-visual/host/event-bus'
import type { TrajectoryEvent } from '../../src/l2-engine/types'

function ev(type: TrajectoryEvent['type'], overrides: Partial<TrajectoryEvent> = {}): TrajectoryEvent {
  return { type, graphId: 'graph-1', timestamp: Date.now(), ...overrides }
}

describe('T11 事件流总线', () => {
  it('subscribe 收到事件，注销后不再收到', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    const unsubscribe = bus.subscribe(handler)
    bus.handle(ev('graph/start'))
    expect(handler).toHaveBeenCalledTimes(1)
    unsubscribe()
    bus.handle(ev('graph/node-start', { node: 'a' }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('getSnapshot 返回完整状态（节点状态/轨迹/迭代）', () => {
    const bus = createEventBus({ maxIterations: 25, maxRetry: 3 })
    bus.handle(ev('graph/start'))
    bus.handle(ev('graph/node-start', { node: 'dev' }))
    bus.handle(ev('graph/node-end', { node: 'dev', data: { tokenUsed: 100, retryCount: 1 } }))
    bus.handle(ev('graph/loop-iteration', { node: 'dev', data: { iteration: 2, retryCount: 1 } }))
    bus.handle(ev('graph/end'))

    const snap = bus.getSnapshot()
    expect(snap.graphId).toBe('graph-1')
    expect(snap.status).toBe('completed')
    expect(snap.nodeStates.dev).toBe('completed')
    expect(snap.trajectory).toHaveLength(5)
    expect(snap.tokenUsed).toBe(100)
    expect(snap.retryCount).toBe(1)
    expect(snap.iteration).toBe(2)
    expect(snap.maxIterations).toBe(25)
  })

  it('reset 清空状态', () => {
    const bus = createEventBus()
    bus.handle(ev('graph/start'))
    bus.handle(ev('graph/node-end', { node: 'a' }))
    bus.reset()
    const snap = bus.getSnapshot()
    expect(snap.graphId).toBe('')
    expect(snap.trajectory).toHaveLength(0)
    expect(Object.keys(snap.nodeStates)).toHaveLength(0)
  })

  it('8 种事件类型全部可处理且不抛错', () => {
    const bus = createEventBus()
    const types: TrajectoryEvent['type'][] = [
      'graph/start',
      'graph/node-start',
      'graph/node-end',
      'graph/node-error',
      'graph/error',
      'graph/end',
      'graph/checkpoint-written',
      'graph/loop-iteration',
    ]
    for (const t of types) {
      expect(() => bus.handle(ev(t, { node: t.includes('node') ? 'a' : undefined }))).not.toThrow()
    }
    expect(bus.getSnapshot().trajectory).toHaveLength(8)
  })
})
