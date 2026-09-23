/**
 * 观察者 L2 静默观察（MVP-3 P3.D.1）。
 *
 * 文件观察优先（git diff / 读取产出），按关注级别发 GREEN/YELLOW/RED 信号。
 * 只读、非阻塞、fail-open；超预算降级为 L1（不发信号）。
 */
import type { ObserverSignal } from '../observers/signal.js'
import { createObserverSignal } from '../observers/signal.js'

export type L2SignalLevel = 'green' | 'yellow' | 'red'

export interface L2CheckResult {
  level: L2SignalLevel
  findings: string[]
  /** 是否触发了信号（yellow/red）。 */
  signaled: boolean
}

export interface L2Criteria {
  /** 关注项：子串命中即关注（如 "TODO"、"FIXME"）。 */
  concernKeywords: string[]
  /** 文件大小上限（KB），超限记 yellow。 */
  maxKb?: number
}

export interface L2Observer {
  /** 观察一个文件（读内容 + 关键词/大小检查），返回信号。 */
  observe(_filePath: string, content: string, criteria: L2Criteria): L2CheckResult
  /** 构造 ObserverSignal（供引擎/总线消费）。 */
  toSignal(input: {
    observerId: string
    observedNode: string
    result: L2CheckResult
    summary: string
  }): ObserverSignal
}

const DEFAULT_CRITERIA: L2Criteria = { concernKeywords: [], maxKb: 1024 }

/** 创建 L2 观察器（纯函数，零 LLM）。 */
export function createL2Observer(): L2Observer {
  return {
    observe(_filePath: string, content: string, criteria) {
      const c = { ...DEFAULT_CRITERIA, ...criteria }
      const findings: string[] = []
      // 关键词命中
      for (const kw of c.concernKeywords) {
        if (kw && content.includes(kw)) findings.push(`命中关注关键词 "${kw}"`)
      }
      // 大小检查
      const kb = Buffer.byteLength(content, 'utf8') / 1024
      if (c.maxKb !== undefined && kb > c.maxKb) findings.push(`文件超限 ${kb.toFixed(0)}KB > ${c.maxKb}KB`)

      if (findings.length === 0) return { level: 'green', findings, signaled: false }
      // 有关注项 → yellow（默认）；红色需显式规则（MVP-3 用 yellow 标记）
      return { level: 'yellow', findings, signaled: true }
    },
    toSignal(input) {
      // P4.0.13：信号统一走 createObserverSignal（P2-3 消除内联类型漂移）
      return createObserverSignal({
        observer_id: input.observerId,
        observed_node: input.observedNode,
        signal_level: input.result.level,
        criteria_matched: input.result.findings,
        summary: input.summary,
      })
    },
  }
}
