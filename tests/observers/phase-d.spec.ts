/**
 * MVP-3 Phase D 验证：观察者 L2 / 审批分级 / 生命周期（复用 phase0 的 lifecycle）。
 * 零 LLM。
 */
import { describe, expect, it } from 'vitest'
import { createL2Observer } from '../../src/observers/observer-l2'
import { createApprovalPolicy, APPROVAL_TIMEOUTS } from '../../src/l2-engine/approval-policy'

describe('P3.D.1 观察者 L2', () => {
  it('关键词命中 → yellow 信号', () => {
    const l2 = createL2Observer()
    const r = l2.observe('a.py', 'TODO: fix later\nprint(1)', { concernKeywords: ['TODO'], maxKb: 100 })
    expect(r.level).toBe('yellow')
    expect(r.signaled).toBe(true)
    expect(r.findings[0]).toContain('TODO')
  })

  it('大小超限 → yellow；干净内容 → green', () => {
    const l2 = createL2Observer()
    const big = 'x'.repeat(200 * 1024)
    expect(l2.observe('b.md', big, { maxKb: 100 }).level).toBe('yellow')
    expect(l2.observe('c.md', 'clean', { concernKeywords: ['TODO'], maxKb: 100 }).level).toBe('green')
  })

  it('toSignal 构造完整信号（yellow → internal-log）', () => {
    const l2 = createL2Observer()
    const r = l2.observe('a.py', 'FIXME x', { concernKeywords: ['FIXME'] })
    const sig = l2.toSignal({ observerId: 'obs-1', observedNode: 'dev', result: r, summary: '有遗留标记' })
    expect(sig.signal_level).toBe('yellow')
    expect(sig.action).toBe('internal-log')
    expect(sig.token_used).toBe(0)
  })
})

describe('P3.D.2 人工审批分级', () => {
  const allowedPolicy = createApprovalPolicy({ decide: async () => ({ allowed: true }) })
  const deniedPolicy = createApprovalPolicy({ decide: async () => ({ allowed: false }) })

  it('L1 超时自动继续（timeout-auto-continue）', async () => {
    const r = await deniedPolicy.gate({ level: 'L1', reason: '质量不达标', nodeId: 'qa' }, { timeoutCheck: () => true })
    expect(r.outcome).toBe('timeout-auto-continue')
  })

  it('L2 超时升级 L3', async () => {
    const r = await deniedPolicy.gate({ level: 'L2', reason: 'retry 达上限', nodeId: 'dev' }, { timeoutCheck: () => true })
    expect(r.outcome).toBe('timeout-escalate')
    expect(r.escalatedTo).toBe('L3')
  })

  it('通过 → allowed；L3 未超时拒绝', async () => {
    expect((await allowedPolicy.gate({ level: 'L1', reason: 'ok', nodeId: 'x' })).outcome).toBe('allowed')
    const r = await deniedPolicy.gate({ level: 'L3', reason: '安全违规', nodeId: 'x' }, { timeoutCheck: () => true })
    expect(r.outcome).toBe('rejected') // L3 无超时
  })

  it('超时配置：L1=10min L2=30min', () => {
    expect(APPROVAL_TIMEOUTS.L1).toBe(10 * 60 * 1000)
    expect(APPROVAL_TIMEOUTS.L2).toBe(30 * 60 * 1000)
  })
})
