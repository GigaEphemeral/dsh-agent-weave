/**
 * 控制条（问题2：去终止；节点级暂停/恢复；UI 反馈）。
 *
 * - 图级：【暂停整个图】【恢复整个图】（无终止）
 * - 节点级（选中节点后）：【⏸ 暂停】【▶ 恢复】（interrupt/sendMessage childId）
 * - 每次操作有即时反馈（info/ok/err 状态条）
 */
import { useState } from 'react'

interface Props {
  graphId: string | null
  selectedNode: string | null
  onGraphChange: (id: string | null) => void
}

type Action = 'pause' | 'resume'

export function ControlBar({ graphId, selectedNode, onGraphChange }: Props) {
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ kind: 'info' | 'ok' | 'err'; text: string } | null>(null)

  const flash = (kind: 'info' | 'ok' | 'err', text: string, ms = 6000): void => {
    setMessage({ kind, text })
    setTimeout(() => setMessage(null), ms)
  }

  const callGraph = async (action: Action): Promise<void> => {
    if (!graphId) return
    setLoading(true)
    flash('info', `图级 ${action} 已发送，等待当前 subagent 响应…`)
    try {
      const r = await fetch(`/api/weave/graph/${graphId}/${action}`, { method: 'POST' })
      if (!r.ok) {
        const err = (await r.json().catch(() => ({}))) as { error?: string }
        flash('err', `✗ 失败: ${err.error ?? r.status}`)
        return
      }
      flash('ok', `✓ 图级 ${action} 已发送（DSH 子代理通常数秒~1 分钟响应）`, 15000)
    } catch (e) {
      flash('err', `✗ 网络错误: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  const callNode = async (action: Action): Promise<void> => {
    if (!graphId || !selectedNode) return
    setLoading(true)
    flash('info', `节点 ${selectedNode} 的 ${action} 已发送…`)
    try {
      const r = await fetch(`/api/weave/graph/${graphId}/node/${selectedNode}/${action}`, { method: 'POST' })
      if (!r.ok) {
        const err = (await r.json().catch(() => ({}))) as { error?: string }
        flash('err', `✗ ${selectedNode} ${action} 失败: ${err.error ?? r.status}`, 10000)
        return
      }
      const msg = action === 'pause'
        ? `✓ 已对 ${selectedNode} 发送 interrupt（等价手动停止该 subagent）`
        : `✓ 已向 ${selectedNode} 发送"继续"`
      flash('ok', msg, 15000)
    } catch (e) {
      flash('err', `✗ 网络错误: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          placeholder="graphId（可留空=最近运行）"
          value={graphId ?? ''}
          onChange={(e) => onGraphChange(e.target.value || null)}
          style={{ flex: 1, padding: '4px 8px' }}
        />
      </div>

      {selectedNode && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>🎯 选中节点：{selectedNode}</span>
          <button onClick={() => void callNode('pause')} disabled={loading}>⏸ 暂停</button>
          <button onClick={() => void callNode('resume')} disabled={loading}>▶ 恢复</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: '#666' }}>图级：</span>
        <button onClick={() => void callGraph('pause')} disabled={loading || !graphId}>⏸ 暂停整个图</button>
        <button onClick={() => void callGraph('resume')} disabled={loading || !graphId}>▶ 恢复整个图</button>
      </div>

      {message && (
        <div style={{
          fontSize: 12, padding: '4px 8px', borderRadius: 4,
          background: message.kind === 'ok' ? '#dcfce7' : message.kind === 'err' ? '#fee2e2' : '#dbeafe',
          color: message.kind === 'ok' ? '#15803d' : message.kind === 'err' ? '#b91c1c' : '#1e40af',
        }}>
          {message.text}
        </div>
      )}
    </div>
  )
}
