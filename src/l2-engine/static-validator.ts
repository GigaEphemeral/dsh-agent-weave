/**
 * 图静态验证器（MVP-2 T3）。
 *
 * 在图 DSL 加载后执行深度验证，毫秒级返回，零 Token（RES.10 §二.5）：
 *   ① roleRef 必须已注册
 *   ② cond 边的 when 表达式引用的状态字段必须在白名单内
 *   ③ 所有节点从 entryPoint 可达（BFS）
 *   ④ 环检测（Kahn 算法 + id 排序 frontier 得确定性拓扑序）；loop 边不算环
 *   ⑤ 自环边只允许 loop 类型（Schema 已做，二次确认）
 */
import type { GraphDefinitionSpec } from './types.js'

export interface ValidationResult {
  valid: boolean
  errors: Array<{ path: string; message: string }>
}

/** 状态字段白名单（用于 when 表达式校验）。 */
export const STATE_FIELDS = new Set([
  'messages',
  'current_phase',
  'active_agent',
  'task_queue',
  'artifacts',
  'quality_gate_status',
  'retry_count',
  'max_iterations',
])

export interface ValidatorContext {
  /** 已注册角色名集合（来自 ctx.subagents.list() 或显式注入）。 */
  registeredRoles: Set<string>
}

/** 校验图定义（不抛错，收集全部错误）。 */
export function validateGraph(spec: GraphDefinitionSpec, ctx: ValidatorContext): ValidationResult {
  const errors: Array<{ path: string; message: string }> = []

  // ① roleRef 必须已注册
  for (const node of spec.nodes) {
    if (node.nodeType === 'role' && node.roleRef) {
      if (!ctx.registeredRoles.has(node.roleRef)) {
        errors.push({
          path: `nodes.${node.id}.roleRef`,
          message: `角色未注册: ${node.roleRef}`,
        })
      }
    }
  }

  // ② cond 边的 when 引用字段必须在白名单；parallel 边 MVP-2 不支持（M11 修复）
  for (const edge of spec.edges) {
    if (edge.type === 'parallel') {
      errors.push({
        path: `edges.${edge.from}->${edge.to}`,
        message: 'parallel 边 MVP-2 不支持（并行分支留待 MVP-3）',
      })
    }
    if (edge.type === 'cond' && edge.when) {
      for (const field of extractFields(edge.when)) {
        if (!STATE_FIELDS.has(field)) {
          errors.push({
            path: `edges.${edge.from}->${edge.to}.when`,
            message: `引用了未知状态字段: ${field}`,
          })
        }
      }
    }
  }

  // ③ 入口可达性（BFS）
  const reachable = computeReachable(spec.entryPoint, spec.edges)
  for (const node of spec.nodes) {
    if (!reachable.has(node.id)) {
      errors.push({
        path: `nodes.${node.id}`,
        message: '节点从 entryPoint 不可达',
      })
    }
  }

  // ④ 环检测（Kahn + 确定性拓扑序；loop 边不算环）
  const cycleResult = detectCycles(spec.nodes, spec.edges)
  if (cycleResult.hasCycle) {
    for (const nodeId of cycleResult.cycleNodes) {
      errors.push({
        path: `nodes.${nodeId}`,
        message: '节点处于非 loop 环中（Kahn 检测）',
      })
    }
  }

  // ⑤ 自环边只允许 loop 类型（Schema 已做，二次确认）
  for (const edge of spec.edges) {
    if (edge.from === edge.to && edge.type !== 'loop') {
      errors.push({
        path: `edges.${edge.from}->${edge.to}`,
        message: '自环边只允许 loop 类型',
      })
    }
  }

  return { valid: errors.length === 0, errors }
}

/** 从条件表达式提取 `state.xxx` 字段名。 */
export function extractFields(expr: string): string[] {
  const fields: string[] = []
  const regex = /state\.(\w+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(expr)) !== null) {
    const field = match[1]
    if (field !== undefined) fields.push(field)
  }
  return fields
}

/** 从入口计算可达节点（BFS）。 */
export function computeReachable(entry: string, edges: Array<{ from: string; to: string }>): Set<string> {
  const reachable = new Set<string>([entry])
  const queue = [entry]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    for (const edge of edges) {
      if (edge.from === current && !reachable.has(edge.to)) {
        reachable.add(edge.to)
        queue.push(edge.to)
      }
    }
  }
  return reachable
}

/**
 * 环检测（Kahn 算法 + id 排序 frontier 得确定性拓扑序）。
 *
 * 注意：loop 边是合法的环（有 maxIter 兜底），不视为错误；
 * 只有非 loop 边的环才是错误。
 */
export function detectCycles(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string; type: string }>,
): { hasCycle: boolean; cycleNodes: string[] } {
  const nonLoopEdges = edges.filter((e) => e.type !== 'loop')

  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  for (const node of nodes) {
    inDegree.set(node.id, 0)
    adjacency.set(node.id, [])
  }

  for (const edge of nonLoopEdges) {
    adjacency.get(edge.from)?.push(edge.to)
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
  }

  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }
  queue.sort()

  const visited: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    visited.push(current)
    for (const next of adjacency.get(current) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, deg)
      if (deg === 0) {
        queue.push(next)
        queue.sort()
      }
    }
  }

  if (visited.length !== nodes.length) {
    const visitedSet = new Set(visited)
    const cycleNodes = nodes.map((n) => n.id).filter((id) => !visitedSet.has(id))
    return { hasCycle: true, cycleNodes }
  }
  return { hasCycle: false, cycleNodes: [] }
}
