/**
 * 节点活动面板（MVP-4 P4.C.7 + 实时进展修复）。
 *
 * 双通道：
 * - SSE 实时流：消费 graph/node-activity（tool-call/result/assistant/thinking），即时显示
 * - 3s 轮询 /activity：兜底（SSE 断线/重连后补历史）
 * 图标：💭思考 🔧工具调用 ✓工具返回 💬assistant
 */
import { useEffect, useState } from 'react'
import type { ActivityLine } from '../types'

interface ActivityEvent {
  event_type: string
  node?: string
  timestamp: number
  data?: Record<string, unknown>
}

/** 活动事件 → 展示行。 */
function toLine(e: ActivityEvent): ActivityLine {
  const d = e.data ?? {}
  const kind = String(d.kind ?? '')
  const icon = kind === 'tool-call' ? '🔧' : kind === 'tool-result' ? '✓' : kind === 'thinking' ? '💭' : '💬'
  const text =
    kind === 'tool-call' ? `调用 ${String(d.tool ?? 'tool')}(${String(d.args ?? '')})`
    : kind === 'tool-result' ? `${String(d.tool ?? 'tool')} 返回: ${String(d.result ?? '')}`
    : String(d.text ?? '')
  return { timestamp: e.timestamp, icon, text }
}

export function NodeActivityPanel({ graphId, nodeId }: { graphId: string | null; nodeId: string | null }) {
  const [lines, setLines] = useState<ActivityLine[]>([])

  // SSE 实时流（graph/node-activity 即时显示）
  useEffect(() => {
    if (!graphId || !nodeId) return
    const es = new EventSource(`/api/weave/graph/${graphId}/stream`)
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as ActivityEvent
        if (evt.event_type !== 'node-activity' || evt.node !== nodeId) return
        setLines((prev) => [...prev, toLine(evt)].slice(-100))
      } catch {
        // 忽略解析失败
      }
    }
    return () => es.close()
  }, [graphId, nodeId])

  // 3s 轮询兜底（SSE 断线补历史）
  useEffect(() => {
    if (!graphId || !nodeId) {
      setLines([])
      return
    }
    const fetchData = (): void => {
      fetch(`/api/weave/graph/${graphId}/node/${nodeId}/activity`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: ActivityLine[]) => {
          if (rows.length > 0) setLines(rows)
        })
        .catch(() => {})
    }
    fetchData()
    const t = setInterval(fetchData, 3000)
    return () => clearInterval(t)
  }, [graphId, nodeId])

  if (!nodeId) return null
  return (
    <div className="node-activity">
      <h3>{nodeId} 实时活动</h3>
      {lines.length === 0 ? (
        <div style={{ color: '#888', fontSize: 12 }}>（暂无活动）</div>
      ) : (
        lines.map((l, i) => (
          <div key={i} style={{ fontSize: 12 }}>
            {l.icon} {l.text} <span style={{ color: '#94a3b8', fontSize: 10 }}>{new Date(l.timestamp).toLocaleTimeString('zh-CN')}</span>
          </div>
        ))
      )}
    </div>
  )
}
