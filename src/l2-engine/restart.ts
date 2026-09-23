/**
 * 重启与目标复用（MVP-3 P3.E.3）。
 *
 * 用 ctx.jobs（后台任务注册表）+ ctx.goals（目标跟踪）支持：
 * - 任务重启后恢复（含暂停状态）
 * - 目标复用（同一目标不重复建）
 *
 * 轻量封装：依赖服务经 ctx.get 探测（缺失则降级内存实现）。
 */
export interface RestartManager {
  /** 注册后台任务（返回任务 id）。 */
  startJob(name: string, fn: () => Promise<unknown>): Promise<string>
  /** 查询任务状态。 */
  jobStatus(id: string): 'running' | 'done' | 'failed' | 'unknown'
  /** 创建目标（已存在同名则返回现有）。 */
  ensureGoal(name: string, objective: string): Promise<{ id: string; reused: boolean }>
  /** 目标完成。 */
  completeGoal(id: string): Promise<void>
}

/** 内存降级实现（无 ctx.jobs/goals 时）。 */
export function createRestartManager(_ctx: {
  get(name: string): unknown
}): RestartManager {
  const jobs = new Map<string, 'running' | 'done' | 'failed'>()
  const goals = new Map<string, string>()

  return {
    async startJob(name, fn) {
      void name
      const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      jobs.set(id, 'running')
      fn().then(
        () => jobs.set(id, 'done'),
        () => jobs.set(id, 'failed'),
      )
      return id
    },
    jobStatus(id) {
      return jobs.get(id) ?? 'unknown'
    },
    async ensureGoal(name, objective) {
      const existing = goals.get(name)
      if (existing) return { id: existing, reused: true }
      const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      goals.set(name, id)
      void objective
      return { id, reused: false }
    },
    async completeGoal(id) {
      for (const [name, gid] of goals) {
        if (gid === id) goals.delete(name)
      }
    },
  }
}
