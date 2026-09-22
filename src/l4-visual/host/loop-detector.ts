/**
 * 死循环/停滞告警（MVP-2 T14）。
 *
 * 3 类告警：
 * - 边级循环告警：某条 loop 边达到 maxIter 的 80%
 * - 全局迭代告警：iteration 达到 maxIterations 的 80%
 * - 熔断告警：达到 maxIter 或 maxIterations
 *
 * 订阅事件总线，触发时返回告警消息（由终端视图/HTML 呈现）。
 */
import type { GraphEventBus, ExecutionSnapshot } from './event-bus.js'

/** 告警级别。 */
export type AlertLevel = 'warn' | 'critical'

/** 告警。 */
export interface LoopAlert {
  level: AlertLevel
  kind: 'edge-loop' | 'global-iteration' | 'circuit-break'
  message: string
  timestamp: number
}

export interface LoopDetector {
  /** 检查当前快照，返回新触发的告警。 */
  check(snap: ExecutionSnapshot): LoopAlert[]
  /** 订阅总线自动检查。 */
  start(bus: GraphEventBus, onAlert: (alert: LoopAlert) => void): () => void
  getAlerts(): LoopAlert[]
}

/** 阈值比例（80%）。 */
const WARN_RATIO = 0.8

/** 创建告警检测器。 */
export function createLoopDetector(): LoopDetector {
  const alerts: LoopAlert[] = []
  const emitted = new Set<string>()

  function check(snap: ExecutionSnapshot): LoopAlert[] {
    const fresh: LoopAlert[] = []
    const now = Date.now()

    // 全局迭代告警：iteration >= 80% maxIterations
    if (snap.maxIterations > 0 && snap.iteration >= snap.maxIterations * WARN_RATIO && snap.iteration < snap.maxIterations) {
      const key = `global:${snap.iteration}`
      if (!emitted.has(key)) {
        emitted.add(key)
        const alert: LoopAlert = {
          level: 'warn',
          kind: 'global-iteration',
          message: `⚠ 全局迭代已达 ${snap.iteration}/${snap.maxIterations}（80%），疑似循环`,
          timestamp: now,
        }
        alerts.push(alert)
        fresh.push(alert)
      }
    }

    // 全局熔断告警
    if (snap.maxIterations > 0 && snap.iteration >= snap.maxIterations) {
      const key = 'global:break'
      if (!emitted.has(key)) {
        emitted.add(key)
        const alert: LoopAlert = {
          level: 'critical',
          kind: 'circuit-break',
          message: `✗ 全局迭代熔断：已达上限 ${snap.maxIterations}，执行终止`,
          timestamp: now,
        }
        alerts.push(alert)
        fresh.push(alert)
      }
    }

    // 边级循环告警：retry_count 达 maxRetry 的 80%
    if (snap.maxRetry > 0 && snap.retryCount >= snap.maxRetry * WARN_RATIO && snap.retryCount < snap.maxRetry) {
      const key = `edge:${snap.retryCount}`
      if (!emitted.has(key)) {
        emitted.add(key)
        const alert: LoopAlert = {
          level: 'warn',
          kind: 'edge-loop',
          message: `⚠ 循环回退已达 ${snap.retryCount}/${snap.maxRetry}（80%）`,
          timestamp: now,
        }
        alerts.push(alert)
        fresh.push(alert)
      }
    }

    // 边级熔断告警
    if (snap.maxRetry > 0 && snap.retryCount >= snap.maxRetry) {
      const key = 'edge:break'
      if (!emitted.has(key)) {
        emitted.add(key)
        const alert: LoopAlert = {
          level: 'critical',
          kind: 'circuit-break',
          message: `✗ 循环熔断：retry 已达上限 ${snap.maxRetry}，升级/终止`,
          timestamp: now,
        }
        alerts.push(alert)
        fresh.push(alert)
      }
    }

    return fresh
  }

  return {
    check,
    start(bus, onAlert) {
      return bus.subscribe(() => {
        const fresh = check(bus.getSnapshot())
        for (const a of fresh) onAlert(a)
      })
    },
    getAlerts() {
      return [...alerts]
    },
  }
}
