/**
 * ProjectMemory（MVP-5B B1 重写）：仅持有最新 envelope + 按节点 envelope 索引。
 *
 * 方案 B（MVP-5planB §4.6）：从"facts 列表"升级为"持有结构化交接单 envelope"，
 * 依赖方向严格单向（E8）：handoff-schema ← handoff ← 本文件。
 *
 * 兼容层：setFact/setFacts/all/conflicts/byCategory/extractFactsFromMarkdown 保留为
 * deprecated 转发（渐进迁移，不破坏既有调用；验收 10.1#10）。
 */
import type { HandoffEnvelope, ProjectFact } from './handoff-schema.js'
import { mergeEnvelopes, buildHandoffSection } from './handoff.js'
import { parseFrontMatter } from './handoff-schema.js'

export interface ProjectMemoryOptions {
  /** 产物根目录（B2 图执行时传入；解析/展示使用）。 */
  artifactsRoot?: string
}

/** 项目事实共享层（单图实例内跨节点共享）。 */
export class ProjectMemory {
  private latest: HandoffEnvelope | null = null
  private readonly byNode = new Map<string, HandoffEnvelope>()

  constructor(private readonly opts: ProjectMemoryOptions = {}) {}

  // ─── 新 API ──────────────────────────────────────────

  /** 合并某节点的交接单到全局累积（byNode 记录原始，latest 合并后）。 */
  mergeEnvelope(nodeId: string, envelope: HandoffEnvelope): void {
    this.byNode.set(nodeId, envelope)
    this.latest = mergeEnvelopes(this.latest, envelope)
  }

  /** 合并后的全局交接单（无任何节点时为 null）。 */
  current(): HandoffEnvelope | null {
    return this.latest
  }

  /** 某节点的原始交接单（不存在返回 null）。 */
  byNodeId(nodeId: string): HandoffEnvelope | null {
    return this.byNode.get(nodeId) ?? null
  }

  /** 全部节点的原始交接单（MVP-5B B5：暂停快照序列化用）。 */
  allByNode(): ReadonlyMap<string, HandoffEnvelope> {
    return this.byNode
  }

  /** 生成下游 prompt 注入段（无交接数据时返回空串）。 */
  toPromptSection(myRole = ''): string {
    return this.latest ? buildHandoffSection(this.latest, myRole) : ''
  }

  /** 产物根目录（B2 解析 artifact 相对路径用）。 */
  get root(): string | undefined {
    return this.opts.artifactsRoot
  }

  // ─── 兼容层（保留旧 API，内部转发；deprecated） ─────────────

  /**
   * @deprecated 用 mergeEnvelope(nodeId, envelope)。
   * 空态（latest === null）自动创建空 envelope 再合并（E5）。
   */
  setFact(fact: ProjectFact): void {
    if (!this.latest) this.latest = emptyEnvelope()
    this.latest = mergeEnvelopes(this.latest, { ...this.latest, facts: [fact] })
  }

  /** @deprecated 用 mergeEnvelope。 */
  setFacts(facts: readonly ProjectFact[]): void {
    for (const f of facts) this.setFact(f)
  }

  /** @deprecated 用 current()?.facts。 */
  all(): ProjectFact[] {
    return this.latest?.facts ?? []
  }

  /** @deprecated 用 current()?.facts.filter(f => f.confidence === 'conflict')。 */
  conflicts(): ProjectFact[] {
    return (this.latest?.facts ?? []).filter((f) => f.confidence === 'conflict')
  }

  /** @deprecated 保留兼容（按 category 分组）。 */
  byCategory(): Map<string, ProjectFact[]> {
    const map = new Map<string, ProjectFact[]>()
    for (const f of this.all()) {
      const list = map.get(f.category) ?? []
      list.push(f)
      map.set(f.category, list)
    }
    return map
  }
}

/** 空 envelope（E5：空态 setFact 的起始壳）。 */
function emptyEnvelope(): HandoffEnvelope {
  return {
    schemaVersion: '1.0',
    graphId: '',
    nodeId: '',
    roleRef: '',
    at: Date.now(),
    artifacts: [],
    facts: [],
    environment: { verified: [], unmet: [] },
    openIssues: [],
    handoff: { upstream: [], downstream: [], completed: false },
  }
}

// ─── 兼容层：旧函数转发 ────────────────────────────────────

/**
 * @deprecated 用 parseFrontMatter + parseHandoffFromMarkdown。
 * 只导入 handoff-schema.js（E8：兼容层不依赖 handoff.js）。
 */
export function extractFactsFromMarkdown(content: string, source: string): ProjectFact[] {
  const fm = parseFrontMatter(content)
  if (!fm?.facts) return []
  return fm.facts.map((f) => ({ ...f, source }))
}

/** 兼容类型 re-export（旧导入路径）。 */
export type { ProjectFact, HandoffEnvelope }
/** 兼容：旧 category 枚举别名（handoff-schema 的 category 枚举）。 */
export type FactCategory = ProjectFact['category']
