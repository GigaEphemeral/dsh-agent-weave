/**
 * P3.A.2 生命周期管理验证（MVP-3 Phase A）。
 * 纯函数零 LLM：三模式决策 + prewarm + 活跃窗口。
 */
import { describe, expect, it } from 'vitest'
import { createLifecycleManager, shouldPrewarm, isInActiveWindow, DEFAULT_LIFECYCLE } from '../../src/l3-roles/lifecycle-manager'

describe('P3.A.2 生命周期管理', () => {
  it('on-demand 不预热', () => {
    expect(shouldPrewarm('R6', { mode: 'on-demand' })).toBe(false)
  })

  it('resident + prewarm 列表预热', () => {
    expect(shouldPrewarm('R6', { mode: 'resident', prewarmRoles: ['R6'] })).toBe(true)
    expect(shouldPrewarm('R1', { mode: 'resident', prewarmRoles: ['R6'] })).toBe(false)
  })

  it('hybrid 活跃窗口判断', () => {
    const now = 100_000
    expect(isInActiveWindow(now - 1000, now, { mode: 'hybrid', activeWindowMs: 60_000 })).toBe(true)
    expect(isInActiveWindow(now - 120_000, now, { mode: 'hybrid', activeWindowMs: 60_000 })).toBe(false)
    expect(isInActiveWindow(undefined, now, { mode: 'hybrid' })).toBe(false)
    expect(isInActiveWindow(0, now, { mode: 'resident' })).toBe(true)
    expect(isInActiveWindow(0, now, { mode: 'on-demand' })).toBe(false)
  })

  it('管理器 touch/isResident 联动', () => {
    const mgr = createLifecycleManager({ mode: 'hybrid', activeWindowMs: 1000 })
    const now = Date.now()
    expect(mgr.isResident('R6', now)).toBe(false)
    mgr.touch('R6', now - 500)
    expect(mgr.isResident('R6', now)).toBe(true)
    expect(mgr.isResident('R6', now + 2000)).toBe(false)
    expect(mgr.shouldPrewarm('R6')).toBe(false)
  })

  it('默认配置 on-demand', () => {
    expect(DEFAULT_LIFECYCLE.mode).toBe('on-demand')
  })
})
