/**
 * Weave 看板按钮（MVP-4 P4.C.1，D1：页头）。
 *
 * 挂载于 conversation.session.header.actions（list，标题旁动作）。
 * 点击切换全局看板开关（dashboard-state），D3 视图据此渲染。
 */
import { useDashboardOpen, setDashboardOpen } from '../state/dashboard-state'

export function WeaveDashboardButton() {
  const open = useDashboardOpen()
  return (
    <button
      type="button"
      onClick={() => setDashboardOpen(!open)}
      className={`weave-header-btn${open ? ' active' : ''}`}
      style={{
        cursor: 'pointer',
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid #cbd5e1',
        background: open ? '#e0e7ff' : '#fff',
        fontSize: 13,
      }}
    >
      Weave 看板
    </button>
  )
}
