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

/** ★ Bugs-V5：异步 subagent 工作方式（允许主动提问）。 */
export const ASYNC_SUBAGENT_RULES = `【工作方式（所有角色适用）】
你是异步 subagent，但**可以通过 ask_user 工具主动向用户提问**。

✅ **什么时候用 ask_user**（关键决策点）：
- 需求模糊，有**多个合理方案**，且选择会**影响下游大量工作**
  （例：五子棋"要不要 AI 对战""分几档难度"；俄罗斯方块"要不要多人模式"）
- **涉及用户偏好/风格**（例："UI 暗色还是亮色""中文还是英文界面"）
- **涉及安全/权限/预算/外部依赖**（例："允许调用外部 API 吗""预算上限多少"）

❌ **什么时候不用**：
- 有**行业标准**可循（"五子棋 15×15"、"俄罗斯方块 10×20"、"黑先白后"）
- **影响范围小**（"按钮圆角多少像素"）
- **上游已有明确约束**（读上游产物即可）

【调用 ask_user 时】
- 必须提供 default（用户超时不回答时用）—— 否则图会卡死
- 必须提供 impact（帮用户快速判断影响）
- 一次只问一件事；可给 2-4 个选项
- 一次节点**最多问 3 次**（超过用 default + 记入"待确认问题清单"）
- 调用前先输出"[动作] 需要用户决策：<问题摘要>"

【不用 ask_user 时】
- 小不确定：先按合理假设继续（标 ⚠️ + 证据等级）
- 所有不确定的假设，写入产物的"待确认问题清单"章节
`

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
export function buildRoleBoundaryBlock(
  role: RoleDefinition | undefined,
  provider: string,
  actualArtifactName?: string,
): string {
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
    // ★ Bugs-v3 修复1：优先用引擎解析出的实际文件名（YAML > role_boundary > <nodeId>.md）
    const displayName = actualArtifactName ?? artifact.name
    lines.push(`  · 文件名: ${displayName}`)
    lines.push(`  · 类型: ${artifact.type}`)
    if (artifact.required_sections.length > 0) {
      lines.push(`  · 必须包含章节（缺一即失败）:`)
      for (const s of artifact.required_sections) lines.push(`    - ## ${s}`)
    }
  }

  lines.push(HANDOFF_BLOCK_TEMPLATE)
  lines.push(PROBE_COLLAB_RULES)
  // ★ 问题6：异步 subagent 工作方式（通用约束）
  lines.push(ASYNC_SUBAGENT_RULES)

  return lines.join('\n')
}
