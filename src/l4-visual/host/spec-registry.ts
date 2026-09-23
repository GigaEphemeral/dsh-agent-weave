/**
 * 图规格注册表（MVP-4 P4.A.4）。
 *
 * 运行中的图 → (spec, roleMap, artifactsRoot) 映射，供 REST /spec、/activity 读取。
 * 单图模式：registerGraph 覆盖旧条目（保留最近运行）。
 */
import type { GraphDefinitionSpec } from '../../l2-engine/types.js'

export interface RegisteredGraph {
  spec: GraphDefinitionSpec
  roleMap: Record<string, string>
  artifactsRoot: string
}

const registry = new Map<string, RegisteredGraph>()

export function registerGraph(graphId: string, entry: RegisteredGraph): void {
  registry.set(graphId, entry)
}

export function getGraph(graphId: string): RegisteredGraph | undefined {
  return registry.get(graphId)
}

export function unregisterGraph(graphId: string): void {
  registry.delete(graphId)
}

/** 已注册 graphId 列表（倒序：最近的在前）。 */
export function listGraphs(): string[] {
  return [...registry.keys()].reverse()
}
