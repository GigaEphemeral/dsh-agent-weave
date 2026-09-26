/**
 * 角色 × 节点覆盖合并（ui修复2 §3.3）。
 *
 * L3 节点覆盖三态：undefined 完全继承 / [] 显式清空 / [...] 覆盖。
 * 能力约束红线：**只能减不能加**（不能开启角色没有的能力）。
 */
import type { RoleDefinition } from '../../shared/types.js'

/** 节点覆盖的最小形态（host 侧；与 client NodeOverride 字段对齐）。 */
export interface NodeOverrideInput {
  produces?: Array<{ kind: string; name: string; contract?: string }>
  consumes?: Array<{ kind: string; name: string; from?: string }>
  capabilities?: string[]
  tools?: string[]
  inputGate?: string[]
  approval?: boolean
  promptTemplate?: string
}

/** 交集：只保留角色本来就有、且本节点允许的（能力只能减不能加）。 */
function intersect(roleList: readonly string[], nodeList: readonly string[] | undefined): string[] {
  if (nodeList === undefined) return [...roleList]
  return nodeList.filter((c) => roleList.includes(c))
}

/** 合法 produces kind。 */
const PRODUCED_KINDS = new Set(['doc', 'code', 'test', 'script', 'config', 'data'])

function toProduce(item: { kind: string; name: string; contract?: string }): NonNullable<RoleDefinition['produces']>[number] | null {
  if (!PRODUCED_KINDS.has(item.kind)) return null
  return {
    kind: item.kind as 'doc' | 'code' | 'test' | 'script' | 'config' | 'data',
    name: item.name,
    ...(item.contract !== undefined ? { contract: item.contract } : {}),
  }
}

/**
 * 节点 + 角色 → 有效配置（引擎跑的时候用这个）。
 * 合并结果只做减法：capabilities/tools 取交集；produces/consumes 三态。
 */
export function effectiveRole(role: RoleDefinition, node: NodeOverrideInput): RoleDefinition {
  const hasOverride = Object.keys(node).length > 0
  if (!hasOverride) return role

  const result: RoleDefinition = {
    ...role,
    // ★ 能力只能减不能加
    capabilities: intersect(role.capabilities, node.capabilities),
    tools: intersect(role.tools, node.tools),
  }

  // produces：三态（undefined 继承 / [] 清空 / [...] 覆盖）
  if (node.produces !== undefined) {
    const produces = node.produces.map(toProduce).filter((x): x is NonNullable<typeof x> => x !== null)
    result.produces = produces
  }

  // input（requires/consumes）：三态
  if (node.inputGate !== undefined || node.consumes !== undefined) {
    result.input = {
      requires: node.inputGate ?? role.input?.requires ?? [],
      consumes: node.consumes ?? role.input?.consumes ?? [],
    }
  }

  return result
}
