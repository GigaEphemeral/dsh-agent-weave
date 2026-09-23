/**
 * 运行历史面板（MVP-4 P4.C.8）。
 *
 * 列出历史运行（/api/weave/graphs），点击选择 graphId。
 */
import { useEffect, useState } from 'react'
import type { RunHistoryEntry } from '../types'

export function RunHistoryPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const [runs, setRuns] = useState<RunHistoryEntry[]>([])

  useEffect(() => {
    fetch('/api/weave/graphs')
      .then((r) => (r.ok ? r.json() : []))
      .then(setRuns)
      .catch(() => {})
  }, [])

  return (
    <div className="run-history">
      <h3>运行历史</h3>
      {runs.length === 0 ? (
        <div style={{ color: '#888', fontSize: 12 }}>（暂无历史运行）</div>
      ) : (
        runs.slice(0, 10).map((r) => (
          <div
            key={r.graphId}
            onClick={() => onSelect(r.graphId)}
            style={{ cursor: 'pointer', fontSize: 12, padding: '2px 0', borderBottom: '1px solid #f1f5f9' }}
          >
            {r.graphId} · {r.status} · {new Date(r.startedAt).toLocaleString('zh-CN')}
          </div>
        ))
      )}
    </div>
  )
}
