/**
 * 审批面板（MVP-4 P4.C.5）。
 *
 * 3s 轮询待办 + 秒级倒计时 + 批准/拒绝按钮。
 */
import { useEffect, useState } from 'react'
import type { ApprovalRequest } from '../types'

export function ApprovalPanel({ graphId }: { graphId: string | null }) {
  const [requests, setRequests] = useState<ApprovalRequest[]>([])
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!graphId) return
    const fetchList = (): void => {
      fetch(`/api/weave/graph/${graphId}/approvals`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setRequests)
        .catch(() => {})
    }
    fetchList()
    const t = setInterval(fetchList, 3000)
    return () => clearInterval(t)
  }, [graphId])

  // 倒计时
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const decide = async (id: string, decision: 'approved' | 'rejected'): Promise<void> => {
    await fetch(`/api/weave/approval/${id}/${decision === 'approved' ? 'approve' : 'reject'}`, { method: 'POST' })
    setRequests((rs) => rs.map((r) => (r.id === id ? { ...r, resolved: { decision, at: Date.now() } } : r)))
  }

  const pendingCount = requests.filter((r) => !r.resolved).length

  return (
    <div className="approval-panel">
      <h3>审批待办（{pendingCount}）</h3>
      {requests.length === 0 ? (
        <div style={{ color: '#888', fontSize: 12 }}>（暂无审批请求）</div>
      ) : (
        requests.map((r) => {
          const remaining = r.timeoutMs - (now - r.createdAt)
          return (
            <div key={r.id} className="approval-item" style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 8, marginBottom: 6 }}>
              <div>
                <b>{r.level}</b> {r.nodeId} <span style={{ fontSize: 11, color: '#666' }}>{r.reason}</span>
              </div>
              {!r.resolved ? (
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <span style={{ fontSize: 12 }}>剩余 {Math.max(0, Math.round(remaining / 1000))}s</span>
                  <button onClick={() => void decide(r.id, 'approved')}>批准</button>
                  <button onClick={() => void decide(r.id, 'rejected')}>拒绝</button>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: r.resolved.decision === 'approved' ? '#15803d' : '#b91c1c' }}>
                  已{r.resolved.decision === 'approved' ? '批准' : '拒绝'}
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
