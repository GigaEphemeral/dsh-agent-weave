/**
 * 节点产物验证（Bugs-V1 §8.1：结构化质量门）。
 *
 * 支持结构化 gate（QualityGate union）+ 旧字符串自动映射：
 * - non_empty / min_file_size / min_artifact_count / contains_section /
 *   no_code_fence / forbidden_phrases / require_probe_section
 * 真实文件状态（statSync 读大小/内容），非 Object.keys 计数。
 */
import { readFileSync, statSync } from 'node:fs'
import { parseHandoffComment } from './handoff-extractor.js'
import type { QualityGate } from '../shared/types.js'

export interface NodeValidationResult {
  passed: boolean
  failures: string[]
}

/** 单个产物的真实状态。 */
interface ArtifactStat {
  path: string
  exists: boolean
  bytes: number
  content: string | null
}

const MAX_READ_BYTES = 1_048_576 // 1MB 内才读内容

/** 收集产物真实文件状态。 */
function collectArtifactStats(patch: Partial<Record<string, unknown>>): ArtifactStat[] {
  const artifacts = patch.artifacts as Record<string, string> | undefined
  if (!artifacts) return []
  return Object.values(artifacts).map((path) => {
    try {
      const st = statSync(path)
      const content = st.size < MAX_READ_BYTES ? readFileSync(path, 'utf8') : null
      return { path, exists: true, bytes: st.size, content }
    } catch {
      return { path, exists: false, bytes: 0, content: null }
    }
  })
}

/** 占位短语检测（"完成"/"OK"/空）。 */
const PLACEHOLDER_PATTERNS = [
  /^[\s\n]*(完成|OK|Done|已生成|已完成)[\s。.!]*$/i,
  /（?暂无内容）?/,
  /TODO:\s*$/,
]
function isPlaceholder(text: string): boolean {
  return text.length < 100 && PLACEHOLDER_PATTERNS.some((p) => p.test(text.trim()))
}

/** 校验一个结构化 gate。 */
function checkStructuredGate(
  gate: { type: string; [k: string]: unknown },
  stats: ArtifactStat[],
  failures: string[],
): void {
  switch (gate.type) {
    case 'non_empty': {
      const ok = stats.some((s) => s.exists && s.bytes > 0 && !isPlaceholder(s.content ?? ''))
      if (!ok) failures.push('质量门未过: 产物为空或仅占位内容')
      break
    }
    case 'min_file_size': {
      const bytes = gate.bytes as number
      const ok = stats.some((s) => s.exists && s.bytes >= bytes)
      if (!ok) failures.push(`质量门未过: 产物需 ≥${bytes} 字节`)
      break
    }
    case 'min_artifact_count': {
      const n = gate.n as number
      if (stats.length < n) failures.push(`质量门未过: 需要至少 ${n} 个产物，实际 ${stats.length}`)
      break
    }
    case 'contains_section': {
      const section = gate.section as string
      const minLength = (gate.minLength as number | undefined) ?? 0
      const ok = stats.some((s) => {
        if (!s.content) return false
        const re = new RegExp(`^#{1,6}\\s+${escapeRegExp(section)}\\s*$`, 'm')
        const m = re.exec(s.content)
        if (!m) return false
        // 统计该章节到下一个 ## 之间的长度
        const after = s.content.slice((m.index ?? 0) + (m[0]?.length ?? 0))
        const nextSection = /^#{1,6}\s+/m.exec(after)
        const sectionText = nextSection ? after.slice(0, nextSection.index) : after
        return sectionText.trim().length >= minLength
      })
      if (!ok) failures.push(`质量门未过: 缺少章节 "${section}"（或长度不足 ${minLength}）`)
      break
    }
    case 'no_code_fence': {
      const langs = (gate.languages as string[] | undefined) ?? []
      const ok = stats.every((s) => {
        const content = s.content
        if (content === null) return true
        if (langs.length === 0) return !/```/.test(content)
        return !langs.some((l) => new RegExp('```\\s*' + escapeRegExp(l) + '\\b').test(content))
      })
      if (!ok) failures.push(`质量门未过: 产物含代码围栏（禁止 ${langs.join('/')} 代码）`)
      break
    }
    case 'forbidden_phrases': {
      const phrases = (gate.phrases as string[]) ?? []
      const hit = phrases.find((p) => stats.some((s) => s.content !== null && s.content.includes(p)))
      if (hit) failures.push(`质量门未过: 产物含禁止短语 "${hit}"`)
      break
    }
    case 'require_probe_section': {
      const ok = stats.some((s) => {
        if (!s.content) return false
        const handoff = parseHandoffComment(s.content)
        if (handoff === null) return false
        return handoff.probes.every((p) => p.what && p.how && p.result)
      })
      if (!ok) failures.push('质量门未过: 产物缺少 <!-- weave-handoff --> 块；即使无探测，也必须写 {"probes": []}')
      break
    }
    default:
      failures.push(`质量门未过: 未知 gate 类型 "${gate.type}"`)
  }
}

/** 旧字符串 gate → 结构化 gate 自动映射（无法映射的跳过 + 记录）。 */
function mapLegacyGate(gate: string): { structured?: { type: string; [k: string]: unknown }; skipReason?: string } {
  if (gate.includes('非空') || gate.includes('必须有')) {
    return { structured: { type: 'min_file_size', bytes: 50 } }
  }
  const countMatch = gate.match(/至少\s*(\d+)\s*个/)
  if (countMatch) {
    return { structured: { type: 'min_artifact_count', n: Number.parseInt(countMatch[1] ?? '0', 10) } }
  }
  if (/tsc|单测|0 error/i.test(gate)) {
    return { skipReason: `交给角色自身保证（${gate}）` }
  }
  return { skipReason: `无法映射的旧质量门（${gate}）` }
}

/** 验证节点产物是否满足质量门。 */
export function validateNodeOutput(
  patch: Partial<Record<string, unknown>>,
  gates: readonly (string | QualityGate)[],
): NodeValidationResult {
  const failures: string[] = []
  const stats = collectArtifactStats(patch)

  for (const gate of gates) {
    if (typeof gate === 'string') {
      const mapped = mapLegacyGate(gate)
      if (mapped.structured) {
        checkStructuredGate(mapped.structured, stats, failures)
      }
      // skipReason 不产生失败（tsc/单测等由角色保证）
      continue
    }
    checkStructuredGate(gate, stats, failures)
  }

  return { passed: failures.length === 0, failures }
}

/** 正则转义（章节名/语言名可能含特殊字符）。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
