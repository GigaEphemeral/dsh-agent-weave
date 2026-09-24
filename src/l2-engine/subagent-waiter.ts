/**
 * 子代理等待器（问题三 A2/A3/A4+A5/D2/D3，超时重设计）。
 *
 * 核心原则：**无硬超时**。只响应三种退出：
 *   1. subagent/end    → resolve（正常完成）
 *   2. subagent/error  → reject（底层报错）
 *   3. signal.abort()  → interrupt 子代理 + reject(PauseError)（用户暂停）
 *
 * 空闲/循环只提示，不中止（避免把"慢任务"误判为"卡死"）。
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  subscribeSubagentEvents,
  interruptSubagent,
} from './subagent-events.js'
import type { SubagentActivity, SubagentEndPayload } from './subagent-events.js'
import { logger } from '../shared/logger.js'

export type { SubagentActivity, SubagentEndPayload } from './subagent-events.js'

/** 用户主动暂停信号。 */
export class PauseError extends Error {
  constructor(public readonly childId: string) {
    super(`用户暂停：${childId}`)
    this.name = 'PauseError'
  }
}

export interface WaitOptions {
  /** 空闲提示阈值（毫秒，0 = 不提示；默认 10 分钟）。 */
  idleWarningMs?: number
  onIdleWarning?: (idleMs: number) => void
  /** 循环检测配置（默认开启）。 */
  loopDetection?: {
    enabled: boolean
    window: number
    repeatThreshold: number
  }
  onLoopDetected?: (tool: string, repeatCount: number) => void
  onActivity?: (activity: SubagentActivity) => void
  /** 用户中止信号（中止 → interrupt 子代理 + reject PauseError）。 */
  signal?: AbortSignal
  /** 父 Agent（用于 interrupt authority）。 */
  parentAgent?: unknown
}

export function waitForSubagentEnd(
  ctx: Context,
  childId: string,
  opts: WaitOptions = {},
): Promise<SubagentEndPayload> {
  return new Promise((resolve, reject) => {
    let lastActivityAt = Date.now()
    let idleWarningFired = false
    let idleCheckTimer: NodeJS.Timeout | null = null
    let loopDetected = false
    const recentCalls: Array<{ key: string; at: number }> = []
    let settled = false

    function settle(fn: () => void): void {
      if (settled) return
      settled = true
      if (idleCheckTimer) clearInterval(idleCheckTimer)
      dispose()
      fn()
    }

    // ─── 空闲检查（只提示，不中止）───
    function scheduleIdleCheck(): void {
      const threshold = opts.idleWarningMs ?? 600_000
      if (!threshold) return
      idleCheckTimer = setInterval(() => {
        const idleMs = Date.now() - lastActivityAt
        if (idleMs >= threshold && !idleWarningFired) {
          idleWarningFired = true
          logger.warn('weave-addsubagent', '子代理长时间无活动（仅提示，不中止）', { childId, idleMs })
          opts.onIdleWarning?.(idleMs)
        }
      }, 30_000)
    }

    // ─── 活动处理 ───
    function handleActivity(activity: SubagentActivity): void {
      lastActivityAt = Date.now()
      idleWarningFired = false

      const ld = opts.loopDetection
      if (ld?.enabled !== false && activity.kind === 'tool-call') {
        const key = `${activity.tool}:${activity.args ?? ''}`
        recentCalls.push({ key, at: Date.now() })
        const window = ld?.window ?? 10
        if (recentCalls.length > window) recentCalls.shift()
        const counts = new Map<string, number>()
        for (const c of recentCalls) counts.set(c.key, (counts.get(c.key) ?? 0) + 1)
        const maxRepeat = Math.max(...counts.values(), 0)
        const threshold = ld?.repeatThreshold ?? 5
        if (maxRepeat >= threshold && !loopDetected) {
          loopDetected = true
          logger.warn('weave-addsubagent', '检测到循环调用（仅提示）', { childId, tool: activity.tool, repeatCount: maxRepeat })
          opts.onLoopDetected?.(activity.tool ?? '', maxRepeat)
        }
      }

      opts.onActivity?.(activity)
    }

    // ─── 订阅事件 ───
    const dispose = subscribeSubagentEvents(ctx, childId, {
      onActivity: handleActivity,
      onEnd: (payload) => settle(() => resolve(payload)),
      onError: (error) => settle(() => reject(error)),
    })

    // ─── 用户中止：interrupt 子代理（A4/A5）→ reject PauseError ───
    opts.signal?.addEventListener('abort', () => {
      logger.info('weave-addsubagent', '收到用户中止信号，interrupt 子代理', { childId })
      const parent = opts.parentAgent
      if (parent !== undefined) {
        interruptSubagent(ctx, childId, parent).catch((err) => {
          logger.warn('weave-addsubagent', 'interrupt 调用失败', {
            childId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      } else {
        logger.warn('weave-addsubagent', '无 parentAgent，无法 interrupt，等待自然结束', { childId })
      }
      settle(() => reject(new PauseError(childId)))
    }, { once: true })

    scheduleIdleCheck()
  })
}
