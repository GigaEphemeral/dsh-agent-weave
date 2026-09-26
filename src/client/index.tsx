import type { Context } from '@deepseek-ai/cordis'
import { WeaveDashboardButton } from './dashboard/WeaveDashboardButton.js'
import { WeaveDashboardView } from './dashboard/WeaveDashboardView.js'
import { WeaveEditPanel } from './dashboard/WeaveEditPanel.js'
import { UserQuestionModal } from './dashboard/UserQuestionModal.js'

function diag(msg: string, data?: unknown): void {
    const line = `[weave-client] ${msg}${data !== undefined ? ' ' + JSON.stringify(data).slice(0, 200) : ''}`
    console.log(line)
    if (typeof document !== 'undefined') {
        document.title = `[weave] ${msg}`.slice(0, 90)
    }
}

diag('module loaded', {
    url: typeof window !== 'undefined' ? window.location.href.slice(0, 60) : 'no-window',
})

interface SlotsLike {
    inject(name: string, register: () => (() => void) | undefined): void
    register(
        options: {
            name: string
            id?: string
            order?: number
            label?: string | (() => string)
        },
        component: unknown,
    ): () => void
}

type ClientContext = Context & { slots?: SlotsLike }

const SLOT_D1 = 'conversation.session.header.actions'
const SLOT_D3 = 'conversation.view'
// MVP-5B B6（决策 #8）：常驻挂载用 shell.overlay（真实 Slot 树；设计文档的 app.root 为占位）
const SLOT_OVERLAY = 'shell.overlay'

export const name = 'dsh-agent-weave-client'
export const inject = ['slots']

export function apply(ctx: Context): void {
    diag('apply invoked')

    const slots = (ctx as ClientContext).slots
    if (!slots) {
        diag('no slots')
        return
    }

    diag('slots API', {
        injectType: typeof slots.inject,
        registerType: typeof slots.register,
    })

    // D1：页头按钮
    try {
        diag('D1 register start', { slot: SLOT_D1 })
        slots.inject(SLOT_D1, () => {
            diag('D1 inject callback fired')
            return slots.register(
                {
                    name: SLOT_D1,
                    id: 'weave-dashboard-toggle',
                    label: () => 'Weave 看板',
                    order: 0,
                },
                WeaveDashboardButton,
            )
        })
        diag('D1 inject call ok')
    } catch (error) {
        diag('D1 FAILED', { error: error instanceof Error ? error.message : String(error) })
    }

    // MVP-5 Phase I：全局右侧滑出编辑面板 + 用户确认弹窗（挂 header 槽位，聊天页也可见）
    // MVP-5B B6（决策 #8）：改为常驻挂载到 shell.overlay（不依赖 dashboard 开关）
    try {
        diag('overlay register start', { slot: SLOT_OVERLAY })
        slots.inject(SLOT_OVERLAY, () => slots.register(
            { name: SLOT_OVERLAY, id: 'weave-edit-panel-host', order: 1 },
            WeaveEditPanel,
        ))
        slots.inject(SLOT_OVERLAY, () => slots.register(
            { name: SLOT_OVERLAY, id: 'weave-user-question-host', order: 2 },
            UserQuestionModal,
        ))
        diag('overlay register ok')
    } catch (error) {
        diag('overlay FAILED', { error: error instanceof Error ? error.message : String(error) })
    }

    // D3：主区切换
    try {
        diag('D3 register start', { slot: SLOT_D3 })
        slots.inject(SLOT_D3, () => {
            diag('D3 inject callback fired')
            return slots.register(
                {
                    name: SLOT_D3,
                    id: 'weave-dashboard',
                    label: () => 'Weave 看板',
                    order: 10,
                },
                WeaveDashboardView,
            )
        })
        diag('D3 inject call ok')
    } catch (error) {
        diag('D3 FAILED', { error: error instanceof Error ? error.message : String(error) })
    }

    // ★ 问题一步骤3：订阅全局 SSE，捕获新图启动（graph-start）→ 广播自定义事件
    try {
        diag('global SSE subscribe start')
        const es = new EventSource('/api/weave/stream')
        es.onmessage = (msg) => {
            try {
                const evt = JSON.parse(msg.data) as { event_type?: string; trace_id?: string; data?: { taskId?: string; pauseReason?: string; error?: string; reason?: string } }
                if (evt.event_type === 'task-proposed' && evt.data?.taskId) {
                    diag('task-proposed captured', { taskId: evt.data.taskId })
                    window.dispatchEvent(new CustomEvent('weave:task-proposed', { detail: { taskId: evt.data.taskId } }))
                    // PR-5.6 best-effort：宿主 Slots 支持 activate 时自动打开看板
                    try {
                        const s = slots as SlotsLike & { activate?: (slot: string, id: string, opts?: unknown) => void }
                        if (s?.activate) s.activate('conversation.view', 'weave-dashboard', { taskId: evt.data.taskId })
                    } catch {
                        // 降级：看板内 WeaveEditPanel 抽屉
                    }
                    return
                }
                if (evt.event_type === 'graph-paused' && evt.data?.pauseReason) {
                    const reason = evt.data.pauseReason
                    if (reason === 'awaiting-user' || reason === 'approval-pending' || reason === 'environment-gate') {
                        const text = (evt.data as { error?: string; reason?: string }).error
                            ?? (evt.data as { reason?: string }).reason
                            ?? `图已暂停（${reason}），需要你的确认`
                        window.dispatchEvent(new CustomEvent('weave:user-question', {
                            detail: { graphId: evt.trace_id, question: { text } },
                        }))
                    }
                    return
                }
                if (evt.event_type !== 'graph-start') return
                const graphId = evt.trace_id
                if (!graphId) return
                diag('graph-start captured', { graphId })
                window.dispatchEvent(new CustomEvent('weave:graph-started', { detail: { graphId } }))
            } catch {
                // 忽略解析失败
            }
        }
        es.onerror = () => {
            // EventSource 自动重连
        }
        ctx.effect(() => () => es.close())
        diag('global SSE subscribe ok')
    } catch (error) {
        diag('global SSE FAILED', { error: error instanceof Error ? error.message : String(error) })
    }

    // 问题三 D3：空闲告警浏览器 Notification 权限（可选，默认不打扰）
    try {
        if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
            void Notification.requestPermission()
        }
    } catch {
        // 权限请求失败忽略
    }

    diag('apply done')
}