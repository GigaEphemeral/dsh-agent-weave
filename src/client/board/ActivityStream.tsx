/**
 * 实时活动流（MVP-5B UI 重构）：历史日志 + SSE 实时流。
 *
 * - 历史：GET /api/weave/graph/:id/logs（traces jsonl，TrajectoryEvent）
 * - 实时：GET /api/weave/graph/:id/stream（WsEvent，event_type 业务类型）
 */
import { useEffect, useRef, useState } from 'react'

interface Line {
  ts: number
  node: string
  icon: string
  text: string
  kind: '' | 'done' | 'warn' | 'err'
}

export function ActivityStream({ graphId }: { graphId: string | null }) {
  const [lines, setLines] = useState<Line[]>([])
  const [paused, setPaused] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    if (!graphId) { setLines([]); return }
    setLines([])

    // 先拉取历史（traces jsonl）
    fetch(`/api/weave/graph/${graphId}/logs?limit=200`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ event: { type: string; node?: string; timestamp: number; data?: Record<string, unknown> } }>) => {
        if (!Array.isArray(rows)) return
        setLines(rows.map((r) => toLine(r.event)).filter((x): x is Line => x !== null))
      })
      .catch(() => {})

    // SSE 实时流
    const es = new EventSource(`/api/weave/graph/${graphId}/stream`)
    es.onmessage = (msg) => {
      if (paused) return
      try {
        const evt = JSON.parse(msg.data) as { event_type: string; node?: string; timestamp: number; data?: Record<string, unknown> }
        const line = toEventLine(evt)
        if (line) setLines((prev) => [...prev, line].slice(-1000))
      } catch { /* 忽略坏帧 */ }
    }
    return () => es.close()
  }, [graphId, paused])

  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [lines, autoScroll])

  const handleScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }

  return (
    <div className="activity-stream">
      <header className="stream-head">
        <div className="stream-title">
          <span className="live-dot" />
          实时活动流
          <span className="stream-count">{lines.length}</span>
        </div>
        <div className="stream-actions">
          <button className={`btn small${paused ? ' primary' : ''}`} onClick={() => setPaused((p) => !p)}>
            {paused ? '继续' : '暂停'}
          </button>
          <button className="btn small" onClick={() => setLines([])}>清空</button>
        </div>
      </header>
      <div className="stream-body" ref={bodyRef} onScroll={handleScroll}>
        {lines.length === 0 && <div className="pane-empty">（暂无活动）</div>}
        {lines.map((l, i) => (
          <div key={i} className={`act${l.kind ? ' ' + l.kind : ''}`}>
            <span className="t">{fmtTime(l.ts)}</span>
            <span className="n">{l.icon} {l.node}</span>
            <span className="m">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── 转换（历史：TrajectoryEvent.type） ────────────────────
function toLine(e: { type: string; node?: string; timestamp: number; data?: Record<string, unknown> }): Line | null {
  const node = e.node ?? 'graph'
  const d = e.data ?? {}
  switch (e.type) {
    case 'graph/node-start': return { ts: e.timestamp, node, icon: '▶', text: `${node} 开始`, kind: '' }
    case 'graph/node-end':   return { ts: e.timestamp, node, icon: '✓', text: `${node} 完成`, kind: 'done' }
    case 'graph/node-error': return { ts: e.timestamp, node, icon: '✗', text: `${node} 出错: ${String(d.error ?? '')}`, kind: 'err' }
    case 'graph/loop-iteration': return { ts: e.timestamp, node, icon: '⚠', text: `回退 ${String(d.from ?? '')} → ${String(d.to ?? '')}`, kind: 'warn' }
    case 'graph/paused': return { ts: e.timestamp, node, icon: '⏸', text: `暂停：${String(d.reason ?? '')}`, kind: 'warn' }
    default: return null
  }
}

// ─── 转换（实时：WsEvent.event_type） ───────────────────────
function toEventLine(e: { event_type: string; node?: string; timestamp: number; data?: Record<string, unknown> }): Line | null {
  const node = e.node ?? 'graph'
  const d = e.data ?? {}
  switch (e.event_type) {
    case 'node-activity': {
      const kind = String(d.kind ?? '')
      const icon = kind === 'tool-call' ? '🔧' : kind === 'tool-result' ? '✓' : kind === 'thinking' ? '💭' : '💬'
      const text = kind === 'tool-call'
        ? `调用 ${String(d.tool ?? 'tool')}(${String(d.args ?? '')})`
        : kind === 'tool-result'
          ? `${String(d.tool ?? 'tool')} 返回: ${String(d.result ?? '')}`
          : String(d.text ?? '')
      return { ts: e.timestamp, node, icon, text, kind: '' }
    }
    case 'graph-start': return { ts: e.timestamp, node, icon: '▶', text: '图已启动', kind: '' }
    case 'node-start':  return { ts: e.timestamp, node, icon: '▶', text: `${node} 开始`, kind: '' }
    case 'node-end':    return { ts: e.timestamp, node, icon: '✓', text: `${node} 完成`, kind: 'done' }
    case 'node-error':  return { ts: e.timestamp, node, icon: '✗', text: `${node} 出错: ${String(d.error ?? '')}`, kind: 'err' }
    case 'loop-iteration': return { ts: e.timestamp, node, icon: '⚠', text: `回退 ${String(d.from ?? '')} → ${String(d.to ?? '')}`, kind: 'warn' }
    case 'graph-paused': return { ts: e.timestamp, node, icon: '⏸', text: `暂停：${String(d.pauseReason ?? d.reason ?? '')}`, kind: 'warn' }
    case 'graph-end':   return { ts: e.timestamp, node, icon: '■', text: '图结束', kind: 'done' }
    default: return null
  }
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}
