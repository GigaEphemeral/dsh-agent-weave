/**
 * Output Gate（MVP-5 问题 1/3：角色职责越界 + 交付物不可验证）。
 *
 * 角色 YAML 可声明 output 约束（仅 .md / 禁止扩展名 / 禁止内容特征）。
 * 节点产物落盘后立即校验；失败抛错 → 引擎分类为 permission-denied → 图暂停。
 *
 * 注意：按 MVP-5 决策 #5 移除工作区扫描，Output Gate 只校验节点自身产物
 * （职责边界以 SKILL.md 约束 + 工具白名单为主，这里做引擎层兜底）。
 */
export interface OutputGateOptions {
  /** 产物文件必须为 .md（设计评审类角色）。 */
  only_markdown?: boolean | undefined
  /** 禁止出现的文件扩展名（如 .py / .ts / .bat）。 */
  forbidden_extensions?: string[] | undefined
  /** 禁止出现在产物正文中的正则特征（如 "pip install"、"import fastapi"）。 */
  forbidden_content_patterns?: string[] | undefined
}

export interface OutputGateResult {
  passed: boolean
  failures: string[]
}

/** 校验节点产物是否越界。 */
export function checkOutputGate(
  gate: OutputGateOptions | undefined,
  artifactPath: string | undefined,
  artifactText: string,
): OutputGateResult {
  if (!gate) return { passed: true, failures: [] }
  const failures: string[] = []
  const lower = artifactPath?.toLowerCase() ?? ''

  if (gate.only_markdown === true && !lower.endsWith('.md')) {
    failures.push(`输出门禁未过: 本角色只允许产出 .md 文档，实际 ${artifactPath ?? '(未落盘)'}`)
  }
  for (const ext of gate.forbidden_extensions ?? []) {
    if (lower.endsWith(ext.toLowerCase())) {
      failures.push(`输出门禁未过: 禁止产出 .${ext.replace(/^\./, '')} 文件，实际 ${artifactPath ?? '(未落盘)'}`)
    }
  }
  for (const pattern of gate.forbidden_content_patterns ?? []) {
    if (new RegExp(pattern).test(artifactText)) {
      failures.push(`输出门禁未过: 产物正文出现越界特征 "${pattern}"`)
    }
  }
  return { passed: failures.length === 0, failures }
}
