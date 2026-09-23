/**
 * 消息流面板（MVP-4 P4.C.11）★ 零 token。
 *
 * SSE 流内过滤 agent-message：A→父→B 时间线（只读 ledger 事件，不注入 context）。
 */
import { useEffect, useState } from 'react'

interface AgentMessage {
  id: string
  from: string
  to: string
  type: string
  summary: string
  artifact_ref?: string
  timestamp: number
  correlation_id: string
}

export function MessageFlowPanel({ graphId }: { graphId: string | null }) {
  const [messages, setMessages] = useState<AgentMessage[]>([])

  useEffect(() => {
    if (!graphId) return
    const es = new EventSource(`/api/weave/graph/${graphId}/stream`)
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as { event_type: string; data?: AgentMessage }
        if (evt.event_type === 'agent-message' && evt.data) {
          setMessages((m) => [evt.data as AgentMessage, ...m].slice(0, 100))
        }
      } catch {
        // 忽略
      }
    }
    return () => es.close()
  }, [graphId])

  return (
    <div className="message-flow">
      <h3>Agent 消息流（零 token）</h3>
      {messages.length === 0 ? (
        <div style={{ color: '#888', fontSize: 12 }}>（暂无消息；消息桥接只读 ledger，不产生额外 token）</div>
      ) : (
        messages.map((m) => (
          <div key={m.id} style={{ fontSize: 12, borderBottom: '1px solid #f1f5f9', padding: '3px 0' }}>
            <div>
              <b>{m.from}</b> → <b>{m.to}</b>{' '}
              <span style={{ background: '#eef2ff', borderRadius: 4, padding: '0 4px', fontSize: 10 }}>{m.type}</span>
            </div>
            <div style={{ color: '#475569' }}>{m.summary}</div>
            {m.artifact_ref && <div style={{ color: '#0369a1' }}>📎 {m.artifact_ref}</div>}
            <div style={{ color: '#94a3b8', fontSize: 10 }}>{new Date(m.timestamp).toLocaleTimeString('zh-CN')}</div>
          </div>
        ))
      )}
    </div>
  )
}
