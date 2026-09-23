/**
 * 控制条（MVP-4 P4.C.8）。
 *
 * graphId 输入 + 暂停/恢复/终止按钮。
 */
import { useState } from 'react'

export function ControlBar({
  graphId,
  onGraphChange,
}: {
  graphId: string | null
  onGraphChange: (id: string | null) => void
}) {
  const [loading, setLoading] = useState(false)

  const call = async (action: 'pause' | 'resume' | 'stop'): Promise<void> => {
    if (!graphId) return
    setLoading(true)
    try {
      await fetch(`/api/weave/graph/${graphId}/${action}`, { method: 'POST' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="control-bar" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
      <input
        placeholder="graphId（可留空=最近运行）"
        value={graphId ?? ''}
        onChange={(e) => onGraphChange(e.target.value || null)}
        style={{ flex: 1, padding: '4px 8px' }}
      />
      <button onClick={() => void call('pause')} disabled={loading || !graphId}>暂停</button>
      <button onClick={() => void call('resume')} disabled={loading || !graphId}>恢复</button>
      <button onClick={() => void call('stop')} disabled={loading || !graphId}>终止</button>
    </div>
  )
}
