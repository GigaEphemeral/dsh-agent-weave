/**
 * 画布纯模型（MVP-5 Phase C，可单测）。
 *
 * - layoutNodes：按 seq 边分层布局
 * - buildGraphSpec：节点/边 → ClientGraphSpec（DSL 导出）
 */
import type { ClientGraphSpec } from '../types'

export const NODE_W = 140
export const NODE_H = 48
export const COL_X = 40
export const ROW_Y = 24

export interface EditorNode {
  id: string
  roleRef: string
  roleName: string
  x: number
  y: number
  modelOverride?: string
  inputGate?: string
  approval?: boolean
  onlyMarkdown?: boolean
  /** MVP-5B B6：产物文件名（缺省 <nodeId>.md）。 */
  artifactName?: string
}

/** 按 seq 边分层布局（同层节点竖直排布）。 */
export function layoutNodes(nodes: EditorNode[], edges: Array<{ from: string; to: string }>): EditorNode[] {
  const out = new Map<string, Array<{ from: string; to: string }>>()
  for (const e of edges) {
    const list = out.get(e.from) ?? []
    list.push(e)
    out.set(e.from, list)
  }
  const level = new Map<string, number>()
  const assign = (id: string, l: number): void => {
    const prev = level.get(id)
    if (prev !== undefined && prev >= l) return
    level.set(id, l)
    for (const e of out.get(id) ?? []) assign(e.to, l + 1)
  }
  if (nodes.length > 0) assign(nodes[0]?.id ?? '', 0)
  for (const n of nodes) if (!level.has(n.id)) assign(n.id, 0)

  const byLevel = new Map<number, string[]>()
  for (const [id, l] of level) {
    const list = byLevel.get(l) ?? []
    list.push(id)
    byLevel.set(l, list)
  }
  return nodes.map((n) => {
    const l = level.get(n.id) ?? 0
    const idx = (byLevel.get(l) ?? []).indexOf(n.id)
    return { ...n, x: l * (NODE_W + COL_X), y: idx * (NODE_H + ROW_Y) }
  })
}

/** 节点/边 → ClientGraphSpec（含 entryPoint / maxIterations）。 */
export function buildGraphSpec(nodes: EditorNode[], edges: Array<{ from: string; to: string }>): ClientGraphSpec {
  return {
    entryPoint: nodes[0]?.id ?? '',
    maxIterations: 25,
    nodes: nodes.map((n) => ({
      id: n.id,
      roleRef: n.roleRef,
      nodeType: 'role',
      ...(n.artifactName !== undefined && n.artifactName.trim() !== '' ? { artifactName: n.artifactName.trim() } : {}),
      ...(n.inputGate !== undefined && n.inputGate.trim() !== '' ? { inputGate: { requires: n.inputGate.split(/[,，]/).map((x) => x.trim()).filter(Boolean) } } : {}),
    })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, type: 'seq' })),
  }
}
