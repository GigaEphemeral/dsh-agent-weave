/**
 * 节点活动面板（MVP-4 P4.C.7）。
 *
 * 点击节点后 3s 轮询 /activity，展示最近活动行。
 */
import { useEffect, useState } from 'react'
import type { ActivityLine } from '../types'

export function NodeActivityPanel({ graphId, nodeId }: { graphId: string | null; nodeId: string | null }) {
  const [lines, setLines] = useState<ActivityLine[]>([])

  useEffect(() => {
    if (!graphId || !nodeId) {
      setLines([])
      return
    }
    const fetchData = (): void => {
      fetch(`/api/weave/graph/${graphId}/node/${nodeId}/activity`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setLines)
        .catch(() => {})
    }
    fetchData()
    const t = setInterval(fetchData, 3000)
    return () => clearInterval(t)
  }, [graphId, nodeId])

  if (!nodeId) return null
  return (
    <div className="node-activity">
      <h3>{nodeId} 活动</h3>
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
