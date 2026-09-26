/**
 * Weave 4-Tab 全屏工作台（MVP-5B UI 重构，替换 MVP-4 的 9 面板 grid）。
 *
 * 编排纯净（无监控）/ 运行只读（无编辑）/ 状态驱动（零手动）/ 交接单归位（产物 Tab）。
 */
import { BoardToolbar } from './BoardToolbar.js'
import { BoardTabs } from './BoardTabs.js'
import { CanvasPane } from './panes/CanvasPane.js'
import { RuntimePane } from './panes/RuntimePane.js'
import { ArtifactsPane } from './panes/ArtifactsPane.js'
import { HistoryPane } from './panes/HistoryPane.js'
import { ErrorBoundary } from '../components/ErrorBoundary.js'
import { useBoardState } from '../state/board-state.js'
import { useTabRouter } from '../hooks/useTabRouter.js'
import { BOARD_CSS } from './board-styles.js'

export function WeaveBoard() {
  useTabRouter()
  const { task, activeTab } = useBoardState()

  return (
    <div className="weave-board">
      <style>{BOARD_CSS}</style>
      <ErrorBoundary><BoardToolbar task={task} /></ErrorBoundary>
      <ErrorBoundary><BoardTabs active={activeTab} task={task} /></ErrorBoundary>
      <div className="board-content">
        <div className={`pane${activeTab === 'canvas' ? ' active' : ''}`}>
          <ErrorBoundary><CanvasPane task={task} /></ErrorBoundary>
        </div>
        <div className={`pane${activeTab === 'runtime' ? ' active' : ''}`}>
          <ErrorBoundary><RuntimePane task={task} /></ErrorBoundary>
        </div>
        <div className={`pane${activeTab === 'artifacts' ? ' active' : ''}`}>
          <ErrorBoundary><ArtifactsPane task={task} /></ErrorBoundary>
        </div>
        <div className={`pane${activeTab === 'history' ? ' active' : ''}`}>
          <ErrorBoundary><HistoryPane /></ErrorBoundary>
        </div>
      </div>
    </div>
  )
}
