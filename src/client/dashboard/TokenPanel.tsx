/**
 * Token 分账面板（MVP-4 P4.C.4）。
 *
 * 3s 轮询 /tokens；SSE 到达时由上层快照驱动重渲染，此面板独立轮询保证最新。
 */
import { useEffect, useState } from 'react'
import type { TokenRow } from '../types'

export function TokenPanel({ graphId }: { graphId: string | null }) {
  const [rows, setRows] = useState<TokenRow[]>([])
  const [total, setTotal] = useState<{ totalTokens: number }>({ totalTokens: 0 })

  useEffect(() => {
    if (!graphId) return
    const fetchData = (): void => {
      fetch(`/api/weave/graph/${graphId}/tokens`)
        .then((r) => (r.ok ? r.json() : { rows: [], total: { totalTokens: 0 } }))
        .then((d) => {
          setRows(d.rows ?? [])
          setTotal(d.total ?? { totalTokens: 0 })
        })
        .catch(() => {})
    }
    fetchData()
    const t = setInterval(fetchData, 3000)
    return () => clearInterval(t)
  }, [graphId])

  return (
    <div className="token-panel">
      <h3>Token 消耗（总 {total.totalTokens?.toLocaleString() ?? 0}）</h3>
      {rows.length === 0 ? (
        <div style={{ color: '#888', fontSize: 12 }}>（暂无分账数据，运行图后可见真实数值）</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>节点</th>
              <th style={{ textAlign: 'left' }}>角色</th>
              <th style={{ textAlign: 'right' }}>输入</th>
              <th style={{ textAlign: 'right' }}>输出</th>
              <th style={{ textAlign: 'right' }}>合计</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.node}>
                <td>{r.node}</td>
                <td>{r.role}</td>
                <td style={{ textAlign: 'right' }}>{r.usage.inputTokens.toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}>{r.usage.outputTokens.toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}>{r.usage.totalTokens.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
