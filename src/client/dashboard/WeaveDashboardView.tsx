/**
 * Weave 看板主视图（MVP-4 P4.C.1，D3：主区切换）。
 *
 * 挂载于 conversation.view（list）。未打开时返回 null（不占主区）。
 * 布局：控制条 + 图画布 + 面板网格（Token/审批/信号/消息流/节点活动/历史/恢复）。
 */
import { useEffect, useState } from 'react'
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
import { RoleLibraryPanel } from './RoleLibraryPanel'
import { WeaveTaskPanel } from './WeaveTaskPanel'
import { HandoffViewer } from './HandoffViewer'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { useGraphStream } from '../hooks/useGraphStream'
import { useActivityFeed } from '../hooks/useActivityFeed'

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
  const activity = useActivityFeed(graphId)

  // ★ 问题一步骤4：监听全局图启动事件，自动绑定 graphId（用户零操作）
  useEffect(() => {
    function onGraphStarted(e: Event): void {
      const { graphId: newId } = (e as CustomEvent<{ graphId: string }>).detail
      if (newId) setGraphId(newId)
    }
    window.addEventListener('weave:graph-started', onGraphStarted)
    return () => window.removeEventListener('weave:graph-started', onGraphStarted)
  }, [])

  // ★ 问题一步骤4兜底：graphId 为空时拉当前活跃图
  useEffect(() => {
    if (graphId) return
    fetch('/api/weave/graphs/active')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.graphId) setGraphId(d.graphId as string)
      })
      .catch(() => {})
  }, [graphId])

  if (!open) return null

  return (
    <ErrorBoundary>
      <div className="weave-dashboard" data-weave-dashboard style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ControlBar graphId={graphId} onGraphChange={setGraphId} />
        <GraphCanvas spec={spec} snap={snap} roleMap={roleMap} onSelectNode={setSelectedNode} activity={activity} />
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
          <ErrorBoundary><RoleLibraryPanel /></ErrorBoundary>
          <ErrorBoundary><WeaveTaskPanel /></ErrorBoundary>
          {/* MVP-5B B6：交接单查看器（累积 facts/artifacts/openIssues/unmet） */}
          <ErrorBoundary><HandoffViewer graphId={graphId} /></ErrorBoundary>
        </div>
      </div>
    </ErrorBoundary>
  )
}
