/**
 * Weave 看板主视图（MVP-4 P4.C.1，D3：主区切换）。
 *
 * 挂载于 conversation.view（list）。未打开时返回 null（不占主区）。
 * 布局：控制条 + 图画布 + 面板网格（Token/审批/信号/消息流/节点活动/历史/恢复）。
 */
import { useState } from 'react'
import { useDashboardOpen } from '../state/dashboard-state'
import { GraphCanvas } from './GraphCanvas'
import { ControlBar } from './ControlBar'
import { TokenPanel } from './TokenPanel'
import { ApprovalPanel } from './ApprovalPanel'
import { SignalPanel } from './SignalPanel'
import { MessageFlowPanel } from './MessageFlowPanel'
import { NodeActivityPanel } from './NodeActivityPanel'
import { RunHistoryPanel } from './RunHistoryPanel'
import { RestorePanel } from './RestorePanel'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { useGraphStream } from '../hooks/useGraphStream'

/** conversation.view 的 owner props（viewRequest 等；MVP-4 不依赖 focus 机制）。 */
export interface ConvViewOwnerProps {
  viewRequest?: unknown
  openView?: (view: string, focus: string) => void
  completeViewRequest?: () => void
}

export function WeaveDashboardView(_owner: ConvViewOwnerProps = {}) {
  const open = useDashboardOpen()
  const [graphId, setGraphId] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const { snap, spec, roleMap } = useGraphStream(graphId)

  if (!open) return null

  return (
    <ErrorBoundary>
      <div className="weave-dashboard" data-weave-dashboard style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ControlBar graphId={graphId} onGraphChange={setGraphId} />
        <GraphCanvas spec={spec} snap={snap} roleMap={roleMap} onSelectNode={setSelectedNode} />
        <div className="weave-panels" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
          <ErrorBoundary><TokenPanel graphId={graphId} /></ErrorBoundary>
          <ErrorBoundary><ApprovalPanel graphId={graphId} /></ErrorBoundary>
          <ErrorBoundary><SignalPanel graphId={graphId} /></ErrorBoundary>
          <ErrorBoundary><MessageFlowPanel graphId={graphId} /></ErrorBoundary>
          {selectedNode && (
            <ErrorBoundary><NodeActivityPanel graphId={graphId} nodeId={selectedNode} /></ErrorBoundary>
          )}
          <ErrorBoundary><RunHistoryPanel onSelect={setGraphId} /></ErrorBoundary>
          <ErrorBoundary><RestorePanel graphId={graphId} /></ErrorBoundary>
        </div>
      </div>
    </ErrorBoundary>
  )
}
