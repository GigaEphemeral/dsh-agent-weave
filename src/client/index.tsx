import type { Context } from '@deepseek-ai/cordis'
import { WeaveDashboardButton } from './dashboard/WeaveDashboardButton.js'
import { WeaveDashboardView } from './dashboard/WeaveDashboardView.js'

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

    diag('apply done')
}