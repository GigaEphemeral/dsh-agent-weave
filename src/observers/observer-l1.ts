/**
 * 观察者 L1（MVP-2 T15，RES.4 fail-open 纯函数检查）。
 *
 * 三项零 Token 检查（不调用 ctx.llm）：
 *   ① 命名规范：节点 ID 匹配 ^[a-z][a-z0-9_-]*$
 *   ② 权限：role 节点必须有 roleRef
 *   ③ 状态：retry_count 不能为负
 */
import type { GraphNodeSpec } from '../l2-engine/types.js'

export interface L1CheckResult {
  passed: boolean
  signal: 'green' | 'yellow' | 'red'
  findings: Array<{ check: string; message: string }>
}

/** 节点 ID 正则（与 T2 Schema 一致）。 */
const NODE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/

/** 执行 L1 检查（纯函数，零 Token）。 */
export function checkL1(node: GraphNodeSpec, state: Record<string, unknown>): L1CheckResult {
  const findings: L1CheckResult['findings'] = []

  // ① 命名规范
  if (!NODE_ID_PATTERN.test(node.id)) {
    findings.push({
      check: 'naming',
      message: `节点 ID 不符合命名规范: ${node.id}`,
    })
  }

  // ② 权限：role 节点必须有 roleRef
  if (node.nodeType === 'role' && !node.roleRef) {
    findings.push({
      check: 'permission',
      message: `role 节点必须有 roleRef: ${node.id}`,
    })
  }

  // ③ 状态：retry_count 不能为负
  if (typeof state.retry_count === 'number' && state.retry_count < 0) {
    findings.push({
      check: 'state',
      message: `retry_count 不能为负: ${state.retry_count}`,
    })
  }

  if (findings.length === 0) {
    return { passed: true, signal: 'green', findings: [] }
  }
  return { passed: false, signal: 'yellow', findings }
}
