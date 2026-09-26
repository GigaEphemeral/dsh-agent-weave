/**
 * dsh-agent-weave Client 入口（MVP-5B UI 重构）。
 *
 * 挂载 WeaveBoard（4-Tab 工作台）到 conversation.view，BoardOverlays 到 shell.overlay。
 * 全局 SSE 订阅 → board-state（任务提议 → 编排；图启动 → 运行）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { WeaveBoard } from './board/WeaveBoard.js'
import { BoardOverlays } from './board/BoardOverlays.js'
import { setCurrentTask, setActiveTab, clearTask } from './state/board-state.js'

interface SlotsLike {
  inject(name: string, register: () => (() => void) | undefined): void
  register(opts: { name: string; id?: string; order?: number; label?: string | (() => string) }, comp: unknown): () => void
}

type ClientContext = Context & { slots?: SlotsLike }

const SLOT_D3 = 'conversation.view'
const SLOT_OVERLAY = 'shell.overlay'

export const name = 'dsh-agent-weave-client'
export const inject = ['slots']

export function apply(ctx: Context): void {
  const slots = (ctx as ClientContext).slots
  if (!slots) return

  // D3：看板主体（4-Tab 工作台）
  slots.inject(SLOT_D3, () => slots.register(
    { name: SLOT_D3, id: 'weave-board', label: () => 'Weave 看板', order: 10 },
    WeaveBoard,
  ))

  // overlay：浮层（用户确认 / 角色编辑 / 节点编辑）
  slots.inject(SLOT_OVERLAY, () => slots.register(
    { name: SLOT_OVERLAY, id: 'weave-overlays', order: 100 },
    BoardOverlays,
  ))

  // 全局 SSE：任务提议 → 打开看板 + 切编排；图启动 → 运行
  const es = new EventSource('/api/weave/stream')
  es.onmessage = (msg) => {
    try {
      const evt = JSON.parse(msg.data) as {
        event_type?: string
        trace_id?: string
        data?: { taskId?: string; graphId?: string; pauseReason?: string; error?: string; status?: string }
      }

      if (evt.event_type === 'task-proposed' && evt.data?.taskId) {
        // 拉取任务详情
        fetch(`/api/weave/tasks/${evt.data.taskId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((task) => {
            if (!task) return
            setCurrentTask({
              taskId: task.taskId,
              phase: 'editing',
              userInput: task.userInput,
              template: task.template,
            })
            setActiveTab('canvas')
            // 尝试激活看板（best-effort）
            try {
              const s = slots as SlotsLike & { activate?: (slot: string, id: string, opts?: unknown) => void }
              s.activate?.('conversation.view', 'weave-board', { taskId: task.taskId })
            } catch { /* 降级：用户手动切 Tab */ }
          })
          .catch(() => {})
        return
      }

      if (evt.event_type === 'graph-start' && evt.trace_id) {
        setCurrentTask({ graphId: evt.trace_id, phase: 'running' })
        setActiveTab('runtime')
        return
      }

      if (evt.event_type === 'graph-paused') {
        const reason = evt.data?.pauseReason ?? ''
        if (reason === 'awaiting-user' || reason === 'approval-pending' || reason === 'environment-gate') {
          window.dispatchEvent(new CustomEvent('weave:user-question', {
            detail: {
              graphId: evt.trace_id,
              question: { text: evt.data?.error ?? `图已暂停（${reason}），需要你的确认` },
            },
          }))
        }
        setCurrentTask({ phase: 'awaiting' })
        return
      }

      if (evt.event_type === 'graph-end' && evt.data?.status === 'completed') {
        setCurrentTask({ phase: 'completed' })
        return
      }
    } catch { /* 忽略坏帧 */ }
  }
  es.onerror = () => { /* auto-reconnect */ }
  ctx.effect(() => () => es.close())

  // 响应"查看产物"事件
  const onViewArtifacts = (): void => setActiveTab('artifacts')
  window.addEventListener('weave:view-artifacts', onViewArtifacts)
  ctx.effect(() => () => window.removeEventListener('weave:view-artifacts', onViewArtifacts))

  // 响应"新建任务"事件（清状态）
  const onNewTask = (): void => clearTask()
  window.addEventListener('weave:new-task', onNewTask)
  ctx.effect(() => () => window.removeEventListener('weave:new-task', onNewTask))
}
