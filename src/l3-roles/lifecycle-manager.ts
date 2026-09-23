/**
 * 子代理生命周期管理（MVP-3 P3.A.2）。
 *
 * 三模式（来自 README 风险表 + MVP-3task）：
 * - resident：常驻（热启动快，占资源）
 * - on-demand：按需启动（省资源，冷启动慢）
 * - hybrid：混合（活跃窗口内常驻，空闲回收）
 *
 * MVP-3 先提供配置定义 + 决策函数（纯逻辑，零 LLM），
 * 真实 resident 预热/回收依赖 dsh-subagent 的 continuable 能力（后续接入）。
 */
export type LifecycleMode = 'resident' | 'on-demand' | 'hybrid'

export interface LifecycleConfig {
  /** 角色生命周期模式（缺省 on-demand）。 */
  mode: LifecycleMode
  /** hybrid 模式的活跃窗口（毫秒，窗口内保持 resident）。 */
  activeWindowMs?: number
  /** resident 模式的预热角色（启动即拉起的角色列表）。 */
  prewarmRoles?: string[]
}

/** 默认生命周期配置。 */
export const DEFAULT_LIFECYCLE: LifecycleConfig = {
  mode: 'on-demand',
  activeWindowMs: 60_000,
  prewarmRoles: [],
}

/**
 * 决策角色应否预启动（resident/hybrid 且在 prewarm 列表 → 预热）。
 * 纯函数，零 LLM。
 */
export function shouldPrewarm(
  roleId: string,
  config: LifecycleConfig = DEFAULT_LIFECYCLE,
): boolean {
  if (config.mode === 'on-demand') return false
  return (config.prewarmRoles ?? []).includes(roleId)
}

/**
 * 决策角色是否处于活跃窗口（hybrid 模式：最近 activeAt 在窗口内 → 视为 resident）。
 * 纯函数，零 LLM。
 */
export function isInActiveWindow(
  activeAtMs: number | undefined,
  nowMs: number,
  config: LifecycleConfig = DEFAULT_LIFECYCLE,
): boolean {
  if (config.mode === 'resident') return true
  if (config.mode === 'on-demand') return false
  if (activeAtMs === undefined) return false
  return nowMs - activeAtMs < (config.activeWindowMs ?? 60_000)
}

/** 生命周期管理器（轻量；真实预热/回收后续接 dsh-subagent）。 */
export function createLifecycleManager(config: LifecycleConfig = DEFAULT_LIFECYCLE) {
  const lastActive = new Map<string, number>()
  return {
    /** 角色活动时记录时间戳。 */
    touch(roleId: string, nowMs = Date.now()): void {
      lastActive.set(roleId, nowMs)
    },
    /** 角色当前是否应保持常驻（resident 恒 true；hybrid 看窗口）。 */
    isResident(roleId: string, nowMs = Date.now()): boolean {
      if (config.mode === 'resident') return true
      if (config.mode === 'on-demand') return false
      return isInActiveWindow(lastActive.get(roleId), nowMs, config)
    },
    shouldPrewarm: (roleId: string) => shouldPrewarm(roleId, config),
  }
}
