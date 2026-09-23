/**
 * 观察者信号面板（MVP-4 P4.C.6）。
 *
 * SSE 流内过滤 observer-signal：按节点热力图 + 信号列表。
 */
import { useEffect, useState } from 'react'
import type { ObserverSignal } from '../types'

/** 信号数 → 热力色。 */
export function heatColor(count: number): string {
  const a = Math.min(count / 10, 1)
  return `rgba(239, 68, 68, ${a * 0.6 + 0.1})`
}

export function SignalPanel({ graphId }: { graphId: string | null }) {
  const [signals, setSignals] = useState<ObserverSignal[]>([])

  useEffect(() => {
    if (!graphId) return
    const es = new EventSource(`/api/weave/graph/${graphId}/stream`)
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as { event_type: string; data?: ObserverSignal }
        if (evt.event_type === 'observer-signal' && evt.data) {
          setSignals((s) => [evt.data as ObserverSignal, ...s].slice(0, 100))
        }
      } catch {
        // 忽略
      }
    }
    return () => es.close()
  }, [graphId])

  const byNode = signals.reduce<Record<string, number>>((acc, s) => {
    acc[s.observed_node] = (acc[s.observed_node] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="signal-panel">
      <h3>观察者信号（{signals.length}）</h3>
      {Object.keys(byNode).length === 0 ? (
        <div style={{ color: '#888', fontSize: 12 }}>（暂无信号）</div>
      ) : (
        <>
          <div className="heatmap" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {Object.entries(byNode).map(([node, count]) => (
              <span key={node} style={{ background: heatColor(count), padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>
                {node} ({count})
              </span>
            ))}
          </div>
          <div className="signal-list">
            {signals.slice(0, 20).map((s) => (
              <div key={s.id} style={{ fontSize: 12, borderBottom: '1px solid #f1f5f9', padding: '2px 0' }}>
                <b style={{ color: s.signal_level === 'red' ? '#b91c1c' : s.signal_level === 'yellow' ? '#a16207' : '#15803d' }}>
                  {s.signal_level.toUpperCase()}
                </b>{' '}
                {s.observed_node} <span style={{ color: '#666' }}>{s.summary}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
