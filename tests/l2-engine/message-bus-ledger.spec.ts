/**
 * message-bus → ledger 零 token 桥接单测（MVP-4 P4.B.11）。
 *
 * 验证：send 成功后 ledger 追加 agent-message 事件（只存摘要不存全文），
 * 不改变 sendImpl 行为（零 token 新增）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createMessageBus, type Message } from '../../src/l2-engine/message-bus'
import { createRunLedger } from '../../src/l5-observability/run-ledger'

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    correlation_id: 'corr-1',
    from: 'A',
    to: 'B',
    type: 'handoff',
    payload: { summary: '任务完成', artifact_ref: 'art/1.md', full_content: '超长内容不落账' },
    deadline: Date.now() + 60_000,
    priority: 'normal',
    ...overrides,
  }
}

describe('P4.B.11 消息流零 token 桥接', () => {
  it('send 后 ledger 追加 agent-message（只存摘要）', async () => {
    const ledger = createRunLedger()
    const sendImpl = vi.fn(async () => 'ok')
    const bus = createMessageBus({ sendImpl, ledger, graphId: 'g1' })
    await bus.send(makeMsg())
    expect(sendImpl).toHaveBeenCalledTimes(1)
    const evts = ledger.byGraph('g1')
    expect(evts).toHaveLength(1)
    expect(evts[0]?.type).toBe('agent-message')
    const data = evts[0]?.data as { summary?: string; full_content?: string; from?: string; to?: string }
    expect(data.summary).toBe('任务完成')
    expect(data.full_content).toBeUndefined() // 不存全文
    expect(data.from).toBe('A')
    expect(data.to).toBe('B')
  })

  it('无 ledger 时行为不变（零侵入）', async () => {
    const sendImpl = vi.fn(async () => 'ok')
    const bus = createMessageBus({ sendImpl })
    await expect(bus.send(makeMsg())).resolves.toBe('ok')
  })
})
