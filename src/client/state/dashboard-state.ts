/**
 * 看板开关状态（MVP-4 P4.C.1）。
 *
 * D1 按钮与 D3 视图共享的模块级状态：按钮点击 → 视图渲染。
 * 用最小订阅实现（useSyncExternalStore 兼容），不引第三方状态库。
 */
import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/** 切换看板开关。 */
export function setDashboardOpen(next: boolean): void {
  if (open === next) return
  open = next
  emit()
}

/** 读取当前开关（非 hook 场景）。 */
export function isDashboardOpen(): boolean {
  return open
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** 组件内订阅看板开关。 */
export function useDashboardOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open)
}
