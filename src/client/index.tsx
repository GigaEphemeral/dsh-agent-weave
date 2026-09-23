import type { Context } from '@deepseek-ai/cordis'
import { WeaveDashboardButton } from './dashboard/WeaveDashboardButton'
import { WeaveDashboardView } from './dashboard/WeaveDashboardView'

/**
 * dsh-agent-weave Client 半端入口（MVP-4：D1 页头按钮 + D3 主区看板）。
 *
 * 挂载点（预研确认，见 docs/MVP-4/预研结论.md）：
 * - D1：conversation.session.header.actions（list，标题旁动作）
 * - D3：conversation.view（list，ViewTab 机制切换）
 *
 * slots 服务类型不在本包依赖内，做鸭子类型桥接（与 webServer 同策略）；
 * 运行期由 @deepseek-ai/dsh-client-ui-slots 提供，headless 环境缺服务时静默跳过。
 */
export const name = 'dsh-agent-weave-client'

/** slots 服务最小形态（官方 workflow-run 实证：inject 包 register）。 */
interface SlotsLike {
  inject(name: string, register: () => (() => void) | undefined): void
  register(
    options: {
      name: string
      id?: string
      key?: string
      label?: string | (() => string)
      order?: number
      priority?: number
      inject?: () => Record<string, unknown>
    },
    component: unknown,
  ): () => void
}

type ClientContext = Context & { slots?: SlotsLike }

export function apply(ctx: Context): void {
  const slots = (ctx as ClientContext).slots
  if (!slots) return

  // D1：页头按钮（常驻）
  slots.inject('conversation.session.header.actions', () =>
    slots.register({
      name: 'conversation.session.header.actions',
      id: 'weave-dashboard-toggle',
      label: () => 'Weave 看板',
      order: 0,
    }, WeaveDashboardButton),
  )
  // D3：主区切换（ViewTab；未打开时组件返回 null）
  slots.inject('conversation.view', () =>
    slots.register({
      name: 'conversation.view',
      id: 'weave-dashboard',
      label: () => 'Weave 看板',
      order: 10,
    }, WeaveDashboardView),
  )
}
