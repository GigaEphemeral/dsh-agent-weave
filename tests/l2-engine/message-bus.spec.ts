/**
 * MVP-3 Phase B 验证：消息总线 / 等待唤醒 / 防死锁。
 * 零 LLM。
 */
import { describe, expect, it } from 'vitest'
import { createMessageBus, createRealSendImpl, genMessageId } from '../../src/l2-engine/message-bus'
import { createWaitFor, type MessageDelivery } from '../../src/l2-engine/wait-for'
import { createDeadlockGuard, MAX_TRIGGER_PER_LINK } from '../../src/l2-engine/deadlock-guard'

const makeMsg = (over: Partial<MessageDelivery> = {}): MessageDelivery => ({
  id: genMessageId(),
  correlation_id: 'c1',
  from: 'A',
  to: 'B',
  type: 'query',
  payload: { summary: 'hi' },
  ...over,
})

describe('P3.B.1 消息总线', () => {
  it('createMessage 自动生成 id/correlation_id/deadline', () => {
    const bus = createMessageBus()
    const m = bus.createMessage({ from: 'A', to: 'B', type: 'handoff', payload: { summary: 'x' }, priority: 'normal' })
    expect(m.id).toMatch(/^msg-/)
    expect(m.correlation_id).toBeTruthy()
    expect(m.deadline).toBeGreaterThan(Date.now())
    expect(bus.isExpired(m, Date.now() + 120_000)).toBe(true)
  })

  it('send 走 sendImpl；过期拒绝', async () => {
    const sent: string[] = []
    const bus = createMessageBus({ sendImpl: async (to) => { sent.push(to); return `mid-${to}` } })
    const m = bus.createMessage({ from: 'A', to: 'B', type: 'query', payload: { summary: 'x' }, priority: 'normal' })
    const id = await bus.send(m)
    expect(id).toBe('mid-B')
    expect(sent).toEqual(['B'])
    // 过期
    const expired = { ...m, deadline: Date.now() - 1000 }
    await expect(bus.send(expired)).rejects.toThrow(/已过期/)
  })

  it('createRealSendImpl 包装 sendMessage（父中转）', async () => {
    let captured: unknown
    const ctx = {
      subagents: {
        sendMessage: async (sender: unknown, target: string, content: Array<{ type: 'text'; text: string }>) => {
          captured = { sender, target, content }
          return 'mid'
        },
      },
    }
    const sendImpl = createRealSendImpl(ctx, { sessionId: 'parent' })
    const bus = createMessageBus({ sendImpl })
    const m = bus.createMessage({ from: 'A', to: 'B', type: 'handoff', payload: { summary: 'x' }, priority: 'normal' })
    await bus.send(m)
    expect(captured).toMatchObject({ target: 'B' })
  })
})

describe('P3.B.2 等待唤醒', () => {
  it('wait 挂起，wakeUp 匹配唤醒（不用轮询）', async () => {
    const wf = createWaitFor<MessageDelivery>()
    const p = wf.wait((m) => m.correlation_id === 'c1')
    expect(wf.pendingCount()).toBe(1)
    wf.wakeUp(makeMsg({ correlation_id: 'c1' }))
    const got = await p
    expect(got.correlation_id).toBe('c1')
    expect(wf.pendingCount()).toBe(0)
  })

  it('不匹配不唤醒；多等待者各自匹配', async () => {
    const wf = createWaitFor<MessageDelivery>()
    const p1 = wf.wait((m) => m.correlation_id === 'c1')
    const p2 = wf.wait((m) => m.correlation_id === 'c2')
    wf.wakeUp(makeMsg({ correlation_id: 'c2' }))
    expect(await p2).toMatchObject({ correlation_id: 'c2' })
    expect(wf.pendingCount()).toBe(1)
    wf.wakeUp(makeMsg({ correlation_id: 'c1' }))
    expect(await p1).toMatchObject({ correlation_id: 'c1' })
    expect(wf.pendingCount()).toBe(0)
  })

  it('超时 reject', async () => {
    const wf = createWaitFor<MessageDelivery>()
    await expect(wf.wait(() => false, { timeoutMs: 10 })).rejects.toThrow(/超时/)
  })
})

describe('P3.B.3 防死锁', () => {
  it('同 Agent 同链路 ≥3 次强制终止', () => {
    const g = createDeadlockGuard()
    for (let i = 1; i < MAX_TRIGGER_PER_LINK; i++) {
      expect(g.onTrigger('A', 'L1')).toMatchObject({ kind: 'retry' })
    }
    const action = g.onTrigger('A', 'L1')
    expect(action.kind).toBe('terminate-link')
    expect(g.triggerCount('A', 'L1')).toBe(MAX_TRIGGER_PER_LINK)
  })

  it('工作流超时降级审批', () => {
    const g = createDeadlockGuard()
    expect(g.onWorkflowTimeout('wf1')).toMatchObject({ kind: 'escalate-approval' })
    expect(g.diagnostics().length).toBe(1)
  })

  it('消息超时重试记录', () => {
    const g = createDeadlockGuard()
    expect(g.onMessageTimeout('m1')).toMatchObject({ kind: 'retry' })
    expect(g.diagnostics()).toHaveLength(1)
  })
})
