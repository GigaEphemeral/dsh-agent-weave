/**
 * 消息总线（MVP-3 P3.B.1）。
 *
 * 封装 ctx.subagents.sendMessage（RES.3 确认签名），提供：
 * - 消息类型：handoff / query / feedback / escalation
 * - correlation_id 关联；deadline 超时；priority 分级
 * - send：父代理中转 A→父→B（父调用 sendMessage 转发）
 *
 * 消息契约（README §消息总线与防死锁）：
 *   Message { id, correlation_id, from, to, type, payload:{artifact_ref?,summary,full_content?},
 *             deadline, priority }
 */
export type MessageType = 'handoff' | 'query' | 'feedback' | 'escalation'
export type MessagePriority = 'high' | 'normal' | 'low'

export interface MessagePayload {
  artifact_ref?: string
  summary: string
  full_content?: string
}

export interface Message {
  id: string
  correlation_id: string
  from: string
  to: string
  type: MessageType
  payload: MessagePayload
  deadline: number // 绝对时间戳 ms
  priority: MessagePriority
}

export interface MessageBusOptions {
  /** 消息 TTL（毫秒），默认 60s。 */
  ttlMs?: number
  /** sendMessage 底层调用（注入以便测试/替换）。 */
  sendImpl?: (to: string, content: Message) => Promise<string>
}

export interface MessageBus {
  /** 构造消息（id/correlation_id/deadline 自动生成）。 */
  createMessage(input: Omit<Message, 'id' | 'correlation_id' | 'deadline'> & { correlation_id?: string }): Message
  /** 发送消息（走 sendImpl）。返回 messageId。 */
  send(msg: Message): Promise<string>
  /** 检查消息是否已过期。 */
  isExpired(msg: Message, nowMs?: number): boolean
}

/** 生成消息 id（短随机）。 */
export function genMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 创建消息总线。 */
export function createMessageBus(options: MessageBusOptions = {}): MessageBus {
  const ttlMs = options.ttlMs ?? 60_000
  const sendImpl = options.sendImpl

  return {
    createMessage(input) {
      const now = Date.now()
      return {
        ...input,
        id: genMessageId(),
        correlation_id: input.correlation_id ?? genMessageId(),
        deadline: now + ttlMs,
      }
    },
    async send(msg) {
      if (!sendImpl) throw new Error('MessageBus 未配置 sendImpl（真实环境注入 ctx.subagents.sendMessage）')
      if (this.isExpired(msg)) throw new Error(`消息已过期: ${msg.id}（${msg.type} ${msg.from}→${msg.to}）`)
      return sendImpl(msg.to, msg)
    },
    isExpired(msg, nowMs = Date.now()) {
      return nowMs > msg.deadline
    },
  }
}

/** 构建真实 sendImpl（包装 ctx.subagents.sendMessage，父代理中转）。 */
export function createRealSendImpl(ctx: {
  subagents: {
    sendMessage(
      sender: unknown,
      targetId: string,
      content: Array<{ type: 'text'; text: string }>,
      options: { signal?: AbortSignal },
    ): Promise<string>
  }
}, parent: unknown): MessageBusOptions['sendImpl'] {
  return async (to, msg) => {
    const content = [{ type: 'text' as const, text: JSON.stringify({ type: msg.type, payload: msg.payload }) }]
    return ctx.subagents.sendMessage(parent as never, to, content, {})
  }
}
