/**
 * Handoff 协议解析（Bugs-V1 §6：产物内 <!-- weave-handoff --> 注释块）。
 *
 * 角色在产物末尾写注释块传递探测/决策/遗留问题，下游注入 prompt 避免重复探测。
 * 语义：probes[].reusable 默认 true；不写即复用。
 */
import type { HandoffComment } from '../shared/types.js'

const HANDOFF_RE = /<!--\s*weave-handoff\s*([\s\S]*?)-->/

/** 解析产物中的 weave-handoff 注释块（无/格式错 → null）。 */
export function parseHandoffComment(text: string): HandoffComment | null {
  const m = HANDOFF_RE.exec(text)
  if (!m || !m[1]) return null
  try {
    const parsed = JSON.parse(m[1].trim()) as HandoffComment
    if (!Array.isArray(parsed.probes)) return null
    return parsed
  } catch {
    return null
  }
}

/** 从产物文本剥离 handoff 注释块（返回纯正文）。 */
export function stripHandoffComment(text: string): string {
  return text.replace(HANDOFF_RE, '').trimEnd()
}

/** 构建下游 prompt 的 handoff 注入段（已探测/已决策/遗留问题）。 */
export function buildUpstreamContextBlocks(text: string, maxContent = 8000): string[] {
  const blocks: string[] = []
  const handoff = parseHandoffComment(text)
  if (handoff) {
    const reusableProbes = handoff.probes.filter((p) => p.reusable !== false)
    if (reusableProbes.length > 0) {
      blocks.push(
        `【已探测（无需重复）】\n` +
        reusableProbes
          .map((p) => `  · ${p.what}\n    方式: ${p.how}\n    结果: ${p.result}`)
          .join('\n'),
      )
    }
    if (handoff.decisions?.length) {
      blocks.push(
        `【已决策】\n` +
        handoff.decisions
          .map((d) => `  · ${d.topic}: ${d.choice}${d.rationale ? `（${d.rationale}）` : ''}`)
          .join('\n'),
      )
    }
    if (handoff.openIssues?.length) {
      blocks.push(`【遗留问题】\n${handoff.openIssues.map((i) => `  - ${i}`).join('\n')}`)
    }
  }
  blocks.push(`正文:\n${stripHandoffComment(text).slice(0, maxContent)}`)
  return blocks
}
