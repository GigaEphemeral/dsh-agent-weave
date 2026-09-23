/**
 * approval-service 单测（MVP-4 P4.B.3）。
 *
 * 覆盖：create 广播 / list-pending / resolve 唤醒等待 / 超时自动拒绝。
 */
import { describe, expect, it, vi } from 'vitest'
import { createApprovalService } from '../../src/l4-visual/host/approval-service'
import type { SseBroker } from '../../src/l4-visual/host/sse-broker'

function makeBroker(): SseBroker {
  return {
    subscribe: vi.fn(() => 's1'),
    unsubscribe: vi.fn(),
    broadcast: vi.fn(),
    subscriberCount: vi.fn(() => 0),
    dispose: vi.fn(),
  }
}

describe('P4.B.3 审批闭环', () => {
  it('create 广播 approval-request 并列入待决', () => {
    const broker = makeBroker()
    const svc = createApprovalService(broker)
    const req = svc.create({ graphId: 'g1', nodeId: 'approve-1', level: 'L1', reason: '测试', timeoutMs: 60_000 })
    expect(req.id).toContain('approval-')
    expect(svc.pending('g1')).toHaveLength(1)
    expect(broker.broadcast).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ event_type: 'approval-request' }),
    )
  })

  it('resolve 唤醒等待方并广播 approval-decided', async () => {
    const broker = makeBroker()
    const svc = createApprovalService(broker)
    const req = svc.create({ graphId: 'g1', nodeId: 'n1', level: 'L2', reason: 'r', timeoutMs: 60_000 })
    const waiter = svc.waitFor(req.id)
    expect(svc.resolve(req.id, 'approved')).toBe(true)
    await expect(waiter).resolves.toBe('approved')
    expect(svc.pending('g1')).toHaveLength(0)
    const decided = broker.broadcast.mock.calls.find((c) => c[1]?.event_type === 'approval-decided')
    expect(decided).toBeDefined()
    // 重复决议无效
    expect(svc.resolve(req.id, 'rejected')).toBe(false)
  })

  it('超时自动拒绝并唤醒', async () => {
    const broker = makeBroker()
    const svc = createApprovalService(broker)
    const req = svc.create({ graphId: 'g1', nodeId: 'n1', level: 'L1', reason: 'r', timeoutMs: 30 })
    const waiter = svc.waitFor(req.id)
    await expect(waiter).resolves.toBe('timeout')
    expect(req.resolved?.decision).toBe('rejected')
  })
})
