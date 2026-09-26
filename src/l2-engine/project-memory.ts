/**
 * ProjectMemory + Facts 机制（MVP-5 问题 4：多角色重复探测）。
 *
 * 核心：R1 探测结论经产物 YAML front-matter 声明 → 引擎解析 → 注入下游 prompt，
 * 下游角色"已确认事实"不再重复探测。
 *
 * 冲突语义（验收 8.2#6）：后探测覆盖前探测，但标记 conflict。
 */
import { load as yamlLoad } from 'js-yaml'

export type FactCategory = 'environment' | 'api' | 'constraint' | 'file-system' | 'reference' | 'other'

export interface ProjectFact {
  /** 唯一键，如 env.python.version / api.tencent.qt.status */
  key: string
  category: FactCategory
  value: string
  confidence: 'confirmed' | 'assumed' | 'conflict'
  summary: string
  /** 来源节点/角色，如 R1-requirement */
  source: string
}

export interface FactConflict {
  key: string
  previous: ProjectFact
  current: ProjectFact
}

export interface FactRecord {
  key?: unknown
  category?: unknown
  value?: unknown
  confidence?: unknown
  summary?: unknown
}

/** 解析 Markdown 顶部 YAML front-matter 中的 facts 数组（R1 输出规范）。 */
export function extractFactsFromMarkdown(content: string, source: string): ProjectFact[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return []
  let data: unknown
  try {
    data = yamlLoad(match[1] ?? '')
  } catch {
    return []
  }
  if (!data || typeof data !== 'object' || !('facts' in data)) return []
  const list = (data as { facts?: unknown }).facts
  if (!Array.isArray(list)) return []

  const facts: ProjectFact[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rec = item as FactRecord
    if (typeof rec.key !== 'string' || rec.key === '') continue
    const category = typeof rec.category === 'string' ? rec.category as FactCategory : 'other'
    if (!['environment', 'api', 'constraint', 'file-system', 'reference', 'other'].includes(category)) continue
    facts.push({
      key: rec.key,
      category,
      value: typeof rec.value === 'string' ? rec.value : String(rec.value ?? ''),
      confidence: rec.confidence === 'assumed' || rec.confidence === 'conflict' ? rec.confidence : 'confirmed',
      summary: typeof rec.summary === 'string' ? rec.summary : '',
      source,
    })
  }
  return facts
}

/** 项目事实共享层（单图实例内跨节点共享）。 */
export class ProjectMemory {
  private readonly facts = new Map<string, ProjectFact>()
  private readonly conflictLog: FactConflict[] = []

  /** 记录事实；同 key 不同 value → 后值覆盖前值并标记 conflict。 */
  setFact(fact: ProjectFact): void {
    const prev = this.facts.get(fact.key)
    if (prev !== undefined && prev.value !== fact.value) {
      const conflictFact: ProjectFact = {
        ...fact,
        confidence: 'conflict',
        summary: fact.summary ? `${fact.summary}（与 ${prev.source} 的 "${prev.value}" 冲突）` : `与 ${prev.source} 的 "${prev.value}" 冲突`,
      }
      this.facts.set(fact.key, conflictFact)
      this.conflictLog.push({ key: fact.key, previous: prev, current: fact })
    } else {
      this.facts.set(fact.key, fact)
    }
  }

  setFacts(facts: readonly ProjectFact[]): void {
    for (const f of facts) this.setFact(f)
  }

  all(): ProjectFact[] {
    return [...this.facts.values()]
  }

  conflicts(): readonly FactConflict[] {
    return [...this.conflictLog]
  }

  byCategory(): Map<FactCategory, ProjectFact[]> {
    const map = new Map<FactCategory, ProjectFact[]>()
    for (const f of this.facts.values()) {
      const list = map.get(f.category) ?? []
      list.push(f)
      map.set(f.category, list)
    }
    return map
  }

  /** 生成下游 prompt 注入段落；无事实时返回空串。 */
  toPromptSection(): string {
    if (this.facts.size === 0) return ''
    const categoryTitle: Record<FactCategory, string> = {
      environment: '环境事实',
      api: '接口事实',
      constraint: '已知约束',
      'file-system': '文件系统事实',
      reference: '参考文档事实',
      other: '其他事实',
    }
    const lines: string[] = ['项目事实（上游已确认，请不要重复探测）：']
    for (const [category, list] of this.byCategory()) {
      lines.push(`### ${categoryTitle[category]}`)
      for (const f of list) {
        const marker = f.confidence === 'conflict' ? '!' : '✓'
        lines.push(`  ${marker} ${f.summary || f.value}  [来自 ${f.source}]`)
      }
    }
    return lines.join('\n')
  }
}
