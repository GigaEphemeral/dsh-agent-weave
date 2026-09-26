/**
 * 画布纯模型（MVP-5 Phase C，可单测；MVP-5B ui修复2：EditorEdge/cond-loop）。
 *
 * - layoutNodes：按 seq 边分层布局
 * - buildGraphSpec：节点/边 → ClientGraphSpec（DSL 导出，支持 seq/cond/loop）
 * 注意：effectiveRole（角色+节点合并）在 host 侧（l4-visual/host/effective-role.ts），
 * 因为 client 的 rootDir 是 src/client，不能引用 shared/types。
 */
import type { ClientGraphSpec } from '../types'

export const NODE_W = 140
export const NODE_H = 48
export const COL_X = 40
export const ROW_Y = 24

export type ProducedKind = 'doc' | 'code' | 'test' | 'script' | 'config' | 'data'

/** 产出项（角色 produces / 节点 override.produces）。 */
export interface ProduceItem {
  kind: ProducedKind
  name: string
  contract?: string
}

/** 消费项（角色 input.consumes / 节点 override.consumes）。 */
export interface ConsumeItem {
  kind: string
  name: string
  from?: string
}

/** L3 节点级覆盖（三态：undefined 继承 / [] 清空 / [...] 覆盖；能力只能减不能加）。 */
export interface NodeOverride {
  produces?: ProduceItem[]
  consumes?: ConsumeItem[]
  capabilities?: string[]
  tools?: string[]
  modelOverride?: string
  inputGate?: string[]
  approval?: boolean
  promptTemplate?: string
}

export interface EditorNode {
  id: string
  roleRef: string
  roleName: string
  x: number
  y: number

  /** L3：本项目覆盖（三态语义）。 */
  override?: NodeOverride

  /** 运行时（引擎回填，前端只读）。 */
  status?: 'idle' | 'waiting' | 'running' | 'completed' | 'failed'
  activity?: { text: string; icon: string }
  metrics?: { startedAt?: number; endedAt?: number; tokensIn?: number; tokensOut?: number }
  artifacts?: Array<{ name: string; size: number; generated: boolean }>

  // 兜底（不推荐，兼容旧数据）
  modelOverride?: string
  inputGate?: string
  approval?: boolean
  onlyMarkdown?: boolean
  /** MVP-5B B6：产物文件名（缺省 <nodeId>.md）。 */
  artifactName?: string
}

/** 画布边（支持 seq/cond/loop）。 */
export interface EditorEdge {
  id: string
  from: string
  to: string
  type: 'seq' | 'cond' | 'loop'
  when?: string
  maxIter?: number
}

/** 按 seq 边分层布局（同层节点竖直排布；无连线时保持原有网格 x/y）。 */
export function layoutNodes(nodes: EditorNode[], edges: EditorEdge[]): EditorNode[] {
  // ★ 无连线：保持节点原有 x/y（不清算 level，避免全竖排）
  if (edges.length === 0) return nodes.map((n) => ({ ...n }))
  const seqEdges = edges.filter((e) => e.type === 'seq')
  if (seqEdges.length === 0) return nodes.map((n) => ({ ...n }))

  const out = new Map<string, EditorEdge[]>()
  for (const e of seqEdges) {
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

/** 节点/边 → ClientGraphSpec（含 entryPoint / maxIterations；边支持 seq/cond/loop）。 */
export function buildGraphSpec(nodes: EditorNode[], edges: EditorEdge[]): ClientGraphSpec {
  return {
    entryPoint: nodes[0]?.id ?? '',
    maxIterations: 25,
    nodes: nodes.map((n) => ({
      id: n.id,
      roleRef: n.roleRef,
      nodeType: 'role',
      ...(n.artifactName !== undefined && n.artifactName.trim() !== '' ? { artifactName: n.artifactName.trim() } : {}),
      ...(n.inputGate !== undefined && n.inputGate.trim() !== '' ? { inputGate: { requires: n.inputGate.split(/[,，]/).map((x) => x.trim()).filter(Boolean) } } : {}),
      ...(n.override !== undefined ? { override: n.override } : {}),
    })),
    edges: edges.map((e) => ({
      from: e.from,
      to: e.to,
      type: e.type,
      ...(e.when !== undefined ? { when: e.when } : {}),
      ...(e.maxIter !== undefined ? { maxIter: e.maxIter } : {}),
    })),
  }
}
