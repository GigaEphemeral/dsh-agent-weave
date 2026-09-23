/**
 * shared-bus.ts 单测（MVP-4 P4.0.1 / P4.0.16 单图模式）。
 *
 * 覆盖：同一 graphId 复用同一 bus / 不同 graphId 重建 / 快照可读 / reset 清空。
 */
import { describe, expect, it } from 'vitest'
import { setGlobalBus, getGlobalBus, getGlobalSnapshot, resetGlobalBus } from '../../src/l4-visual/host/shared-bus'

describe('P4.0.1 共享总线', () => {
  it('同一 graphId 返回同一 bus 实例', () => {
    const a = setGlobalBus('graph-x')
    const b = setGlobalBus('graph-x')
    expect(a).toBe(b)
    expect(getGlobalBus()).toBe(a)
  })

  it('不同 graphId 重建 bus（单图模式：只维护一个活跃 bus）', () => {
    const a = setGlobalBus('graph-1')
    const b = setGlobalBus('graph-2')
    expect(b).not.toBe(a)
    expect(getGlobalBus()).toBe(b)
  })

  it('getGlobalSnapshot 反映最新事件', () => {
    setGlobalBus('graph-snap')
    const bus = getGlobalBus()
    expect(bus).not.toBeNull()
    bus?.handle({ type: 'graph/start', graphId: 'graph-snap', timestamp: Date.now() })
    bus?.handle({ type: 'graph/node-start', graphId: 'graph-snap', node: 'dev', timestamp: Date.now() })
    const snap = getGlobalSnapshot()
    expect(snap?.graphId).toBe('graph-snap')
    expect(snap?.nodeStates.dev).toBe('running')
  })

  it('resetGlobalBus 清空活跃 bus', () => {
    setGlobalBus('graph-r')
    resetGlobalBus()
    expect(getGlobalBus()).toBeNull()
    expect(getGlobalSnapshot()).toBeNull()
  })
})
