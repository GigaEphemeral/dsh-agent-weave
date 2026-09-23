/**
 * 节点产物验证（MVP-4 问题四修复 1）。
 *
 * quality_gate 表达式验证（简化版，3 种）：
 * - 含"非空"或"必须有" → 产物表非空
 * - 含"至少 N 个" → 产物数 ≥ N
 * - 其余（tsc/单测等）→ 交给角色自身保证，引擎不重复跑
 */
export interface NodeValidationResult {
  passed: boolean
  failures: string[]
}

/** 验证节点产物是否满足质量门。 */
export function validateNodeOutput(
  patch: Partial<Record<string, unknown>>,
  gates: readonly string[],
): NodeValidationResult {
  const failures: string[] = []
  const artifacts = patch.artifacts as Record<string, string> | undefined
  const artifactCount = artifacts ? Object.keys(artifacts).length : 0

  for (const gate of gates) {
    if (gate.includes('非空') || gate.includes('必须有')) {
      if (artifactCount === 0) {
        failures.push(`质量门未过: ${gate}（产物为空）`)
      }
    }
    const countMatch = gate.match(/至少\s*(\d+)\s*个/)
    if (countMatch) {
      const required = Number.parseInt(countMatch[1] ?? '0', 10)
      if (artifactCount < required) {
        failures.push(`质量门未过: 需要至少 ${required} 个产物，实际 ${artifactCount}`)
      }
    }
    // tsc/单测等由角色保证，引擎不重复跑
  }

  return { passed: failures.length === 0, failures }
}
