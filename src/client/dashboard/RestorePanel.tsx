/**
 * 恢复点面板（MVP-4 P4.C.8）。
 *
 * 列出 checkpoint 并支持恢复（POST /restore）。
 */
import { useEffect, useState } from 'react'
import type { CheckpointEntry } from '../types'

export function RestorePanel({ graphId }: { graphId: string | null }) {
  const [checkpoints, setCheckpoints] = useState<CheckpointEntry[]>([])

  useEffect(() => {
    if (!graphId) {
      setCheckpoints([])
      return
    }
    fetch(`/api/weave/graph/${graphId}/checkpoints`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setCheckpoints)
      .catch(() => {})
  }, [graphId])

  const restore = async (iteration: number, node: string): Promise<void> => {
    if (!graphId) return
    await fetch(`/api/weave/graph/${graphId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iteration, node }),
    })
  }

  if (!graphId) return null
  return (
    <div className="restore-panel">
      <h3>恢复点</h3>
      {checkpoints.length === 0 ? (
        <div style={{ color: '#888', fontSize: 12 }}>（暂无恢复点）</div>
      ) : (
        checkpoints.map((c) => (
          <div key={`${c.iteration}-${c.node}`} style={{ fontSize: 12, padding: '2px 0' }}>
            iter={c.iteration} · {c.node} · {new Date(c.timestamp).toLocaleString('zh-CN')}{' '}
            <button onClick={() => void restore(c.iteration, c.node)}>恢复</button>
          </div>
        ))
      )}
    </div>
  )
}
