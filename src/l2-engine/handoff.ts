/**
 * handoff 四字段交接协议（MVP-3 P3.C.2）。
 *
 * 交接物四字段：summary / artifacts / openIssues / provenance。
 * - summary：给下游的紧凑摘要
 * - artifacts：产出物引用（art:// 或路径）
 * - openIssues：遗留问题/待下游处理项
 * - provenance：来源追踪（角色/节点/时间/版本）
 */
export interface Handoff {
  /** 给下游的紧凑摘要。 */
  summary: string
  /** 产出物引用列表（art:// 或路径）。 */
  artifacts: string[]
  /** 遗留问题/待处理项。 */
  openIssues: string[]
  /** 来源追踪。 */
  provenance: {
    roleId: string
    nodeId: string
    at: number
    graphId: string
    graphVersion: string
  }
}

/** 从 TaskNode + 执行上下文构造 handoff（缺省空值安全）。 */
export function createHandoff(input: {
  summary: string
  artifacts?: string[]
  openIssues?: string[]
  roleId: string
  nodeId: string
  graphId: string
  graphVersion: string
}): Handoff {
  return {
    summary: input.summary,
    artifacts: input.artifacts ?? [],
    openIssues: input.openIssues ?? [],
    provenance: {
      roleId: input.roleId,
      nodeId: input.nodeId,
      at: Date.now(),
      graphId: input.graphId,
      graphVersion: input.graphVersion,
    },
  }
}

/** 校验 handoff 结构完整性（四字段齐全、类型正确）。 */
export function isValidHandoff(h: unknown): h is Handoff {
  if (typeof h !== 'object' || h === null) return false
  const x = h as Record<string, unknown>
  return (
    typeof x.summary === 'string' &&
    Array.isArray(x.artifacts) &&
    Array.isArray(x.openIssues) &&
    typeof x.provenance === 'object' &&
    x.provenance !== null &&
    typeof (x.provenance as Record<string, unknown>).roleId === 'string'
  )
}

/** 拼接 handoff 为紧凑文本（供下游 prompt 注入）。 */
export function handoffToText(h: Handoff): string {
  const lines = [
    `【交接：${h.provenance.roleId}】`,
    `摘要：${h.summary}`,
    `产物：${h.artifacts.join(', ') || '（无）'}`,
    `遗留：${h.openIssues.join('; ') || '（无）'}`,
  ]
  return lines.join('\n')
}
