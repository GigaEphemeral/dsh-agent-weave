# 四问题修复完整方案 v2.0

> **决策锁定（v2.0 新增）**：
> 1. 问题1 仅 Prompt 层约束，**不动工具裁剪**
> 2. **删除 `tools:` 与 `token_budget:`** — 改为 SKILL.md 提醒为主
> 3. handoff 块 `reusable` 默认 `true`
> 4. **删除 `max_code_lines`**
> 5. 6 角色 YAML 同步修改
> 6. 允许角色主动调 `publish_finding`
> 7. resume 复用同一 child session

---

# 一、目标与原则

| # | 问题 | 修复层面 |
|---|---|---|
| 1 | 角色职责边界模糊 | Prompt 层（`role_boundary` + SKILL.md 提醒） |
| 2 | 上游探测/决策不流转 | Handoff 协议 + 共享发现池 |
| 3 | 空产出继续开发 | 质量门结构化 + 默认 `inputGate` |
| 4 | 暂停/终止不打断 subagent | `AbortController` 贯通 |

**核心原则**：
- **不做工具层控制**（`toolFilter` 不再从 YAML `tools` 派生）
- **不做 token 计数控制**（`token_budget` 删除，靠 SKILL.md 提醒）
- **Prompt 是唯一软约束，质量门是硬约束**

---

# 二、契约变更

## 2.1 `src/shared/types.ts`

```typescript
// ─── QualityGate（删除 max_code_lines）─────────────────
export const QualityGateSchema = z.union([
  z.string(),  // 向后兼容旧 YAML
  z.object({ type: z.literal('non_empty') }),
  z.object({ type: z.literal('min_file_size'), bytes: z.number().int().positive() }),
  z.object({ type: z.literal('min_artifact_count'), n: z.number().int().positive() }),
  z.object({ type: z.literal('contains_section'), section: z.string(), minLength: z.number().int().optional() }),
  z.object({ type: z.literal('no_code_fence'), languages: z.array(z.string()).optional() }),
  z.object({ type: z.literal('forbidden_phrases'), phrases: z.array(z.string()) }),
  z.object({ type: z.literal('require_probe_section') }),
])
export type QualityGate = z.infer<typeof QualityGateSchema>

// ─── RoleBoundary（新增）───────────────────────────────
export const RoleBoundarySchema = z.object({
  responsibilities: z.array(z.string()).default([]),
  forbidden: z.array(z.string()).default([]),
  artifact: z.object({
    name: z.string().min(1),
    type: z.enum(['markdown', 'code', 'json', 'text']),
    required_sections: z.array(z.string()).default([]),
  }).optional(),
}).optional()

// ─── RoleDefinition（tools / token_budget 改为可选）────
export const RoleDefinitionSchema = z.object({
  schema_version: z.literal('1.0'),
  id: z.string().min(1),
  name: z.string().min(1),
  system_prompt_ref: z.string().min(1),
  traits: z.array(z.string()),
  capabilities: z.array(z.string()),
  // ★ tools 改为可选（缺省=不做工具层控制）
  tools: z.array(z.string()).optional(),
  model: z.object({ provider: z.string().min(1), model: z.string().min(1) }),
  memory_scope: z.enum(['private', 'shared']),
  lifecycle: z.enum(['resident', 'on-demand', 'hybrid']),
  max_concurrent_children: z.number().int().positive(),
  capability: RoleCapabilitySchema.default({ /* ... */ }),
  // ★ token_budget 改为可选（缺省=不限制，靠 SKILL.md 提醒）
  token_budget: z.number().int().positive().optional(),
  role_boundary: RoleBoundarySchema,             // ★ 新增
  quality_gate: z.array(QualityGateSchema),
  handoff: z.object({ /* ... */ }),
  observers: z.array(ObserverConfigSchema).optional(),
})

export interface RoleDefinition {
  // ... 现有字段
  tools?: string[]
  token_budget?: number
  role_boundary?: RoleBoundary
  quality_gate: QualityGate[]
}

// ─── Handoff / Probe / Finding ─────────────────────────
export interface Probe {
  what: string
  how: string
  result: string
  reusable?: boolean    // 默认 true
}

export interface Handoff {
  node: string
  roleId: string
  summary: string
  sections: string[]
  artifacts: Array<{ path: string; bytes: number; sha256: string }>
  probes: Probe[]
  decisions: Array<{ topic: string; choice: string; rationale?: string }>
  openIssues: string[]
  provenance: { at: number; graphId: string; graphVersion: string }
}

export interface Finding {
  at: number
  node: string
  kind: 'endpoint' | 'version' | 'decision' | 'error' | 'other'
  what: string
  how: string
  result: string
  reusable: boolean
  tags?: string[]
}
```

## 2.2 `src/l3-roles/role-loader.ts` 适配

**关键改动**：`toolFilter` 不再从 `tools` 派生（用户明确"不要工具层控制"）。

```typescript
export interface RoleProfile {
  name: string
  persona: string
  /**
   * 工具最小权限声明（allow 列表）。
   * ★ 缺省空数组 = 不做工具层控制（靠 SKILL.md 提醒）。
   */
  toolFilter: readonly string[]
  agentOptions: { provider: string; model: string }
  depthLimit?: number
  capability: RoleCapability
  inheritsParentContext: boolean
  metadata: {
    name: string
    traits: string[]
    capabilities: string[]
    quality_gate: QualityGate[]
    /** ★ 仅记录，不参与请求组装；缺省表示无限制。 */
    token_budget?: number
    lifecycle: 'resident' | 'on-demand' | 'hybrid'
    handoff: RoleDefinition['handoff']
    role_boundary?: RoleBoundary
  }
}

export function compileRoleProfile(role: RoleDefinition, options: CompileOptions): RoleProfile {
  // ... persona 读取同原
  return {
    name: role.id,
    persona,
    // ★ 只保留显式声明的 tools；缺省 → 空数组（不控制）
    toolFilter: role.tools ? [...role.tools] : [],
    agentOptions: { provider: role.model.provider, model: role.model.model },
    depthLimit: role.capability.max_depth,
    capability: role.capability,
    inheritsParentContext: role.memory_scope === 'shared',
    metadata: {
      name: role.name,
      traits: [...role.traits],
      capabilities: [...role.capabilities],
      quality_gate: [...role.quality_gate],
      ...(role.token_budget !== undefined ? { token_budget: role.token_budget } : {}),
      lifecycle: role.lifecycle,
      handoff: { /* ... */ },
      ...(role.role_boundary !== undefined ? { role_boundary: role.role_boundary } : {}),
    },
  }
}

export function compileRoleToProvider(
  role: RoleDefinition,
  options: CompileOptions,
  delegate: Pick<SubagentProvider, 'start' | 'prepareContinuable'>,
): SubagentProvider {
  const profile = compileRoleProfile(role, options)

  return {
    name: profile.name,
    capabilities: { agentOptions: true, outputSchema: false, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: profile.inheritsParentContext,
    agentRouteDefaults: profile.agentOptions,
    async start(request) {
      const injected: ResolvedSubagentStartRequest = {
        ...request,
        persona: profile.persona,
        // ★ 只有非空 toolFilter 才注入 toolFilter（空=不控制工具）
        ...(profile.toolFilter.length > 0
          ? { toolFilter: { allow: sanitizeTools(profile.toolFilter, profile.capability.allow_delegation) } }
          : {}),
        agentOptions: {
          provider: profile.agentOptions.provider,
          model: profile.agentOptions.model,
        },
        ...(profile.depthLimit !== undefined ? { maxDepth: profile.depthLimit } : {}),
      }
      return delegate.start(injected)
    },
    async prepareContinuable(request) {
      if (delegate.prepareContinuable !== undefined) return delegate.prepareContinuable(request)
      return Promise.resolve({})
    },
  }
}

/** describeRoleProfile 移除 token_budget 强制字段。 */
export function describeRoleProfile(profile: RoleProfile): Record<string, unknown> {
  return {
    role_id: profile.name,
    persona_len: profile.persona.length,
    persona_fp: fingerprint(profile.persona),
    tool_count: profile.toolFilter.length,   // 0 = 不做工具层控制
    provider: profile.agentOptions.provider,
    model: profile.agentOptions.model,
    memory_scope: profile.inheritsParentContext ? 'shared' : 'private',
    // token_budget 只在有值时记录
    ...(profile.metadata.token_budget !== undefined ? { token_budget: profile.metadata.token_budget } : {}),
  }
}
```

**下游影响**：`R1-requirement.yaml` 的 `tools: []` 与 `capability.allow_write: true` 矛盾消失——两者都不再影响运行时。

---

# 三、6 角色 YAML（无 `tools` / 无 `token_budget`）

## 3.1 R1-requirement

```yaml
schema_version: '1.0'
id: R1-requirement
name: 需求分析师
system_prompt_ref: R1-requirement/SKILL.md
traits: [发散, 收敛, 边界思维]
capabilities: [需求边界扩充, 验收基线定义]
model: { provider: vol186coding, model: deepseek-v4-flash }
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 1
capability:
  allow_delegation: false
  max_depth: 1
  allowed_children: []
  allow_shell: false
  allow_write: true
role_boundary:
  responsibilities:
    - 把一句话需求展开为完整需求空间（场景/用户/功能/边界/异常/成本 六维）
    - 定义 In / Out 边界与验收基线（可量化）
    - 标注假设与证据等级（📘 官方/📊 行业/⚠️ 假设/🧪 需实测）
  forbidden:
    - 编写任何代码文件（.ts/.js/.tsx/.jsx/.py/.html/.css/.sh）
    - 执行构建/测试/部署/安装命令
    - 探测环境（列目录、查工具链版本、读项目源码）
    - 修改上游产物
    - 做技术选型（那是 R2 职责）
    - 做测试设计（那是 R4 职责）
  artifact:
    name: prd.md
    type: markdown
    required_sections: [目标与范围, 核心功能清单, 验收基线, 边界条件与假设]
quality_gate:
  - { type: min_file_size, bytes: 800 }
  - { type: contains_section, section: '目标与范围', minLength: 100 }
  - { type: contains_section, section: '核心功能清单' }
  - { type: contains_section, section: '验收基线', minLength: 200 }
  - { type: contains_section, section: '边界条件与假设' }
  - { type: no_code_fence, languages: [ts, js, tsx, jsx, py, html, css, sh] }
  - { type: require_probe_section }
handoff: { upstream: [], downstream: [R2-architect], edge_type: seq }
```

## 3.2 R2-architect

```yaml
id: R2-architect
name: 架构师
system_prompt_ref: R2-architect/SKILL.md
traits: [模块化, 契约思维]
capabilities: [技术方案设计, 契约核查]
model: { provider: vol186coding, model: deepseek-v4-flash }
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 1
capability:
  allow_delegation: false
  max_depth: 1
  allowed_children: []
  allow_shell: false
  allow_write: true
role_boundary:
  responsibilities:
    - 基于 PRD 做技术选型（按需求定，不预设栈）
    - 模块/结构划分与职责边界
    - 关键数据模型/状态设计
    - 风险识别与缓解
  forbidden:
    - 编写完整代码实现（只能写接口签名/伪代码）
    - 执行构建/测试/安装命令
    - 修改需求（范围变更属 R1/用户）
    - 编写测试用例（那是 R4 职责）
  artifact:
    name: arch.md
    type: markdown
    required_sections: [技术选型, 模块划分, 数据模型, 风险与缓解]
quality_gate:
  - { type: min_file_size, bytes: 1000 }
  - { type: contains_section, section: '技术选型', minLength: 100 }
  - { type: contains_section, section: '模块划分', minLength: 150 }
  - { type: contains_section, section: '数据模型' }
  - { type: contains_section, section: '风险与缓解' }
  - { type: require_probe_section }
handoff: { upstream: [R1-requirement], downstream: [R4-designer], edge_type: seq }
```

## 3.3 R4-designer

```yaml
id: R4-designer
name: 详细设计师
system_prompt_ref: R4-designer/SKILL.md
traits: [可测试性, 边界细致]
capabilities: [测试方案设计, 接口细化]
model: { provider: vol186coding, model: deepseek-v4-flash }
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 1
capability:
  allow_delegation: false
  max_depth: 1
  allowed_children: []
  allow_shell: false
  allow_write: true
role_boundary:
  responsibilities:
    - 细化关键接口/函数签名（伪代码级别）
    - 设计测试方案（正常/边界/异常三层）
    - 验收对照（对齐 PRD 验收基线）
  forbidden:
    - 编写完整代码实现
    - 执行构建/测试命令
    - 修改架构决策（变更属 R2）
    - 修改需求
  artifact:
    name: design.md
    type: markdown
    required_sections: [实现要点, 接口细化, 测试要点, 验收对照]
quality_gate:
  - { type: min_file_size, bytes: 1000 }
  - { type: contains_section, section: '实现要点' }
  - { type: contains_section, section: '测试要点', minLength: 150 }
  - { type: contains_section, section: '验收对照' }
  - { type: require_probe_section }
handoff: { upstream: [R2-architect], downstream: [R6-developer], edge_type: seq }
```

## 3.4 R6-developer

```yaml
id: R6-developer
name: 开发者
system_prompt_ref: R6-developer/SKILL.md
traits: [严谨, 高效]
capabilities: [代码实现, 单测编写]
model: { provider: vol186coding, model: deepseek-v4-flash }
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 1
capability:
  allow_delegation: false
  max_depth: 1
  allowed_children: []
  allow_shell: true       # ★ 唯一允许 shell 的角色（开发需要）
  allow_write: true
role_boundary:
  responsibilities:
    - 按设计产出可运行的代码文件（一个或多个）
    - 编写对应单测（如设计有要求）
    - 记录环境/依赖/接口探测过程
  forbidden:
    - 修改需求/架构/设计（如有疑义，在产物"遗留问题"章节提出）
    - 探测与实现无关的环境（列无关目录、检查无关工具链）
    - 反复勘察 node/npm/tsc 环境（若上游未明确要求构建，跳过）
  artifact:
    name: develop.md
    type: code
    required_sections: [实现要点, 文件清单, 探测记录]
quality_gate:
  - { type: min_artifact_count, n: 1 }
  - { type: min_file_size, bytes: 300 }
  - { type: contains_section, section: '实现要点', minLength: 50 }
  - { type: contains_section, section: '文件清单' }
  - { type: require_probe_section }
handoff: { upstream: [R4-designer], downstream: [R7-tester], edge_type: seq }
```

## 3.5 R7-tester

```yaml
id: R7-tester
name: 测试员
system_prompt_ref: R7-tester/SKILL.md
traits: [怀疑, 证据链]
capabilities: [测试执行, 回归验证]
model: { provider: vol186coding, model: deepseek-v4-flash }
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 1
capability:
  allow_delegation: false
  max_depth: 1
  allowed_children: []
  allow_shell: false
  allow_write: true
role_boundary:
  responsibilities:
    - 按测试要点执行验证（正常/边界/异常）
    - 对比 PRD 验收基线
    - 失败项附复现步骤与证据
  forbidden:
    - 修改代码（发现问题→记录，不修复）
    - 执行与测试无关的命令
    - 修改需求/设计
  artifact:
    name: report.md
    type: markdown
    required_sections: [测试用例清单, 预期结果, 验收基线对照, 结论]
quality_gate:
  - { type: min_file_size, bytes: 800 }
  - { type: contains_section, section: '测试用例', minLength: 150 }
  - { type: contains_section, section: '结论' }
  - { type: require_probe_section }
handoff: { upstream: [R6-developer], downstream: [R8-quality], edge_type: seq }
```

## 3.6 R8-quality

```yaml
id: R8-quality
name: 质量审核员
system_prompt_ref: R8-quality/SKILL.md
traits: [双轴审查, 分级问题]
capabilities: [代码审核, 门禁判定]
model: { provider: vol186coding, model: deepseek-v4-flash }
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 1
capability:
  allow_delegation: false
  max_depth: 1
  allowed_children: []
  allow_shell: false
  allow_write: true
role_boundary:
  responsibilities:
    - 按 P0/P1/P2 分级列出问题
    - 给出门禁判定（通过 / 不通过 + 理由）
    - 结论可复核（附证据引用）
  forbidden:
    - 修改代码
    - 执行修复
    - 与上游重复的探测（除非证据不足需复核）
  artifact:
    name: review.md
    type: markdown
    required_sections: [问题清单, 门禁判定, 结论]
quality_gate:
  - { type: min_file_size, bytes: 600 }
  - { type: contains_section, section: '问题清单' }
  - { type: contains_section, section: '门禁判定' }
  - { type: contains_section, section: '结论' }
  - { type: require_probe_section }
handoff: { upstream: [R7-tester], downstream: [], edge_type: seq }
```

## 3.7 改动摘要

| 字段 | v1 状态 | v2 状态 |
|---|---|---|
| `tools:` | 显式列出 | **删除** |
| `token_budget:` | 数字 | **删除** |
| `capability.allow_shell` | true（全部） | R6=true；其余 **false**（提示用） |
| `quality_gate` | string[] | 结构化 union |
| `role_boundary` | 无 | 新增 |

---

# 四、SKILL.md 提醒规范

## 4.1 每个 SKILL.md 新增章节模板

在每个角色 SKILL.md 的开头（`---` frontmatter 之后）插入：

```markdown
## ⚠️ 工具使用提醒（软约束）

本角色 YAML **未声明 `tools` 白名单**，工具层不做限制 —— **完全依赖你的自觉**。
请严格遵守：

### 你禁止做的事（违反即任务失败，会被质量门拦截）

{RoleBoundary.forbidden 列表，如：}
- ❌ 禁止使用 `write` / `edit` 工具写入代码文件
- ❌ 禁止使用 `pwsh` / `bash` 执行构建/测试/部署命令
- ❌ 禁止使用 `glob` / `grep` 探测无关目录或项目源码
- ❌ 禁止修改上游产物

### 你推荐做的事

- ✅ 使用 `read` 读取上游产物（若非已在 prompt 中注入）
- ✅ 使用 `publish_finding` 记录探测结果（避免下游重复探测）
- ✅ 只产出 Markdown 文档（不要写代码文件）

### 你的产物要求

- 文件名：`{RoleBoundary.artifact.name}`
- 必须包含章节：
  - `## {section1}`
  - `## {section2}`
  - ...
- 末尾必须包含 `<!-- weave-handoff -->` 块（即使无探测也写 `{"probes": []}`）

---

## 💡 Token 预算提醒（软约束）

本角色预期 Token 预算约 **{原 token_budget 值}**（YAML 已删除，仅作提醒）。
请：

- 直接产出最终内容，不要反复推敲
- 不要输出"以下是…""已保存到…"之类的说明性文字
- 不要探索环境（列目录、查工具链版本）
- 不要为验证小细节发起额外工具调用

若 Token 逼近预算，**优先保证产物的完整性**，不要在细节上纠缠。
```

## 4.2 6 角色的具体提醒（供 SKILL.md 填写）

| 角色 | Token 提醒值 | 工具禁止摘要 |
|---|---|---|
| R1 | ~2000 | 禁 write 代码 / 禁 pwsh / 禁探测环境 / 只写 prd.md |
| R2 | ~2000 | 禁完整代码实现 / 禁 pwsh / 只写 arch.md |
| R4 | ~2000 | 禁完整代码实现 / 禁 pwsh / 只写 design.md |
| R6 | ~2500 | **允许** write + pwsh（唯一） / 禁探测无关环境 |
| R7 | ~2000 | 禁修改代码 / 禁执行无关命令 / 只写 report.md |
| R8 | ~2000 | 禁修改代码 / 禁修复 / 只写 review.md |

## 4.3 与 Prompt 注入的关系

**双保险**：
1. **SKILL.md**（作为 `persona` 注入 system prompt）——详细、稳定、可读
2. **引擎 Prompt 边界块**（`role-prompt.ts` 生成）——简洁、结构化、每次任务都出现

引擎生成的边界块放在 user prompt 头部，SKILL.md 在 system prompt，互补。

---

# 五、Prompt 边界块（`role-prompt.ts`）

## 5.1 输出模板

```
【你的角色】{provider}
【你的职责】
  · {responsibility1}
  · {responsibility2}
【你禁止做的事（违反即任务失败）】
  ✗ {forbidden1}
  ✗ {forbidden2}
【你的产物要求】
  · 文件名: {artifactName}
  · 类型: {artifactType}
  · 必须包含章节（缺一即失败）:
    - ## {section1}
    - ## {section2}
【产物末尾必须包含探测记录块】
<!-- weave-handoff
{
  "probes": [
    { "what": "探测对象", "how": "探测方式（命令/URL）", "result": "结果摘要", "reusable": true }
  ],
  "decisions": [{ "topic": "...", "choice": "...", "rationale": "..." }],
  "openIssues": ["..."]
}
-->
即使未做任何探测，也必须写 { "probes": [] }。

【探测协作规范】
1. 探测外部资源前，先调 publish_finding 声明"准备探测什么"。
2. 探测完成后，再调 publish_finding 记录结果。
3. 若发现上游已探测过的对象（见"已探测"清单），不要再探测。
4. 最终产物末尾必须包含本次所有 reusable=true 的探测。
```

## 5.2 生成逻辑（`src/l3-roles/role-prompt.ts`）

```typescript
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

  // 探测记录块规范（所有角色都注入）
  lines.push(HANDOFF_BLOCK_TEMPLATE)
  lines.push(PROBE_COLLAB_RULES)

  return lines.join('\n')
}

/** 从 capability 推导默认禁止（无 role_boundary 时的兜底）。 */
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
```

---

# 六、Handoff 协议

## 6.1 产物内注释（角色自写，必填）

```markdown
<!-- weave-handoff
{
  "probes": [
    {
      "what": "东方财富 ETF 列表 API",
      "how": "curl 'https://push2.eastmoney.com/api/qt/clist/get?fs=b:MK0021&fields=f12,f14,f2'",
      "result": "200 OK，1523 条 ETF，字段 f12=code/f14=name/f2=现价",
      "reusable": true
    }
  ],
  "decisions": [
    { "topic": "技术栈", "choice": "Python 3 标准库", "rationale": "用户要求单文件零依赖" }
  ],
  "openIssues": [
    "数据源延迟未明确（推测 T+1）"
  ]
}
-->
```

## 6.2 语义（v2.0 锁定）

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `probes[]` | ✅ | `[]` | 每次探测一条 |
| `probes[].what` | ✅ | — | 探测对象 |
| `probes[].how` | ✅ | — | 探测方式 |
| `probes[].result` | ✅ | — | 结果摘要（≤500 字） |
| `probes[].reusable` | ⭕ | **`true`** | 不写即复用 |
| `decisions[]` | ⭕ | `[]` | 关键决策 |
| `openIssues[]` | ⭕ | `[]` | 遗留问题 |

## 6.3 引擎解析（`handoff-extractor.ts`）

```typescript
const HANDOFF_RE = /<!--\s*weave-handoff\s*([\s\S]*?)-->/

export function parseHandoffComment(text: string): HandoffComment | null {
  const m = HANDOFF_RE.exec(text)
  if (!m || !m[1]) return null
  try {
    const parsed = JSON.parse(m[1].trim()) as HandoffComment
    if (!Array.isArray(parsed.probes)) return null
    return parsed
  } catch { return null }
}

export function stripHandoffComment(text: string): string {
  return text.replace(HANDOFF_RE, '').trimEnd()
}

/** 生成 _handoff.json（供 REST / 报告读取）。 */
export function buildHandoff(input: {...}): Handoff { /* ... */ }
```

## 6.4 校验（`require_probe_section` gate）

```typescript
case 'require_probe_section': {
  for (const s of stats) {
    if (!s.content) continue
    const handoff = parseHandoffComment(s.content)
    if (handoff === null) {
      failures.push(`质量门未过: 产物缺少 <!-- weave-handoff --> 块（${s.path}）；即使无探测，也必须写 {"probes": []}`)
      continue
    }
    for (let i = 0; i < handoff.probes.length; i++) {
      const p = handoff.probes[i]!
      if (!p.what || !p.how || !p.result) {
        failures.push(`质量门未过: probes[${i}] 缺 what/how/result 字段`)
      }
    }
  }
  break
}
```

## 6.5 下游注入

`buildUpstreamContext` 构建下游 prompt 时，对每个上游产物：

```typescript
const handoff = parseHandoffComment(text)
if (handoff) {
  const reusableProbes = handoff.probes.filter((p) => p.reusable !== false)
  if (reusableProbes.length > 0) {
    blocks.push(
      `【已探测（无需重复）】\n` +
      reusableProbes.map((p) => `  · ${p.what}\n    方式: ${p.how}\n    结果: ${p.result}`).join('\n')
    )
  }
  if (handoff.decisions?.length) {
    blocks.push(`【已决策】\n${handoff.decisions.map((d) => `  · ${d.topic}: ${d.choice}${d.rationale ? `（${d.rationale}）` : ''}`).join('\n')}`)
  }
  if (handoff.openIssues?.length) {
    blocks.push(`【遗留问题】\n${handoff.openIssues.map((i) => `  - ${i}`).join('\n')}`)
  }
}
blocks.push(`正文:\n${stripHandoffComment(text).slice(0, 8000)}`)
```

---

# 七、`publish_finding` 工具

## 7.1 定义（`src/l2-engine/publish-finding-tool.ts`）

```typescript
export function registerPublishFindingTool(
  ctx: Context,
  getContext: () => { artifactsRoot?: string; graphId?: string; nodeId?: string },
): () => void {
  return ctx.tools.register(defineTool({
    name: 'publish_finding',
    description:
      '声明一条探测发现（写入本图共享发现池），供后续节点避免重复探测。' +
      '典型场景：探测 API 返回格式、查询工具版本、确认文件存在、确定技术选型。' +
      '注意：你仍必须在最终产物的 <!-- weave-handoff --> 块里重复这些发现（除非 reusable=false）。',
    parameters: {
      kind: { type: 'string', required: true, description: 'endpoint | version | decision | error | other' },
      what: { type: 'string', required: true, description: '探测对象（人类可读）' },
      how: { type: 'string', required: true, description: '探测方式（命令/URL）' },
      result: { type: 'string', required: true, description: '探测结果摘要（≤500 字）' },
      reusable: { type: 'boolean', description: '是否可复用（默认 true）' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签' },
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v as string }] } },
    async execute(args) {
      const c = getContext()
      if (!c.artifactsRoot || !c.graphId || !c.nodeId) return '⚠ 无活动图上下文，finding 未记录'
      appendFinding(c.artifactsRoot, c.graphId, {
        at: Date.now(), node: c.nodeId, kind: args.kind as Finding['kind'],
        what: args.what, how: args.how, result: String(args.result).slice(0, 500),
        reusable: args.reusable !== false,
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
      })
      return `✅ 已记录到共享发现池（${args.kind}: ${args.what}）`
    },
  }))
}
```

## 7.2 上下文注入

`state-graph.ts` 模块级变量：

```typescript
let currentNodeCtx: { artifactsRoot?: string; graphId: string; nodeId: string } | null = null
export function getCurrentNodeCtx() { return currentNodeCtx ?? {} }

// handler 执行前后
try {
  currentNodeCtx = { artifactsRoot, graphId, nodeId: current }
  const patch = await handler(state, nodeCtx, options.signal)
} finally {
  currentNodeCtx = null
}
```

## 7.3 落盘格式

`productions/<graphId>/_shared/<graphId>-findings.jsonl`，一行一 JSON。

## 7.4 防滥用

- 单节点 20 次上限（超出 warn 继续）
- `what`/`how`/`result` 任一为空 → 拒绝
- `reusable=false` 只进 ledger，不进下游注入

---

# 八、问题3：质量门与 `inputGate`

## 8.1 `node-validator.ts` 重写要点

```typescript
// 真实文件状态（替代 Object.keys 计数）
function collectArtifactStats(patch): ArtifactStat[] {
  const artifacts = patch.artifacts as Record<string, string> | undefined
  if (!artifacts) return []
  return Object.values(artifacts).map((path) => {
    try {
      const st = statSync(path)
      const content = st.size < 1_048_576 ? readFileSync(path, 'utf8') : null
      return { path, exists: true, bytes: st.size, content }
    } catch {
      return { path, exists: false, bytes: 0, content: null }
    }
  })
}

// 占位短语检测
const PLACEHOLDER_PATTERNS = [
  /^[\s\n]*(完成|OK|Done|已生成|已完成)[\s。.!]*$/i,
  /（?暂无内容）?/, /TODO:\s*$/,
]
function isPlaceholder(text: string): boolean {
  return text.length < 100 && PLACEHOLDER_PATTERNS.some((p) => p.test(text.trim()))
}
```

**Gate 分派**（删 `max_code_lines`）：

| type | 判定 |
|---|---|
| `non_empty` | `stats.filter(s => s.exists && s.bytes > 0 && !isPlaceholder(s.content)).length > 0` |
| `min_file_size` | 所有产物 `bytes >= g.bytes` |
| `min_artifact_count` | `stats.length >= g.n` |
| `contains_section` | 正则 `^#{1,6}\s+<section>` 命中；`minLength` 校验段落长度 |
| `no_code_fence` | 正则 `` ```lang `` 不命中 |
| `forbidden_phrases` | `content.includes(phrase)` 不命中 |
| `require_probe_section` | `parseHandoffComment` 成功 + probes 结构完整 |

**旧字符串自动映射**：
| 旧字符串 | 映射 |
|---|---|
| 含"非空" / "必须有" | `{ type: 'min_file_size', bytes: 50 }` |
| `至少 N 个` | `{ type: 'min_artifact_count', n: N }` |
| 含"tsc"/"单测"/"0 error" | 跳过 + debug 日志 |
| 其他 | 跳过 + warn 日志（不静默） |

## 8.2 `inputGate` 默认启用

**`graph-run-commands.ts` / `graph-resume-commands.ts` / `graph-visual-commands.ts`** 构建图时从 spec 推导 seq 上游：

```typescript
const seqUpstreamByNode = new Map<string, string[]>()
for (const edge of spec.edges) {
  if (edge.type !== 'seq') continue
  const list = seqUpstreamByNode.get(edge.to) ?? []
  list.push(edge.from)
  seqUpstreamByNode.set(edge.to, list)
}

graph.addSubagent(node.id, {
  provider: node.roleRef,
  artifactName: node.artifactName ?? `${node.id}.md`,
  role: node.roleRef,
  ...(node.promptTemplate !== undefined ? { promptTemplate: node.promptTemplate } : {}),
  ...(role && role.quality_gate.length > 0 ? { qualityGate: role.quality_gate } : {}),
  ...(role !== undefined ? { roleDefinition: role } : {}),
  inputGate: node.inputGate ?? (seqUpstreamByNode.get(node.id)?.length
    ? { requires: seqUpstreamByNode.get(node.id)! }
    : undefined),
  ...
})
```

**`checkInputGate` 阈值**：`size < 50` 视为空（原来是 `size === 0`）。

---

# 九、问题4：暂停/终止贯通

## 9.1 `graph-control.ts` 加 AbortController

```typescript
import { PauseError } from './subagent-waiter.js'

interface ControlState {
  paused: boolean
  stopped: boolean
  controller: AbortController
  waiters: Array<() => void>
}

export function getGraphControl(graphId: string): GraphControl {
  let ctrl = controls.get(graphId)
  if (!ctrl) {
    const state: ControlState = { paused: false, stopped: false, controller: new AbortController(), waiters: [] }
    ctrl = {
      pause: () => {
        if (state.paused || state.stopped) return
        state.paused = true
        state.controller.abort(new PauseError('user-pause'))   // ★ 触发 interrupt
      },
      resume: () => {
        if (state.stopped) return
        state.paused = false
        state.controller = new AbortController()              // ★ 重置
        for (const w of state.waiters) w()
        state.waiters.length = 0
      },
      stop: () => {
        if (state.stopped) return
        state.stopped = true
        state.paused = false
        state.controller.abort(new Error('user-stop'))        // ★ 触发 interrupt
        for (const w of state.waiters) w()
        state.waiters.length = 0
      },
      isPaused: () => state.paused,
      isStopped: () => state.stopped,
      getSignal: () => state.controller.signal,
      waitForResume: () => new Promise((r) => { if (!state.paused) r(); else state.waiters.push(r) }),
    }
    controls.set(graphId, ctrl)
  }
  return ctrl
}
```

## 9.2 `subagent-waiter.ts` 分流 + 泄漏修复

```typescript
let abortHandler: (() => void) | null = null

function settle(fn: () => void): void {
  if (settled) return
  settled = true
  if (idleCheckTimer) clearInterval(idleCheckTimer)
  dispose()
  if (abortHandler && opts.signal) {
    opts.signal.removeEventListener('abort', abortHandler)
    abortHandler = null
  }
  fn()
}

if (opts.signal) {
  abortHandler = () => {
    const reason = opts.signal!.reason
    const parent = opts.parentAgent
    if (parent !== undefined) {
      interruptSubagent(ctx, childId, parent).catch((err) => { /* log */ })
    }
    // ★ 分流：PauseError → 暂停；其他 → 终止
    if (reason instanceof PauseError) {
      settle(() => reject(reason))
    } else {
      settle(() => reject(new Error(`用户终止: ${reason instanceof Error ? reason.message : String(reason)}`)))
    }
  }
  opts.signal.addEventListener('abort', abortHandler)
}
```

## 9.3 `types.ts` 加 `graphSignal`

```typescript
export interface GraphNodeContext<T> {
  // ...
  /** ★ 图级控制信号（来自 GraphControl；用于暂停/终止打断 subagent）。 */
  graphSignal?: AbortSignal
}
```

## 9.4 `state-graph.ts` 传递与分支

```typescript
// run 循环内，注入 graphSignal
const ctrl = getGraphControl(graphId)
// ...（保留 isStopped / isPaused 边界检查）
const nodeCtx: GraphNodeContext<T> = {
  // ...
  graphSignal: ctrl.getSignal(),
}

// addSubagent 内使用 graphSignal
const effectiveSignal = nodeCtx.graphSignal ?? options.signal
result = await waitForSubagentEnd(nodeCtx.ctx, activeChildId, {
  ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
  parentAgent: agent,
  onActivity, onIdleWarning, onLoopDetected,
})
```

**catch 分支**（PauseError vs stop 分开）：

```typescript
catch (error) {
  const err = error instanceof Error ? error : new Error(String(error))

  // ★ 用户暂停 → 写快照 + graph/paused
  if (error instanceof PauseError) {
    if (artifactsRoot) {
      const snapshot: PauseSnapshot<T> = {
        graphId, graphVersion: options.graphVersion, graphSchemaHash: options.graphSchemaHash,
        pausedNode: current, pausedAt: Date.now(), iteration, resumeFrom: current,
        pauseReason: 'user-pause',
        pauseDetails: { suggestedAction: '点恢复继续，或用 weave_graph_resume 恢复' },
        state, loopUsage: Object.fromEntries(loopUsed),
        childSessions: Object.fromEntries(childIdByNode),
        completedNodes: [...completedNodes],
      }
      writePauseSnapshot(artifactsRoot, snapshot)
    }
    emit({ type: 'graph/paused', graphId, node: current, timestamp: Date.now(),
      data: { reason: 'user-pause', childId: error.childId, resumeFrom: current } })
    // 不 clearGraphControl（等 resume）
    return { graphId, success: true, finalState: state, trajectory, iterations: iteration,
      data: { paused: true, reason: 'user-pause', resumeFrom: current } }
  }

  // ★ 用户终止
  if (ctrl.isStopped()) {
    emit({ type: 'graph/end', graphId, node: current, timestamp: Date.now(), data: { stopped: true } })
    clearGraphControl(graphId)
    return { graphId, success: true, finalState: state, trajectory, iterations: iteration,
      data: { stopped: true } }
  }

  // ...（其他走 classifyError）
}
```

## 9.5 routes 层

```typescript
if (tail.length === 1 && ['pause', 'resume', 'stop'].includes(tail[0] ?? '')) {
  if (method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
  const action = tail[0] as 'pause' | 'resume' | 'stop'
  controlActiveGraph(action, graphId)   // 走内存控制
  const root = entry?.artifactsRoot ?? resolveArtifactsRoot({})
  // 兼容 chain-runner 的文件方案
  if (action === 'pause') void pauseGraph(graphId, root)
  else if (action === 'resume') { void resumeGraph(graphId, root); void unlinkIfExists(join(root, 'PAUSE')) }
  else void stopGraph(graphId, root)
  json(res, 200, { ok: true, action })
  return
}
```

**`l4-visual/host/graph-control.ts`** 的 `resumeGraph` **必须删 PAUSE 文件**：

```typescript
export async function resumeGraph(_graphId: string, productionsRoot: string): Promise<void> {
  writeFileSync(join(productionsRoot, 'RESUME'), '', 'utf8')
  try { unlinkSync(join(productionsRoot, 'PAUSE')) } catch { /* 忽略 */ }
}
```

## 9.6 事件流修正

| 文件 | 修正 |
|---|---|
| `event-bus.ts` | 补 `case 'graph/paused': status = 'paused'` |
| `event-schema.ts` | 加 `graph-error` 类型；`mapEventType` 不再把 `graph/error` 映射为 `graph-end` |
| `event-bridge.ts` | bus 重建时重新订阅（P0-9） |
| `useGraphStream.ts` | 补 `graph-paused` / `graph-error` case；`node-start` 更新 `currentRole` |
| `NodeActivityPanel.tsx` | 轮询改**合并**而非替换（P0-3） |

---

# 十、Resume 语义

## 10.1 复用同 child session

**已在 `graph-resume-commands.ts` 实现**：

```typescript
restoredChildSessions: snapshot.childSessions,
```

引擎侧预填 `childIdByNode`，`addSubagent` 走 `sendMessage` 分支。

## 10.2 `resumePrompt` 增强

```typescript
function buildResumePrompt(snapshot: PauseSnapshot<any>): string {
  const lines = [
    `[恢复通知] 你（节点 ${snapshot.pausedNode}）上次执行被中断，原因如下：`,
    ``,
    `暂停原因: ${snapshot.pauseReason}`,
  ]
  const d = snapshot.pauseDetails ?? {}
  if (d.error) lines.push(`错误信息: ${d.error}`)
  if (d.suggestedAction) lines.push(`建议动作: ${d.suggestedAction}`)
  lines.push(``)
  lines.push(`【继续要求】`)
  lines.push(`1. 复盘上述失败原因，不要重复同样的动作。`)
  lines.push(`2. 若上次在写产物时失败，先读回已写内容，再补齐缺失部分（不要从零重写）。`)
  lines.push(`3. 若上次在探测时失败，先查共享发现池（可能已有其他节点的探测结果）。`)
  lines.push(`4. 完成后在产物末尾附 <!-- weave-handoff --> 块。`)
  return lines.join('\n')
}
```

**resume 时同时附上次产物前 2000 字**（防上下文丢失）。

## 10.3 修 P0-1（快照删除时机）

```typescript
void graph.run(...)
  .then((result) => {
    if (result.success && !result.data?.paused) {
      removePauseSnapshot(root, graphId)   // ★ 成功后才删
      logger.info('weave', '恢复成功，快照已清理', { graphId })
    } else {
      logger.info('weave', '恢复后再次暂停/失败，保留快照', { graphId, success: result.success })
    }
  })
  .catch((err) => {
    logger.error('weave', '恢复执行失败，保留快照供二次恢复', err, { graphId })
    // 不删快照
  })
```

---

# 十一、模块改动清单（v2.0）

| # | 文件 | 类型 | 内容 |
|---|---|---|---|
| 1 | `roles/R1~R8.yaml` × 6 | 改 | **删除 `tools:` + `token_budget:`**；新增 `role_boundary`；结构化 `quality_gate`；`allow_shell` 仅 R6=true |
| 2 | `roles/*/SKILL.md` × 6 | 改 | 新增"工具使用提醒"+"Token 预算提醒"两章节 |
| 3 | `src/shared/types.ts` | 改 | `QualityGateSchema`（无 `max_code_lines`）；`RoleBoundarySchema`；`tools?` / `token_budget?` 改可选；`Handoff` / `Probe` / `Finding` |
| 4 | `src/l3-roles/role-schema.ts` | 改 | 反映新 schema |
| 5 | `src/l3-roles/role-loader.ts` | 改 | `toolFilter` 空时不注入；`token_budget` 仅记录不强制 |
| 6 | `src/l3-roles/role-prompt.ts` | **新增** | `buildRoleBoundaryBlock` |
| 7 | `src/l2-engine/handoff-extractor.ts` | **新增** | `parseHandoffComment` / `stripHandoffComment` / `buildHandoff` |
| 8 | `src/l2-engine/node-validator.ts` | 改 | 结构化 gate 分派 + `require_probe_section` |
| 9 | `src/l2-engine/findings-pool.ts` | **新增** | `appendFinding` / `readRecentFindings` |
| 10 | `src/l2-engine/publish-finding-tool.ts` | **新增** | 工具定义 |
| 11 | `src/l2-engine/graph-control.ts` | 改 | `AbortController` + `getSignal` |
| 12 | `src/l2-engine/subagent-waiter.ts` | 改 | abort reason 分流 + listener 泄漏修复 |
| 13 | `src/l2-engine/types.ts` | 改 | `GraphNodeContext.graphSignal` |
| 14 | `src/l2-engine/state-graph.ts` | 改 | 边界块注入 + 上游 probes 注入 + handoff 落盘 + findings 落池 + `graphSignal` 传递 + `checkInputGate` 阈值 + PauseError 分支 |
| 15 | `src/index.ts` | 改 | 注册 `publish_finding` |
| 16 | `src/cli/graph-run-commands.ts` | 改 | 传 `roleDefinition` + 默认 `inputGate` |
| 17 | `src/cli/graph-resume-commands.ts` | 改 | `buildResumePrompt` + 读回产物 + 快照删除时机 |
| 18 | `src/cli/graph-visual-commands.ts` | 改 | 同步 mock 场景 |
| 19 | `src/l4-visual/host/graph-control.ts` | 改 | `resumeGraph` 删 PAUSE 文件 |
| 20 | `src/l4-visual/host/routes.ts` | 改 | pause/resume/stop 简化 |
| 21 | `src/l4-visual/host/event-bus.ts` | 改 | `graph/paused` case |
| 22 | `src/l4-visual/host/event-bridge.ts` | 改 | bus 重建重订阅 |
| 23 | `src/l4-visual/shared/event-schema.ts` | 改 | `graph-error` 类型 |
| 24 | `src/client/hooks/useGraphStream.ts` | 改 | `graph-paused` / `graph-error` / `currentRole` |
| 25 | `src/client/dashboard/NodeActivityPanel.tsx` | 改 | 轮询合并 |

---

# 十二、实施顺序

| Phase | 内容 | 工时 | 门禁 |
|---|---|---|---|
| **A** | 契约（types.ts / role-schema.ts）+ `role-loader` 适配（toolFilter 空不注入） | 0.5d | 旧 YAML 兼容；`pnpm typecheck` 0 error |
| **B** | 6 角色 YAML（删 tools/token_budget，加 role_boundary）+ 6 SKILL.md 提醒章节 | 0.5d | 角色能加载；persona 含提醒 |
| **C** | `role-prompt.ts` + `state-graph` 边界块注入 | 0.5d | R1 prompt 含职责/禁止/产物/探测规范 |
| **D** | `node-validator` 结构化 + `handoff-extractor` + `inputGate` 默认 | 0.5d | 空产出停图；缺 handoff 块失败 |
| **E** | `findings-pool` + `publish-finding-tool` + `index.ts` 注册 | 0.5d | R6 调 publish_finding 后 R7 可查 |
| **F** | 上游注入（handoff probes + findings 池） | 0.5d | R2 prompt 含 R1 探测；R7 无 read R1 |
| **G** | `graph-control` AbortController + `subagent-waiter` 分流 + `graphSignal` 传递 | 0.5d | 长节点暂停 1s 内响应 |
| **H** | `graph-resume-commands` resumePrompt + 快照时机；routes 简化 | 0.5d | 二次恢复可用 |
| **I** | 事件流修正（5 文件） | 0.5d | 断线重连有事件；`graph-paused` 前端可见 |
| **J** | 端到端回归 + 单测 + 文档 | 0.5d | 4 问题逐项过 |

**总工时：5 天**

---

# 十三、验收标准

## 13.1 问题1：角色边界（Prompt 层）

- [ ] 6 角色 YAML **无** `tools:` / `token_budget:`
- [ ] 6 SKILL.md 含"工具使用提醒" + "Token 预算提醒"
- [ ] R1 prompt 含 `【你的职责】` / `【你禁止做的事】` / `【你的产物要求】`
- [ ] R1 产物含 4 章节 + 无代码围栏
- [ ] 人为让 R1 写代码 → `no_code_fence` gate 失败 → 停图

## 13.2 问题2：上下文流转

- [ ] 所有角色产物末尾有 `<!-- weave-handoff -->` 块
- [ ] R6 产物含 ≥ 1 条 probe
- [ ] R2 prompt 含 R1 的 `【已探测（无需重复）】` 段
- [ ] R7 prompt 含 R1/R2/R4/R6 的 probes
- [ ] R7 的 tool-call **无** `read <R1 产物路径>`
- [ ] R7 `inputTokens` 相比修改前下降 ≥ 20%

## 13.3 问题3：空产出停图

- [ ] R1 只回复"完成" → 图暂停，`pauses/<graphId>.json` 存在
- [ ] trace 无 R2 的 node-start
- [ ] 返回 `data: { paused: true, pauseReason: 'tool-error-fatal', resumeFrom: 'r1' }`
- [ ] Web 看板 R1 红色

## 13.4 问题4：暂停/终止

- [ ] 长节点（30s sleep）点"暂停" → **1 秒内** `graph-paused` SSE
- [ ] trace 有 `interrupt` 日志
- [ ] 点"恢复" → 从暂停节点续跑（同 childId，sendMessage）
- [ ] 点"终止" → `graph/end stopped`，不写 PauseSnapshot
- [ ] 断线重连 → SSE 补发断线事件
- [ ] 二次跑图 → 事件流正常

## 13.5 回归

- [ ] `pnpm typecheck` 0 error
- [ ] 新增单测 ≥ 25
- [ ] 现有测试全绿
- [ ] 端到端 R1→R8 全链跑通

---

# 十四、风险与回滚

| 风险 | 缓解 |
|---|---|
| 删 `tools:` 后子代理越权（无工具层拦截） | **完全靠 SKILL.md + Prompt 边界块**；质量门 `no_code_fence` 硬拦 |
| 删 `token_budget` 后无成本上限 | 靠 SKILL.md 提醒 + 引擎侧 `maxIterations` 兜底 |
| 旧第三方 YAML 含 `tools`/`token_budget` | Schema 改可选，兼容 |
| 结构化 gate 后历史角色失败 | 旧字符串自动映射；新 YAML 用宽阈值先跑通 |
| `require_probe_section` 强制后子代理忘写 | Prompt 明确示例；失败信息指出缺块 |
| 上游内容注入使 prompt 过长 | 单产物 8000 字上限；probes 摘要优先 |
| resume 复用 child 上下文污染 | resumePrompt 显式"复盘"；不注入 trajectory；读回产物 |
| `graphSignal` 与 `exec.signal` 冲突 | 优先 `graphSignal`；`settle` 幂等 |

**回滚点**：每 Phase 独立 commit；契约变更向后兼容；`role_boundary` 可选。

---

# 十五、决策锁定

| 决策 | 状态 |
|---|---|
| `reusable` 默认 `true` | ✅ 锁定 |
| 删除 `max_code_lines` | ✅ 锁定 |
| 删除 `tools:` | ✅ 锁定 |
| 删除 `token_budget:` | ✅ 锁定 |
| SKILL.md 提醒为主 | ✅ 锁定 |
| 6 角色 YAML 同步改 | ✅ 锁定 |
| handoff 块注释 + publish_finding 双通道 | ✅ 锁定 |
| resume 复用 child session | ✅ 锁定 |

**方案可执行，等开发启动。**

[动作] 正在向父代理交付四问题修复完整方案 v2.0（工具: send_message）