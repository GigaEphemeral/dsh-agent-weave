/**
 * 运行 Tab（MVP-5B UI 重构）：状态卡片 + Token + 审批 + 信号/消息流 + 活动流。
 * 图完成时顶部绿色横幅「查看产物 →」。
 */
import { useEffect, useState } from 'react'
import { TokenPanel } from '../../dashboard/TokenPanel.js'
import { ApprovalPanel } from '../../dashboard/ApprovalPanel.js'
import { SignalPanel } from '../../dashboard/SignalPanel.js'
import { MessageFlowPanel } from '../../dashboard/MessageFlowPanel.js'
import { ActivityStream } from '../ActivityStream.js'
import { useGraphStream } from '../../hooks/useGraphStream.js'
import { useActivityFeed } from '../../hooks/useActivityFeed.js'
import type { CurrentTask } from '../../state/board-state.js'

export function RuntimePane({ task }: { task: CurrentTask }) {
  const graphId = task.graphId
  const { snap, spec } = useGraphStream(graphId)
  const activity = useActivityFeed(graphId)
  const [showSecondary, setShowSecondary] = useState(false)

  // 图完成时显示横幅提示
  const [showCompleteBanner, setShowCompleteBanner] = useState(false)
  useEffect(() => {
    setShowCompleteBanner(task.phase === 'completed')
  }, [task.phase])

  if (!graphId) {
    return <div className="pane-empty">（尚未启动图，请先在【编排】完成配置并点【开始工作】）</div>
  }

  return (
    <div className="runtime-pane">
      {showCompleteBanner && (
        <div className="complete-banner">
          ✅ 图已完成
          <button className="btn primary" onClick={() => window.dispatchEvent(new CustomEvent('weave:view-artifacts'))}>
            查看产物 →
          </button>
          <button className="banner-close" onClick={() => setShowCompleteBanner(false)}>×</button>
        </div>
      )}

      <div className="runtime-cards">
        <StatusCard snap={snap} />
        <NodeActivityCard snap={snap} spec={spec} activity={activity} />
        <TokenPanel graphId={graphId} />
      </div>

      <details className="runtime-details" open={showSecondary} onToggle={(e) => setShowSecondary((e.target as HTMLDetailsElement).open)}>
        <summary>观察者信号 / 消息流 / 审批</summary>
        <div className="detail-grid">
          <SignalPanel graphId={graphId} />
          <MessageFlowPanel graphId={graphId} />
        </div>
      </details>

      <ApprovalPanel graphId={graphId} />
      <ActivityStream graphId={graphId} />
    </div>
  )
}

/** P4：节点实时活动卡片（各节点状态 + 当前活动气泡摘要）。 */
function NodeActivityCard({
  snap, spec, activity,
}: {
  snap: ReturnType<typeof useGraphStream>['snap']
  spec: ReturnType<typeof useGraphStream>['spec']
  activity: ReturnType<typeof useActivityFeed>
}) {
  const states = snap?.nodeStates ?? {}
  const ids = (spec?.nodes ?? []).map((n) => n.id)
  const nodeRows = ids.length > 0
    ? ids
    : Object.keys(states)

  const STATUS_LABEL: Record<string, string> = {
    running: '运行中', completed: '完成', failed: '失败', waiting: '等待', idle: '待命',
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">节点实时活动</span>
        <span className="card-sub">{Object.values(states).filter((s) => s === 'running').length} 运行中</span>
      </div>
      <div className="card-body">
        {nodeRows.length === 0 && <div className="pane-empty">（暂无节点）</div>}
        {nodeRows.map((id) => {
          const status = states[id] ?? 'idle'
          const act = activity.get(id)
          return (
            <div key={id} className="node-activity-row">
              <span className={`node-dot ${status}`} />
              <span className="node-id">{id}</span>
              <span className={`node-status ${status}`}>{STATUS_LABEL[status] ?? status}</span>
              {act?.text && <span className="node-act-text">{act.icon ?? '💬'} {act.text}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StatusCard({ snap }: { snap: ReturnType<typeof useGraphStream>['snap'] }) {
  if (!snap) return <div className="card"><div className="card-head"><span className="card-title">图状态</span></div><div className="card-body"><div className="pane-empty">（无数据）</div></div></div>
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">图状态</span>
        <span className="card-sub">{snap.graphId.slice(-12)}</span>
      </div>
      <div className="card-body">
        <div className="status-grid">
          <div className="status-cell"><span className="label">当前节点</span><span className="value brand">{snap.current || '—'}</span></div>
          <div className="status-cell"><span className="label">迭代</span><span className="value">{snap.iteration} / {snap.maxIterations}</span></div>
          <div className="status-cell"><span className="label">耗时</span><span className="value">{(snap.elapsedMs / 1000).toFixed(1)}s</span></div>
          <div className="status-cell"><span className="label">Token</span><span className="value">{snap.tokenUsed.toLocaleString()}</span></div>
        </div>
      </div>
    </div>
  )
}
