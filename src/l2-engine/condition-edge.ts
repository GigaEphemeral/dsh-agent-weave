/**
 * 条件边与循环回退（MVP-2 T7）。
 *
 * - evaluateCondition：条件表达式求值（轻量自研，受限白名单 + "use strict"）
 * - resolveNextNode：条件分叉 / 循环回退 / 终止决策
 *   · 条件边（cond/loop）优先于静态边（seq）
 *   · cond：when 求值为 true → 走该边
 *   · loop：边级 maxIter 未用尽 → 回退；用尽 → 升级审批 / __END__
 *   · 无出边 → __END__
 * - shouldRetry / shouldEscalate：基于 retry_count 与 max_iterations
 */
import type { GraphDefinitionSpec } from './types.js'

/** 条件表达式求值失败。 */
export class ConditionEvalError extends Error {
  constructor(
    message: string,
    public override readonly cause?: Error,
  ) {
    super(message)
    this.name = 'ConditionEvalError'
  }
}

/**
 * 求值条件表达式（`state.xxx` 替换为实际值后，在受限白名单内用 Function 求值）。
 *
 * 白名单策略：先把字符串字面量替换为安全占位（`"x"`），其余只允许
 * 数字/操作符/布尔/null/括号/逗号/引号/空白——任意标识符（如 `process`）会被拒绝。
 */
export function evaluateCondition(expr: string, state: Record<string, unknown>): boolean {
  // ① 字段替换：state.xxx → JSON.stringify 值
  const replaced = expr.replace(/state\.(\w+)/g, (_, field: string) => {
    const value = state[field]
    return JSON.stringify(value)
  })

  // ② 白名单校验：字符串字面量先归一为 "0"（内容本身不参与校验）
  const checkable = replaced.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '"0"')
  if (!/^[\s\d+\-*/<>=!&|(),.'"]*$/.test(checkable)) {
    throw new ConditionEvalError(`条件表达式包含非法字符: ${expr}`)
  }

  // ③ 受限 Function 求值
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${replaced});`)
    return Boolean(fn())
  } catch (error) {
    throw new ConditionEvalError(
      `条件表达式求值失败: ${expr}`,
      error instanceof Error ? error : undefined,
    )
  }
}

/** 循环状态（用于 shouldRetry / shouldEscalate）。 */
export interface LoopState {
  retry_count: number
  max_iterations: number
}

/** 未达迭代上限 → 应回退重试。 */
export function shouldRetry(state: LoopState): boolean {
  return state.retry_count < state.max_iterations
}

/** 已达迭代上限 → 应升级（走审批）。 */
export function shouldEscalate(state: LoopState): boolean {
  return state.retry_count >= state.max_iterations
}

/** loop 边已回退次数（键：`from->to`）。 */
export type LoopEdgeUsage = Record<string, number>

/** 边键。 */
export function edgeKey(from: string, to: string): string {
  return `${from}->${to}`
}

/**
 * 决定下一节点（RES.10 §一.1：条件边优先于静态边；`__END__` + 无出边即终止）。
 *
 * @param current 当前节点
 * @param edges 全部边
 * @param state 当前状态（cond when 求值 + retry 判断）
 * @param loopUsage loop 边已回退次数（边级熔断，T9 引擎维护）
 * @returns 下一节点名或 '__END__'
 */
export function resolveNextNode(
  current: string,
  edges: GraphDefinitionSpec['edges'],
  state: Record<string, unknown>,
  loopUsage: LoopEdgeUsage = {},
): string | '__END__' {
  const outgoing = edges.filter((e) => e.from === current)
  if (outgoing.length === 0) return '__END__'

  const conditionalEdges = outgoing.filter((e) => e.type === 'cond' || e.type === 'loop')
  const staticEdges = outgoing.filter((e) => e.type === 'seq')

  // 条件边优先（保持声明顺序：cond 在前，loop 在后）
  for (const edge of conditionalEdges) {
    if (edge.type === 'cond' && edge.when !== undefined) {
      if (evaluateCondition(edge.when, state)) return edge.to
    } else if (edge.type === 'loop') {
      const used = loopUsage[edgeKey(edge.from, edge.to)] ?? 0
      const maxIter = edge.maxIter ?? 1
      if (used < maxIter) {
        return edge.to // 回退
      }
      // 边级用尽 → 升级：优先同源 cond 边（审批路径），否则 __END__
      const escalate = outgoing.find(
        (e) => e.from === current && e.type === 'cond' && e.to.includes('approval'),
      )
      return escalate?.to ?? '__END__'
    }
  }

  // 静态边（多条 seq 只取第一条）
  if (staticEdges.length > 0) {
    return staticEdges[0]?.to ?? '__END__'
  }

  return '__END__'
}
