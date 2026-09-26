/**
 * 看板 Tab 栏（MVP-5B UI 重构）：编排 / 运行 / 产物 / 历史。
 * 运行与产物仅在 hasRun 时可用；运行 Tab 带活动流计数徽标。
 */
import { setActiveTab } from '../state/board-state.js'
import type { CurrentTask } from '../state/board-state.js'
import { useActivityFeed } from '../hooks/useActivityFeed.js'

export function BoardTabs({ active, task }: { active: string; task: CurrentTask }) {
  const activity = useActivityFeed(task.graphId)

  const hasRun = task.graphId !== null && task.phase !== 'idle' && task.phase !== 'editing'

  const tabs: Array<{ id: 'canvas' | 'runtime' | 'artifacts' | 'history'; label: string; enabled: boolean; badge?: number }> = [
    { id: 'canvas',    label: '编排',    enabled: true },
    { id: 'runtime',   label: '运行',    enabled: hasRun, badge: activity.size },
    { id: 'artifacts', label: '产物',    enabled: hasRun },
    { id: 'history',   label: '历史',    enabled: true },
  ]

  return (
    <nav className="board-tabs">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`tab${active === t.id ? ' active' : ''}`}
          disabled={!t.enabled}
          onClick={() => setActiveTab(t.id)}
        >
          {t.label}
          {t.badge ? <span className="count">{t.badge}</span> : null}
        </button>
      ))}
    </nav>
  )
}
