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
    let abortHandler: (() => void) | null = null

    logger.info('weave-subagent-waiter', '开始等待', {
      childId,
      hasSignal: !!opts.signal,
      idleWarningMs: opts.idleWarningMs ?? 600_000,
    })

    function settle(fn: () => void): void {
      if (settled) return
      settled = true
      if (idleCheckTimer) clearInterval(idleCheckTimer)
      dispose()
      // ★ Bugs-V1 §9.2：摘除 abort listener（防泄漏）
      if (abortHandler && opts.signal) {
        opts.signal.removeEventListener('abort', abortHandler)
        abortHandler = null
      }
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
      // ★ v2 问题4 修法2：stopReason 非 completed → reject（不 resolve，避免假完成继续下游）
      onEnd: (payload) => {
        if (payload.stopReason !== 'completed') {
          logger.warn('weave-subagent-waiter', '子代理非正常结束', {
            childId,
            stopReason: payload.stopReason,
            outputBlocks: payload.output.length,
          })
          settle(() => reject(new Error(`子代理异常结束: stopReason=${payload.stopReason}（输出 ${payload.output.length} 块）`)))
          return
        }
        logger.info('weave-subagent-waiter', '子代理正常完成', { childId, outputBlocks: payload.output.length })
        settle(() => resolve(payload))
      },
      onError: (error) => {
        logger.warn('weave-subagent-waiter', '子代理错误', { childId, error: String(error) })
        settle(() => reject(error))
      },
    })

    // ─── 用户中止：interrupt 子代理（A4/A5）→ 按 reason 分流 ───
    if (opts.signal) {
      abortHandler = () => {
        const reason = (opts.signal as AbortSignal).reason
        const reasonStr = reason instanceof Error
          ? `${reason.constructor.name}: ${reason.message}`
          : String(reason)
        // ★ v2 问题3 修法3：abort 日志
        logger.info('weave-subagent-waiter', '⚡ 收到 abort 信号', { childId, reason: reasonStr })

        const parent = opts.parentAgent
        if (parent !== undefined) {
          interruptSubagent(ctx, childId, parent)
            .then(() => logger.info('weave-subagent-waiter', 'interrupt 已调用', { childId }))
            .catch((err) => logger.warn('weave-subagent-waiter', 'interrupt 失败', {
              childId,
              error: err instanceof Error ? err.message : String(err),
            }))
        } else {
          logger.warn('weave-subagent-waiter', '无 parentAgent，无法 interrupt，等待自然结束', { childId })
        }
        // ★ Bugs-V1 §9.2：分流——PauseError → 暂停（可恢复）；其他 → 终止
        if (reason instanceof PauseError) {
          settle(() => reject(reason))
        } else {
          const msg = reason instanceof Error ? reason.message : String(reason)
          settle(() => reject(new Error(`用户终止: ${msg}`)))
        }
      }
      opts.signal.addEventListener('abort', abortHandler, { once: true })
    } else {
      logger.warn('weave-subagent-waiter', '无 signal（无法暂停/终止此节点）', { childId })
    }

    scheduleIdleCheck()
  })
}
