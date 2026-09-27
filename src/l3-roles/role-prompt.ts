/**
 * Prompt 边界块生成（Bugs-V1 §5）。
 *
 * 引擎把角色边界注入 user prompt 头部（与 SKILL.md 互补）：
 * 职责 / 禁止 / 产物要求 / 探测协作规范 / handoff 块模板。
 */
import type { RoleDefinition } from '../shared/types.js'

/** handoff 块模板（所有角色注入）。 */
export const HANDOFF_BLOCK_TEMPLATE = `【产物末尾必须包含探测记录块】
<!-- weave-handoff
{
  "probes": [
    { "what": "探测对象", "how": "探测方式（命令/URL）", "result": "结果摘要", "reusable": true }
  ],
  "decisions": [{ "topic": "...", "choice": "...", "rationale": "..." }],
  "openIssues": ["..."]
}
-->
即使未做任何探测，也必须写 { "probes": [] }。`

/** 探测协作规范（所有角色注入）。 */
export const PROBE_COLLAB_RULES = `【探测协作规范】
1. 探测外部资源前，先调 publish_finding 声明"准备探测什么"。
2. 探测完成后，再调 publish_finding 记录结果。
3. 若发现上游已探测过的对象（见"已探测"清单），不要再探测。
4. 最终产物末尾必须包含本次所有 reusable=true 的探测。`

/** 从 capability 推导默认禁止（无 role_boundary 时兜底）。 */
function deriveDefaultForbidden(role: RoleDefinition | undefined): string[] {
  const out: string[] = []
  if (!role) return out
  if (/R1|R2|R4|R7|R8/.test(role.id)) {
    out.push('编写任何代码文件（.ts/.js/.py/.html/.css）')
    out.push('执行构建/测试/部署命令')
  }
  out.push('探测环境（列目录、查版本、读项目源码）')
  out.push('修改上游产物')
  return out
}

/** 构建角色 Prompt 边界块。 */
export function buildRoleBoundaryBlock(role: RoleDefinition | undefined, provider: string): string {
  const lines: string[] = []
  const boundary = role?.role_boundary
  const responsibilities = boundary?.responsibilities ?? role?.capabilities ?? ['完成分配的任务']

  lines.push(`【你的角色】${provider}`)
  lines.push(`【你的职责】`)
  for (const r of responsibilities) lines.push(`  · ${r}`)

  const forbidden = boundary?.forbidden ?? deriveDefaultForbidden(role)
  if (forbidden.length > 0) {
    lines.push(`【你禁止做的事（违反即任务失败）】`)
    for (const f of forbidden) lines.push(`  ✗ ${f}`)
  }

  const artifact = boundary?.artifact
  if (artifact) {
    lines.push(`【你的产物要求】`)
    lines.push(`  · 文件名: ${artifact.name}`)
    lines.push(`  · 类型: ${artifact.type}`)
    if (artifact.required_sections.length > 0) {
      lines.push(`  · 必须包含章节（缺一即失败）:`)
      for (const s of artifact.required_sections) lines.push(`    - ## ${s}`)
    }
  }

  lines.push(HANDOFF_BLOCK_TEMPLATE)
  lines.push(PROBE_COLLAB_RULES)

  return lines.join('\n')
}
