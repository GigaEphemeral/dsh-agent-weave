/**
 * loop-detector.ts 单测（MVP-2 T14 Exit Gate：3 类告警）。
 *
 * 覆盖：边级循环告警（80%）/ 全局迭代告警（80%）/ 熔断告警（100%）。
 */
import { describe, expect, it } from 'vitest'
import { createLoopDetector } from '../../src/l4-visual/host/loop-detector'
import { createEventBus, type ExecutionSnapshot } from '../../src/l4-visual/host/event-bus'
import type { TrajectoryEvent } from '../../src/l2-engine/types'

function snap(overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    graphId: 'g',
    current: 'dev',
    currentRole: '',
    iteration: 0,
    maxIterations: 25,
    retryCount: 0,
    maxRetry: 3,
    startedAt: Date.now(),
    elapsedMs: 0,
    tokenUsed: 0,
    status: 'running',
    trajectory: [],
    nodeStates: {},
    ...overrides,
  }
}

function ev(type: TrajectoryEvent['type']): TrajectoryEvent {
  return { type, graphId: 'g', timestamp: Date.now() }
}

describe('T14 死循环/停滞告警', () => {
  it('全局迭代 80% 触发 warn 告警', () => {
    const d = createLoopDetector()
    const alerts = d.check(snap({ iteration: 20, maxIterations: 25 }))
    expect(alerts.some((a) => a.level === 'warn' && a.kind === 'global-iteration')).toBe(true)
  })

  it('全局熔断（100%）触发 critical', () => {
    const d = createLoopDetector()
    const alerts = d.check(snap({ iteration: 25, maxIterations: 25 }))
    expect(alerts.some((a) => a.level === 'critical' && a.kind === 'circuit-break')).toBe(true)
  })

  it('边级循环 80% 触发 warn（retry 达 maxRetry 80%）', () => {
    const d = createLoopDetector()
    // maxRetry=3 → 80% = 2.4 → retryCount=3? 不，3 已熔断；2 未达 80%。
    // 用 maxRetry=5 → 80% = 4
    const alerts = d.check(snap({ retryCount: 4, maxRetry: 5 }))
    expect(alerts.some((a) => a.level === 'warn' && a.kind === 'edge-loop')).toBe(true)
  })

  it('订阅总线自动告警 + getAlerts 累积', () => {
    const bus = createEventBus()
    const d = createLoopDetector()
    const received: string[] = []
    d.start(bus, (a) => received.push(a.message))
    // 模拟 25 次迭代
    bus.handle(ev('graph/start'))
    for (let i = 1; i <= 25; i++) {
      bus.handle({ type: 'graph/loop-iteration', graphId: 'g', node: 'dev', timestamp: Date.now(), data: { iteration: i } })
    }
    expect(d.getAlerts().length).toBeGreaterThan(0)
    expect(received.length).toBeGreaterThan(0)
  })
})
