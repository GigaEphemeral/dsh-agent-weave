/**
 * RunLedger 审计账本（MVP-3 P3.C.3）。
 *
 * 不可变事件流（只追加）：节点事件 + Token 分账 + 合规状态 + 人工介入。
 * 用可注入存储（默认内存；落盘 JSONL 可选）。对齐 OTel 事件语义。
 */
export type LedgerEventType =
  | 'graph/start' | 'graph/node-start' | 'graph/node-end' | 'graph/node-error'
  | 'graph/end' | 'checkpoint-written' | 'approval' | 'token-accounted'
  | 'agent-message'   // MVP-4 P4.B.11 新增（消息流桥接，零 token）
  | 'observer-signal' // MVP-4 P4.B.7 新增（观察者信号）
  | 'approval-request' | 'approval-decided'  // MVP-4 P4.B.3 新增（审批闭环）

export interface LedgerEvent {
  seq: number
  type: LedgerEventType
  graphId: string
  node?: string
  timestamp: number
  data?: Record<string, unknown>
}

export interface RunLedger {
  /** 追加事件（不可变；返回 seq）。 */
  append(evt: Omit<LedgerEvent, 'seq'>): number
  /** 按序读取全部事件。 */
  events(): LedgerEvent[]
  /** 按 graphId 过滤。 */
  byGraph(graphId: string): LedgerEvent[]
  /** 序列化为 JSONL 字符串。 */
  toJSONL(): string
}

/** 创建 RunLedger。 */
export function createRunLedger(initialText?: string): RunLedger {
  const events: LedgerEvent[] = []
  if (initialText) {
    for (const line of initialText.split('\n')) {
      if (!line.trim()) continue
      try {
        const evt = JSON.parse(line) as LedgerEvent
        events.push(evt)
      } catch {
        // 忽略损坏行
      }
    }
  }

  return {
    append(evt) {
      const seq = events.length
      const full: LedgerEvent = { ...evt, seq }
      events.push(full)
      return seq
    },
    events: () => [...events],
    byGraph(graphId) {
      return events.filter((e) => e.graphId === graphId)
    },
    toJSONL() {
      return events.map((e) => JSON.stringify(e)).join('\n')
    },
  }
}
