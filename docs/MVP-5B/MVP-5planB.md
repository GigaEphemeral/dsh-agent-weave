# 方案 B 完整规划（通用版）

> 版本：v1 · 2026-09-26
> 定位：把"上下游节点间的信息传递"从"路径清单"升级为"结构化交接单"，让下游**读得到、不重复探测、能被阻塞**
> 状态：设计定稿，待实施
> 前置：MVP-5 代码层完成，方案 C（MCP/沙箱）推迟到 future

---

## 0. 文档说明

### 0.1 本文档修正的两个错误

**错误 1（前两次回答）**：代码示例里混入了演示数据——`ETF 筛选工具`、`腾讯 API`、`fastapi`、`Python 3.14.6`、`vol186coding` 等。这些词汇来自更早的对话，被误当作示例，导致方案看起来像特化到某个具体项目。

**本文档处理**：所有示例改用通用占位符 `<placeholder>`，并明确标注哪些是"平台契约"（固化）、哪些是"内容"（来自 LLM/运行时）。

**错误 2（第二次回答）**：`extractFactsFromMarkdown` 里用了 `require('./handoff-schema.js')`，违反项目 NodeNext ESM 约定。

**本文档处理**：全部改为静态 `import`。

### 0.2 阅读方式

- **第 1-2 章**：设计原则与数据结构 → 团队必读
- **第 3-5 章**：契约与接口 → 前后端对齐
- **第 6 章**：交互设计 → 前端落地
- **第 7-9 章**：实施计划与错误处理 → 排期与风险
- **第 10 章**：验收标准 → 上线前自检
- **附录**：修正对照表

---

## 1. 设计原则

### 1.1 核心原则：机制与内容分离

```
┌──────────────────────────────────────────────────────────┐
│ weave 平台（本规划范围）                                   │
│                                                           │
│ 提供【机制】：                                             │
│   · HandoffEnvelope 的结构（字段名/类型）                 │
│   · front-matter 的解析（纯语法）                         │
│   · 合并语义（冲突标记/累积规则）                          │
│   · prompt 注入模板（占位符替换）                          │
│   · Provider 探测接口（运行时反射）                        │
│                                                           │
│ 不提供【内容】：                                           │
│   · 键名（如 env.python.version 这种约定）                │
│   · 值（探测结果）                                         │
│   · 摘要/契约/建议（自然语言）                             │
│   · 领域术语（任何行业、任何技术栈）                        │
└──────────────────────────────────────────────────────────┘
              ▲
              │ 通过约定提供
              │
┌─────────────┴──────────────┬───────────────────────────────┐
│ 角色 SKILL.md              │ 运行时数据                     │
│                            │                                │
│ · 键名规范约定             │ · LLM 生成的 facts/artifacts   │
│ · front-matter 必填项       │ · 引擎补全的 hash/size/source  │
│ · 与上下游的交互约定         │ · 探测得到的真实环境事实        │
└────────────────────────────┴───────────────────────────────┘
```

### 1.2 三层分工

| 层 | 负责 | 举例（都是占位符） |
|---|---|---|
| **平台层** | 定义 schema、解析、注入、合并 | `HandoffEnvelope` 的字段定义 |
| **角色层** | 约定键名规范、必填项、交互约定 | "环境事实用 `<domain>.<entity>.<attr>` 三层命名" |
| **数据层** | 具体内容 | `<LLM 探测或生成的内容>` |

### 1.3 通用化边界

| 项 | 平台做 | 角色定义 | 运行时产出 |
|---|---|---|---|
| Handoff schema 结构 | ✅ | — | — |
| front-matter 语法 | ✅ 解析 | — | — |
| 键名规范 | ❌ | ✅ 各角色约定 | — |
| 值的具体内容 | ❌ | — | ✅ LLM |
| 行为约束文字 | ✅ 4 条平台级 | 可追加角色专属 | — |
| prompt 模板骨架 | ✅ 提供 | ✅ 可覆盖 | — |
| Provider 列表 | ✅ 探测机制 | — | ✅ 从 DSH 反射 |
| Capabilities 枚举 | ✅ 8 个通用值 | — | — |
| Tools 枚举 | ✅ 从 `ctx.tools` 反射 | — | — |
| 默认角色内容 | ❌ | ✅ 用户/社区提供 | — |

---

## 2. 数据结构

### 2.1 文件组织

```
src/l2-engine/
├── handoff-schema.ts   【新建】纯 schema + 纯解析（无 IO、无状态）
├── handoff.ts          【重写】读写 + 合并 + prompt 注入（纯函数）
├── project-memory.ts   【重写】仅持有最新 envelope（有状态）
```

**依赖方向严格单向**：

```
handoff-schema.ts
      ↓
handoff.ts
      ↓
project-memory.ts
      ↓
state-graph.ts（使用方）
```

`handoff.ts` 禁止导入 `project-memory.ts`；`project-memory.ts` 的兼容层只导入 `handoff-schema.js`，不导入 `handoff.js`。

### 2.2 HandoffEnvelope（核心类型）

> ⚠️ 以下为设计示例，所有 `<placeholder>` 都是占位符，实际内容由 LLM 或运行时填充。

```typescript
// src/l2-engine/handoff-schema.ts（设计示例）

import { z } from 'zod'
import { load as yamlLoad } from 'js-yaml'

// ─── 子类型 ────────────────────────────────────────────

/** 产物引用（path/hash/size 由引擎补全，其余由 LLM 填） */
export const ArtifactRefSchema = z.object({
  path: z.string().min(1),                 // 相对 artifactsRoot
  kind: z.enum(['doc', 'code', 'test', 'script', 'config', 'data']),
  summary: z.string().default(''),
  contract: z.string().optional(),          // 下游必须遵守的约束（自由文本）
  hash: z.string().default(''),             // 引擎填
  sizeBytes: z.number().int().nonnegative().default(0),  // 引擎填
})

/** 已确认的事实 */
export const ProjectFactSchema = z.object({
  key: z.string().min(1),                   // LLM 自定义，如 <domain>.<entity>.<attr>
  category: z.enum(['environment', 'api', 'constraint', 'file-system', 'reference', 'other']),
  value: z.string(),
  confidence: z.enum(['confirmed', 'assumed', 'conflict']).default('confirmed'),
  summary: z.string().default(''),
  source: z.string().default(''),            // 引擎或 LLM 填
})

/** 环境事实（verified 是探测过的，cmd 是探测方式） */
export const VerifiedFactSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  cmd: z.string().default(''),               // 便于审计
  at: z.number().default(() => Date.now()),
  source: z.string().default(''),
})

/** 未满足的环境前提（blocking 列出阻塞的节点） */
export const UnmetRequirementSchema = z.object({
  key: z.string().min(1),
  required: z.string().default(''),
  suggestion: z.string().default(''),        // LLM 建议的解决方式
  blocking: z.array(z.string()).default([]),
})

/** 未解决问题（suggestedOwner 指向角色 ID 或 'user'） */
export const OpenIssueSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['blocker', 'warning', 'info']).default('warning'),
  summary: z.string(),
  evidence: z.string().default(''),
  suggestedOwner: z.string().default('user'),
  blocking: z.array(z.string()).default([]),
})

// ─── 顶层 ──────────────────────────────────────────────

export const HandoffEnvelopeSchema = z.object({
  schemaVersion: z.literal('1.0').default('1.0'),
  graphId: z.string(),
  nodeId: z.string(),
  roleRef: z.string(),
  at: z.number(),

  artifacts: z.array(ArtifactRefSchema).default([]),
  facts: z.array(ProjectFactSchema).default([]),
  environment: z.object({
    verified: z.array(VerifiedFactSchema).default([]),
    unmet: z.array(UnmetRequirementSchema).default([]),
  }).default({ verified: [], unmet: [] }),
  openIssues: z.array(OpenIssueSchema).default([]),

  handoff: z.object({
    upstream: z.array(z.string()).default([]),   // 读了哪些上游节点
    downstream: z.array(z.string()).default([]), // 建议下游读
    completed: z.boolean().default(false),
  }).default({ upstream: [], downstream: [], completed: false }),
})

export type HandoffEnvelope = z.infer<typeof HandoffEnvelopeSchema>
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>
export type ProjectFact = z.infer<typeof ProjectFactSchema>
export type VerifiedFact = z.infer<typeof VerifiedFactSchema>
export type UnmetRequirement = z.infer<typeof UnmetRequirementSchema>
export type OpenIssue = z.infer<typeof OpenIssueSchema>
```

### 2.3 LLM 侧 front-matter schema（子集）

LLM 只填**内容字段**，引擎补全**元数据字段**。

```typescript
// src/l2-engine/handoff-schema.ts（续）

/** LLM 侧的 front-matter 只覆盖这些字段 */
const FrontMatterSchema = z.object({
  facts: z.array(z.object({
    key: z.string(),
    category: z.enum(['environment', 'api', 'constraint', 'file-system', 'reference', 'other']).optional().default('other'),
    value: z.string(),
    confidence: z.enum(['confirmed', 'assumed']).optional().default('confirmed'),
    summary: z.string().optional().default(''),
  })).optional().default([]),

  artifacts: z.array(z.object({
    path: z.string(),
    kind: z.enum(['doc', 'code', 'test', 'script', 'config', 'data']).optional().default('doc'),
    summary: z.string().optional().default(''),
    contract: z.string().optional(),
  })).optional().default([]),

  environment: z.object({
    verified: z.array(z.object({
      key: z.string(),
      value: z.string(),
      cmd: z.string().optional().default(''),
    })).optional().default([]),
    unmet: z.array(z.object({
      key: z.string(),
      required: z.string().optional().default(''),
      suggestion: z.string().optional().default(''),
      blocking: z.array(z.string()).optional().default([]),
    })).optional().default([]),
  }).optional(),

  openIssues: z.array(z.object({
    id: z.string(),
    severity: z.enum(['blocker', 'warning', 'info']).optional().default('warning'),
    summary: z.string(),
    evidence: z.string().optional().default(''),
    suggestedOwner: z.string().optional().default('user'),
    blocking: z.array(z.string()).optional().default([]),
  })).optional().default([]),
})

/** 从 markdown 的 YAML front-matter 解析 */
export function parseFrontMatter(content: string): z.infer<typeof FrontMatterSchema> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match?.[1]) return null
  let data: unknown
  try {
    data = yamlLoad(match[1])
  } catch {
    return null
  }
  const result = FrontMatterSchema.safeParse(data)
  return result.success ? result.data : null
}

/** 校验完整 envelope（供 readHandoffJson 用） */
export function validateEnvelope(input: unknown): HandoffEnvelope | null {
  const result = HandoffEnvelopeSchema.safeParse(input)
  return result.success ? result.data : null
}
```

---

## 3. LLM 侧契约（角色 SKILL.md 约定）

### 3.1 front-matter 语法

角色产出文件的头部**必须**声明（格式固定，内容自由）：

```markdown
---
facts:
  - key: <LLM 自定>
    category: environment | api | constraint | file-system | reference | other
    value: "<探测或判断的结果>"
    confidence: confirmed | assumed
    summary: "<自然语言摘要>"

artifacts:
  - path: <相对本文件的路径>
    kind: doc | code | test | script | config | data
    summary: "<摘要>"
    contract: |
      <下游必须遵守的约束，可多行>

environment:
  verified:
    - key: <同上>
      value: "<结果>"
      cmd: "<探测方式>"
  unmet:
    - key: <同上>
      required: "<要求>"
      suggestion: "<建议>"
      blocking: [<下游节点 ID 列表>]

openIssues:
  - id: <唯一 ID>
    severity: blocker | warning | info
    summary: "<问题>"
    evidence: "<日志/命令输出>"
    suggestedOwner: <角色 ID 或 "user">
    blocking: [<下游节点 ID 列表>]
---

# <文档正文>
```

### 3.2 6 个角色 SKILL.md 追加的两段

**统一追加**（6 个文件相同模板）：

```markdown
## 【必读】上游交接单

启动第一件事：读 `productions/<上游节点>/handoff.json`（引擎也会自动注入到你的 prompt）。

重点看：
- **artifacts[].contract**：上游交付的契约，你的产出必须遵守
- **environment.verified**：已确认的事实，**禁止重复探测**
- **environment.unmet**：已知未满足，遇到必须停下来问，**禁止静默降级**
- **openIssues.suggestedOwner == "<你的角色>"**：**你必须处理**

## 【必写】你的交接单

在产出文件的 YAML front-matter 里声明（引擎自动解析补全）。

约定：
- **环境事实** 键名用三层：`<domain>.<entity>.<attr>`
- **API 事实** 键名用三层：`<service>.<resource>.<status>`
- **约束** 键名用两层：`<scope>.<constraint>`
- 无法归类时 `category: other`

完整字段见引擎文档。
```

**⚠️ 上述 `<domain>` / `<service>` 是占位，实际约定由团队在具体项目落地时填写。**

---

## 4. 引擎侧逻辑（handoff.ts）

### 4.1 三个核心函数

| 函数 | 职责 | 输入 | 输出 |
|---|---|---|---|
| `parseHandoffFromMarkdown` | 从 md 文本生成完整 envelope（补全 hash/size/path） | `content` + 上下文 | `HandoffEnvelope` |
| `mergeEnvelopes` | 合并上游累积 envelope 与当前节点 | `prev`, `curr` | `HandoffEnvelope` |
| `buildHandoffSection` | 生成 prompt 注入段 | `env`, `myRole` | `string` |

### 4.2 parseHandoffFromMarkdown（设计示例）

```typescript
// src/l2-engine/handoff.ts（设计示例）

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  HandoffEnvelope, ArtifactRef, ProjectFact,
  parseFrontMatter,
} from './handoff-schema.js'

export interface ParseHandoffOptions {
  graphId: string
  nodeId: string
  roleRef: string
  /** 产物根目录 */
  artifactsRoot: string
  /** 本节点产物文件绝对路径 */
  artifactAbsolutePath: string
}

export function parseHandoffFromMarkdown(
  content: string,
  opts: ParseHandoffOptions,
): HandoffEnvelope {
  const fm = parseFrontMatter(content) ?? { facts: [], artifacts: [], openIssues: [] }

  // 补全 artifacts：路径转相对、算 hash/size
  const artifacts: ArtifactRef[] = (fm.artifacts ?? []).map((a) => {
    const abs = join(dirname(opts.artifactAbsolutePath), a.path)
    return {
      path: relative(opts.artifactsRoot, abs).replace(/\\/g, '/'),
      kind: a.kind,
      summary: a.summary,
      ...(a.contract !== undefined ? { contract: a.contract } : {}),
      hash: existsSync(abs) ? sha256OfFile(abs) : '',
      sizeBytes: existsSync(abs) ? statSync(abs).size : 0,
    }
  })

  // 若本文件不在 artifacts 里，引擎自动补一条
  const selfPath = relative(opts.artifactsRoot, opts.artifactAbsolutePath).replace(/\\/g, '/')
  if (!artifacts.some((a) => a.path === selfPath)) {
    artifacts.unshift({
      path: selfPath,
      kind: 'doc',
      summary: '',
      hash: sha256OfFile(opts.artifactAbsolutePath),
      sizeBytes: statSync(opts.artifactAbsolutePath).size,
    })
  }

  // 补全 facts/environment.verified 的 source
  const facts: ProjectFact[] = (fm.facts ?? []).map((f) => ({
    ...f,
    source: opts.roleRef,
  }))
  const verified = (fm.environment?.verified ?? []).map((v) => ({
    ...v,
    at: Date.now(),
    source: opts.roleRef,
  }))

  return {
    schemaVersion: '1.0',
    graphId: opts.graphId,
    nodeId: opts.nodeId,
    roleRef: opts.roleRef,
    at: Date.now(),
    artifacts,
    facts,
    environment: {
      verified,
      unmet: fm.environment?.unmet ?? [],
    },
    openIssues: fm.openIssues ?? [],
    handoff: { upstream: [], downstream: [], completed: false },
  }
}

function sha256OfFile(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}
```

### 4.3 mergeEnvelopes（设计示例）

```typescript
// src/l2-engine/handoff.ts（续）

export function mergeEnvelopes(
  prev: HandoffEnvelope | null,
  curr: HandoffEnvelope,
): HandoffEnvelope {
  if (!prev) return { ...curr, handoff: { ...curr.handoff, upstream: [] } }

  return {
    ...curr,
    // facts：冲突时标 conflict（保留 LLM 原 confidence 除非值不同）
    facts: mergeFacts(prev.facts, curr.facts),
    // verified：key 相同保留最新
    environment: {
      verified: mergeVerified(prev.environment.verified, curr.environment.verified),
      // unmet：若当前节点解决了上游 unmet，则不再传递
      unmet: curr.environment.unmet.filter(
        (u) => !curr.environment.verified.some((v) => v.key === u.key),
      ),
    },
    openIssues: mergeOpenIssues(prev.openIssues, curr.openIssues),
    handoff: {
      upstream: [...new Set([...prev.handoff.upstream, prev.nodeId])],
      downstream: curr.handoff.downstream,
      completed: true,
    },
  }
}

function mergeFacts(prev: ProjectFact[], curr: ProjectFact[]): ProjectFact[] {
  const map = new Map(prev.map((f) => [f.key, f]))
  for (const f of curr) {
    const old = map.get(f.key)
    if (old && old.value !== f.value) {
      map.set(f.key, {
        ...f,
        confidence: 'conflict',
        summary: f.summary
          ? `${f.summary}（与 ${old.source} 的 "${old.value}" 冲突）`
          : `与 ${old.source} 的 "${old.value}" 冲突`,
      })
    } else {
      map.set(f.key, f)
    }
  }
  return [...map.values()]
}

function mergeVerified(prev: VerifiedFact[], curr: VerifiedFact[]): VerifiedFact[] {
  const map = new Map(prev.map((v) => [v.key, v]))
  for (const v of curr) map.set(v.key, v)
  return [...map.values()]
}

function mergeOpenIssues(prev: OpenIssue[], curr: OpenIssue[]): OpenIssue[] {
  // 约定：curr 里同 id 出现视为"关闭"（覆盖 prev）
  const currIds = new Set(curr.map((i) => i.id))
  return [...prev.filter((i) => !currIds.has(i.id)), ...curr]
}
```

### 4.4 buildHandoffSection（设计示例）

```typescript
// src/l2-engine/handoff.ts（续）

export function buildHandoffSection(env: HandoffEnvelope, myRole: string): string {
  const lines: string[] = ['【上游交接单】']

  if (env.artifacts.length > 0) {
    lines.push('\n## 你必须读取的产物')
    for (const a of env.artifacts) {
      lines.push(`- [${a.kind}] ${a.path}`)
      if (a.summary) lines.push(`  ${a.summary}`)
      if (a.contract) {
        lines.push('  契约：')
        for (const l of a.contract.split('\n')) lines.push(`    ${l}`)
      }
    }
  }

  if (env.environment.verified.length > 0) {
    lines.push('\n## 已确认的事实（禁止重复探测）')
    for (const v of env.environment.verified) {
      lines.push(`✓ ${v.key} = ${v.value}  （来自 ${v.source}，命令：${v.cmd}）`)
    }
  }

  if (env.environment.unmet.length > 0) {
    lines.push('\n## 已知未满足（遇到必须停）')
    for (const u of env.environment.unmet) {
      lines.push(`⚠ ${u.key} 需 ${u.required} → ${u.suggestion}`)
      if (u.blocking.length > 0) lines.push(`  阻塞：${u.blocking.join(', ')}`)
    }
  }

  const mine = env.openIssues.filter((i) => i.suggestedOwner === myRole)
  if (mine.length > 0) {
    lines.push(`\n## 指派给你的问题（${myRole}）`)
    for (const i of mine) {
      lines.push(`[${i.severity}] ${i.summary}`)
      if (i.evidence) lines.push(`  证据：${i.evidence}`)
    }
  }

  lines.push(`
【行为约束】
- 读上面列出的产物后再动手
- 不要重复探测"已确认的事实"里列出的内容
- 遇到"已知未满足"必须停止（ask_user_question 或 update_goal(blocked)）
- 处理"指派给你的问题"里列出的项
`)
  return lines.join('\n')
}
```

### 4.5 IO 函数（设计示例）

```typescript
// src/l2-engine/handoff.ts（续）

import { mkdirSync, writeFileSync } from 'node:fs'

export function handoffJsonPath(nodeDir: string): string {
  return join(nodeDir, 'handoff.json')
}

export function writeHandoffJson(nodeDir: string, env: HandoffEnvelope): void {
  mkdirSync(nodeDir, { recursive: true })
  writeFileSync(handoffJsonPath(nodeDir), JSON.stringify(env, null, 2), 'utf8')
}

export function readHandoffJson(nodeDir: string): HandoffEnvelope | null {
  const file = handoffJsonPath(nodeDir)
  if (!existsSync(file)) return null
  try {
    return validateEnvelope(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}
```

### 4.6 ProjectMemory（重写）

```typescript
// src/l2-engine/project-memory.ts（设计示例）

import type { HandoffEnvelope, ProjectFact } from './handoff-schema.js'
import { mergeEnvelopes, buildHandoffSection } from './handoff.js'

export interface ProjectMemoryOptions {
  artifactsRoot?: string
}

export class ProjectMemory {
  private latest: HandoffEnvelope | null = null
  private byNode = new Map<string, HandoffEnvelope>()

  constructor(private readonly opts: ProjectMemoryOptions = {}) {}

  // ─── 新 API ──────────────────────────────────────────

  mergeEnvelope(nodeId: string, envelope: HandoffEnvelope): void {
    this.byNode.set(nodeId, envelope)
    this.latest = mergeEnvelopes(this.latest, envelope)
  }

  current(): HandoffEnvelope | null {
    return this.latest
  }

  byNodeId(nodeId: string): HandoffEnvelope | null {
    return this.byNode.get(nodeId) ?? null
  }

  toPromptSection(myRole = ''): string {
    return this.latest ? buildHandoffSection(this.latest, myRole) : ''
  }

  // ─── 兼容层（保留旧 API，内部转发） ─────────────────────

  /** @deprecated 用 mergeEnvelope */
  setFact(fact: ProjectFact): void {
    if (!this.latest) {
      this.latest = emptyEnvelope()
    }
    this.latest = mergeEnvelopes(this.latest, { ...this.latest, facts: [fact] })
  }

  /** @deprecated 用 mergeEnvelope */
  setFacts(facts: readonly ProjectFact[]): void {
    for (const f of facts) this.setFact(f)
  }

  /** @deprecated 用 current()?.facts */
  all(): ProjectFact[] {
    return this.latest?.facts ?? []
  }

  /** @deprecated 用 current()?.facts.filter(f => f.confidence === 'conflict') */
  conflicts(): ProjectFact[] {
    return (this.latest?.facts ?? []).filter((f) => f.confidence === 'conflict')
  }

  /** @deprecated 保留兼容 */
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

function emptyEnvelope(): HandoffEnvelope {
  return {
    schemaVersion: '1.0',
    graphId: '', nodeId: '', roleRef: '', at: Date.now(),
    artifacts: [], facts: [],
    environment: { verified: [], unmet: [] },
    openIssues: [],
    handoff: { upstream: [], downstream: [], completed: false },
  }
}

// ─── 兼容层：旧函数转发 ────────────────────────────────

import { parseFrontMatter } from './handoff-schema.js'

/** @deprecated 用 parseFrontMatter + parseHandoffFromMarkdown */
export function extractFactsFromMarkdown(content: string, source: string): ProjectFact[] {
  const fm = parseFrontMatter(content)
  if (!fm?.facts) return []
  return fm.facts.map((f) => ({ ...f, source }))
}
```

---

## 5. 后端 API 契约

### 5.1 新增 `GET /api/weave/providers`

```typescript
// 响应
{
  "providers": [
    {
      "id": "<provider id>",
      "name": "<display name>",
      "models": ["<model 1>", "<model 2>"],
      "defaultModel": "<model 1>",
      "source": "dynamic" | "yaml-scan" | "static"
    }
  ],
  "probedAt": 1758880000000,
  "overallSource": "dynamic" | "yaml-scan" | "static"
}
```

**`source` 语义**：

| 值 | 含义 | 前端显示 |
|---|---|---|
| `dynamic` | 从 DSH 运行时反射得到 | 无标记（最可信） |
| `yaml-scan` | 从 `roles/*.yaml` 聚合出现过的 | 灰色标记 |
| `static` | 从配置文件兜底 | 黄色标记 + tooltip |

### 5.2 新增 `GET /api/weave/graph/:graphId/handoff`

```typescript
// 响应
{
  "latest": HandoffEnvelope,               // 合并后的全局交接单
  "byNode": {                              // 各节点的原始 envelope
    "<nodeId>": HandoffEnvelope,
    ...
  }
}
```

### 5.3 扩展 `POST /api/weave/roles`

```typescript
// 请求体
{
  "id": "<role id>",
  "name": "<显示名>",
  "description": "<描述>",
  "order": 10,
  "tags": ["<tag>"],
  "provider": "<provider id>",
  "model": "<model id>",
  "capabilities": ["<capability>"],
  "tools": ["<tool>"],
  "readable": ["<glob>"],
  "input": { "requires": ["<node id>"] },
  "output": {
    "onlyMarkdown": true,
    "forbidExtensions": ["<ext>"],
    "requiredSections": ["<section>"]
  },
  "forbidden": ["<禁止项>"]
}

// 响应
{ "ok": true, "id": "<role id>", "path": "roles/<role id>.yaml" }
```

### 5.4 扩展 `GET /api/weave/capabilities` 和 `GET /api/weave/tools`

```typescript
// GET /api/weave/capabilities
{ "capabilities": ["read", "analyze", "write-doc", "write-code", "run-cmd", "run-tests", "review", "spawn"] }

// GET /api/weave/tools
{ "tools": ["<tool 1>", "<tool 2>", ...] }   // 从 ctx.tools 反射
```

**为什么这两个 API 也新增**：前端角色编辑器需要**动态**填充候选值，不硬编码。

---

## 6. 前端交互设计

### 6.1 面板常驻挂载

```tsx
// src/l4-visual/client/index.tsx（设计示例）

export function apply(ctx: Context): void {
  const slots = ctx.slots
  if (!slots) return

  // ⚠️ 关键：编辑面板 + 确认弹窗挂到 always-on 容器
  //    不依赖 dashboard 开关（修 MVP-5 缺陷 M4）
  slots.inject('app.root', () => slots.register(
    { name: 'app.root', id: 'weave-overlays', order: 100 },
    WeaveOverlays,
  ))

  slots.inject('conversation.session.header.actions', () => slots.register(
    { name: 'conversation.session.header.actions', id: 'weave-dashboard-toggle', order: 0 },
    WeaveDashboardButton,
  ))

  slots.inject('conversation.view', () => slots.register(
    { name: 'conversation.view', id: 'weave-dashboard', order: 10 },
    WeaveDashboardView,
  ))
}

function WeaveOverlays() {
  return (
    <>
      <WeaveEditPanel />
      <UserQuestionModal />
    </>
  )
}
```

### 6.2 面板挤压主区

```css
.weave-edit-panel {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: 720px;
  transform: translateX(100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  z-index: 1000;
}
.weave-edit-panel.open { transform: translateX(0); }

/* ⚠️ 主区被挤压（决策 #4：主 agent 仍可见） */
body.weave-panel-open main {
  margin-right: 720px;
  transition: margin-right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
```

```tsx
// WeaveEditPanel.tsx（设计示例）

export function WeaveEditPanel() {
  const [task, setTask] = useState<TaskDraftView | null>(null)

  useEffect(() => {
    document.body.classList.toggle('weave-panel-open', !!task)
  }, [task])

  useEffect(() => {
    const onProposed = async (e: Event) => {
      const { taskId } = (e as CustomEvent<{ taskId: string }>).detail
      const t = await fetch(`/api/weave/tasks/${taskId}`).then((r) => r.json())
      setTask(t)
      // ⚠️ 进入面板即 drafting（修 M5）
      await fetch(`/api/weave/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'drafting' }),
      })
    }
    window.addEventListener('weave:task-proposed', onProposed)
    return () => window.removeEventListener('weave:task-proposed', onProposed)
  }, [])

  if (!task) return null

  return (
    <div className="weave-edit-panel open">
      <header>
        <h3>编辑工作流：{task.template}</h3>
        <button onClick={() => setTask(null)}>×</button>
      </header>
      <CanvasEditor initialGraph={task.graph} onGraphChange={(s) => setDraftSpec(s)} />
      <footer>
        <button onClick={handleCancel}>取消</button>
        <button onClick={handleSave}>保存图</button>
        <button onClick={handleStart} className="primary">开始工作</button>
      </footer>
    </div>
  )
}
```

### 6.3 角色编辑器

> ⚠️ 所有候选值都从 API 动态拉取，不硬编码。

```tsx
// src/l4-visual/client/dashboard/RoleEditor.tsx（设计示例）

export function RoleEditor({ roleId, onClose }: Props) {
  const isNew = !roleId
  const [role, setRole] = useState<RoleFormData | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [availableTools, setAvailableTools] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // ⚠️ 三处都不硬编码，全部从 API 拉
    Promise.all([
      fetch('/api/weave/providers').then((r) => r.json()),
      fetch('/api/weave/capabilities').then((r) => r.json()),
      fetch('/api/weave/tools').then((r) => r.json()),
      roleId
        ? fetch(`/api/weave/roles/${roleId}`).then((r) => r.json())
        : Promise.resolve(BLANK_ROLE),
    ])
      .then(([p, c, t, r]) => {
        setProviders(p.providers)
        setCapabilities(c.capabilities)
        setAvailableTools(t.tools)
        setRole(r)
      })
      .finally(() => setLoading(false))
  }, [roleId])

  if (loading || !role) return <Modal><Spinner /></Modal>

  return (
    <Modal wide>
      <ModalHeader title={isNew ? '新建角色' : role.name} onClose={onClose} />
      <ModalBody>

        <Section title="基本信息">
          <FieldRow>
            <Field label="角色 ID" required>
              <input value={role.id} disabled={!isNew} onChange={...} />
            </Field>
            <Field label="名称" required>
              <input value={role.name} onChange={...} />
            </Field>
          </FieldRow>
          <Field label="描述">
            <input value={role.description} onChange={...} />
          </Field>
          <FieldRow>
            <Field label="排序"><input type="number" value={role.order} onChange={...} /></Field>
            <Field label="标签（逗号分隔）">
              <input value={role.tags.join(',')} onChange={...} />
            </Field>
          </FieldRow>
        </Section>

        <Section title="大模型提供者">
          <FieldRow>
            <Field label="Provider">
              <select value={role.provider} onChange={...}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.source !== 'dynamic' && `（来源：${p.source}）`}
                  </option>
                ))}
              </select>
              <Hint>数据来源：/api/weave/providers</Hint>
            </Field>
            <Field label="模型">
              <select value={role.model} onChange={...}>
                {providers.find((p) => p.id === role.provider)?.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </Field>
          </FieldRow>
        </Section>

        <Section title="能力集（capabilities）">
          <ChipGroup options={capabilities} value={role.capabilities} onChange={...} />
          <Hint>数据来源：/api/weave/capabilities</Hint>
        </Section>

        <Section title="工具白名单（tools）">
          <ChipGroup options={availableTools} value={role.tools} onChange={...} />
          <Hint>数据来源：/api/weave/tools</Hint>
        </Section>

        <Section title="可读范围（readable）">
          <textarea
            value={role.readable.join('\n')}
            rows={3}
            onChange={...}
            placeholder={"每行一个 glob，如：\nsrc/**\nproductions/**"}
          />
        </Section>

        <Section title="输入门禁（input.requires）">
          <input value={role.input.requires.join(',')} onChange={...} />
          <Hint>逗号分隔的上游节点 ID，缺失则节点不启动</Hint>
        </Section>

        <Section title="输出约束（output）">
          <label><input type="checkbox" checked={role.output.onlyMarkdown} onChange={...} /> 仅允许 .md</label>
          <Field label="禁止扩展名">
            <input value={role.output.forbidExtensions.join(',')} onChange={...} />
          </Field>
          <Field label="必需章节">
            <input value={role.output.requiredSections.join(',')} onChange={...} />
          </Field>
        </Section>

        <Section title="非职责（forbidden）">
          <textarea
            value={role.forbidden.join('\n')}
            rows={3}
            onChange={...}
            placeholder={"每行一条，如：\n<禁止项 1>\n<禁止项 2>"}
          />
        </Section>

      </ModalBody>
      <ModalFooter>
        {!isNew && <button danger onClick={handleDelete}>删除角色</button>}
        <button onClick={onClose}>取消</button>
        <button primary onClick={handleSave}>{isNew ? '创建' : '保存'}</button>
      </ModalFooter>
    </Modal>
  )
}
```

### 6.4 节点编辑器

```tsx
// CanvasEditor.tsx 内（设计示例）

function NodeEditor({ nodeId, onClose }: Props) {
  const [node, setNode] = useState<EditorNode>(() => getNode(nodeId))
  const [roles, setRoles] = useState<RoleLibraryEntry[]>([])

  useEffect(() => {
    fetch('/api/weave/roles').then((r) => r.json()).then(setRoles)
  }, [])

  return (
    <Modal>
      <ModalHeader title={`节点配置 · ${node.roleName}`} onClose={onClose} />
      <ModalBody>
        <FieldRow>
          <Field label="节点 ID">
            <input value={node.nodeId} onChange={...} />
          </Field>
          <Field label="角色 (roleRef)">
            <select value={node.roleRef} onChange={...}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>{r.name} · {r.id}</option>
              ))}
            </select>
          </Field>
        </FieldRow>

        <FieldRow>
          <Field label="产物文件名">
            <input value={node.artifactName} placeholder={`${node.nodeId}.md`} onChange={...} />
          </Field>
          <Field label="模型覆盖">
            <input value={node.modelOverride} placeholder="默认" onChange={...} />
          </Field>
        </FieldRow>

        <Field label="Prompt 模板">
          <textarea
            value={node.promptTemplate}
            rows={5}
            placeholder="（空 = 使用角色默认 prompt）"
            onChange={...}
          />
        </Field>

        <Field label="输入门禁（上游节点 ID，逗号分隔）">
          <input value={node.inputGate} placeholder="<node id 1>, <node id 2>" onChange={...} />
        </Field>

        <Field label="输出约束">
          <label><input type="checkbox" checked={node.onlyMarkdown} onChange={...} /> 仅允许 .md</label>
          <label><input type="checkbox" checked={node.outputNonEmpty} onChange={...} /> 产物非空</label>
          <label><input type="checkbox" checked={node.approval} onChange={...} /> 需用户审批</label>
        </Field>
      </ModalBody>
      <ModalFooter>
        <button danger onClick={handleDelete}>删除节点</button>
        <button onClick={onClose}>取消</button>
        <button primary onClick={handleSave}>保存</button>
      </ModalFooter>
    </Modal>
  )
}
```

### 6.5 交接单展示（新增交互）

```tsx
// src/l4-visual/client/dashboard/HandoffViewer.tsx（设计示例）

export function HandoffViewer({ graphId }: { graphId: string | null }) {
  const [data, setData] = useState<{ latest: HandoffEnvelope; byNode: Record<string, HandoffEnvelope> } | null>(null)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)

  useEffect(() => {
    if (!graphId) return
    fetch(`/api/weave/graph/${graphId}/handoff`).then((r) => r.json()).then(setData)
  }, [graphId])

  if (!data) return <div className="handoff-viewer">（暂无交接数据）</div>

  const env = selectedNode ? data.byNode[selectedNode] : data.latest
  if (!env) return null

  return (
    <div className="handoff-viewer">
      <header>
        <h3>交接单</h3>
        <select value={selectedNode ?? ''} onChange={(e) => setSelectedNode(e.target.value || null)}>
          <option value="">（合并全局）</option>
          {Object.keys(data.byNode).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </header>

      <section>
        <h4>产物（{env.artifacts.length}）</h4>
        {env.artifacts.map((a) => (
          <div key={a.path} className="artifact-item">
            <span className="kind">[{a.kind}]</span>
            <span className="path">{a.path}</span>
            <span className="size">{formatBytes(a.sizeBytes)}</span>
            {a.contract && <pre className="contract">{a.contract}</pre>}
          </div>
        ))}
      </section>

      <section>
        <h4>已确认事实（{env.environment.verified.length}）</h4>
        {env.environment.verified.map((v) => (
          <div key={v.key} className="fact-item">
            <code>{v.key}</code> = <strong>{v.value}</strong>
            <span className="source">来自 {v.source}</span>
          </div>
        ))}
      </section>

      {env.environment.unmet.length > 0 && (
        <section className="unmet">
          <h4>未满足（{env.environment.unmet.length}）</h4>
          {env.environment.unmet.map((u) => (
            <div key={u.key} className="unmet-item">
              <code>{u.key}</code> 需 <strong>{u.required}</strong>
              <div className="suggestion">{u.suggestion}</div>
              <div className="blocking">阻塞：{u.blocking.join(', ')}</div>
            </div>
          ))}
        </section>
      )}

      {env.openIssues.length > 0 && (
        <section>
          <h4>未解决问题（{env.openIssues.length}）</h4>
          {env.openIssues.map((i) => (
            <div key={i.id} className={`issue-item issue-${i.severity}`}>
              <span className="id">{i.id}</span>
              <span className="summary">{i.summary}</span>
              <span className="owner">{i.suggestedOwner}</span>
              <pre className="evidence">{i.evidence}</pre>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
```

### 6.6 交互流程

```
主 agent 调 weave_propose_task
       │
       │ SSE: task-proposed
       ▼
WeaveOverlays（always-on）
   ├─ WeaveEditPanel → fetch task → 滑出 + PATCH drafting
   └─ UserQuestionModal 待命
       │
   用户操作：拖角色 / 双击节点编辑 / + 新建角色
       │
   点击【开始工作】→ POST /tasks/:id/start
       │
       ▼
   引擎执行：
     节点 A → 无上游交接单
             → 产出 artifact + handoff.json
     节点 B → 引擎读 A 的 handoff.json
             → buildHandoffSection 注入 prompt
             → B 不重复探测 A 已确认的事实
             → 产出 artifact + handoff.json（合并 A）
     节点 C/D/E 同理
       │
       │ SSE: node-end { handoff: {...} }
       │ SSE: graph-paused { pauseReason, taskId }
       ▼
   前端响应：
   · 看板：HandoffViewer 展示累积交接单
   · 暂停：UserQuestionModal 弹窗（带 taskId）
   · 完成：产物列表 + 交接单摘要
```

---

## 7. 关键设计决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | handoff.json 由引擎写，不由 LLM 写 | LLM 只写 front-matter；JSON 结构由引擎保证稳定 |
| 2 | facts 与 artifacts 分离 | facts 是"探测结论"（复用），artifacts 是"交付物"（读+遵守契约） |
| 3 | environment.unmet 带 blocking | 不是所有 unmet 都阻塞；只有指定下游才停 |
| 4 | openIssues 带 suggestedOwner | 精确指派，不打扰无关角色 |
| 5 | front-matter 而非独立 JSON | LLM 更熟悉 markdown front-matter；文件随 md 移动 |
| 6 | source 字段暴露降级 | provider 探测可能降级；前端显示来源让用户感知 |
| 7 | 面板挤压主区而非覆盖 | 主 agent 仍可见 |
| 8 | 常驻挂载而非依赖 dashboard | 用户不点看板也能被唤起 |
| 9 | 进入面板即 drafting | 状态机语义对齐 |
| 10 | graph-paused 事件带 taskId | 回答链路才走得通 |
| 11 | 依赖方向严格单向 | schema → handoff → project-memory，无循环 |
| 12 | 保留旧 API 为 deprecated | 渐进迁移，不破坏现有调用 |

---

## 8. 分批实施计划

### B1 · 交接单数据结构层（1.5d）

**新建**：
- `src/l2-engine/handoff-schema.ts`（纯 schema + parseFrontMatter + validateEnvelope）

**重写**：
- `src/l2-engine/handoff.ts`（合并旧 Handoff + 新增 envelope 逻辑）
- `src/l2-engine/project-memory.ts`（内部持有 envelope）

**交付可验证**：
- 单测：`handoff.spec.ts` 覆盖 parse/merge/build 三个函数

### B2 · 引擎接入层（2d）

**修改**：
- `src/l2-engine/state-graph.ts` ⭐ 核心
  - 节点启动时：`projectMemory.current()` → `buildHandoffSection(env, myRole)` 注入 prompt
  - 节点完成时：`parseHandoffFromMarkdown` → `writeHandoffJson` → `projectMemory.mergeEnvelope`
- `src/cli/graph-run-commands.ts`：`new ProjectMemory({ artifactsRoot: root })`
- `src/cli/graph-resume-commands.ts`：从 `productions/*/handoff.json` 重建 projectMemory

**交付可验证**：
- 跑一个 3 节点图（mock 或真实），`productions/*/handoff.json` 出现
- 第二个节点的 prompt 含"【上游交接单】"

### B3 · 门禁回写与产物扫描（0.5d）

**修改**：
- `src/l2-engine/environment-gate.ts`：返回 `PreflightResult`（含 verified/unmet）
- `src/l2-engine/output-gate.ts`：返回 `scannedArtifacts`（补 hash/size）

### B4 · 角色契约层（1d）

**修改** 6 个 `roles/*/SKILL.md`：
- 追加【必读】上游交接单
- 追加【必写】你的交接单

### B5 · 恢复与快照（0.5d）

**修改**：
- `src/l2-engine/pause-snapshot.ts`：`PauseSnapshot` 加 `projectMemorySnapshot?: HandoffEnvelope`
- `src/l2-engine/types.ts`：`PauseSnapshot<T>` 同步加字段

### B6 · 前端交互（2.5d，可与 B1-B5 并行）

**新建**：
- `src/l4-visual/client/dashboard/RoleEditor.tsx`
- `src/l4-visual/host/provider-registry.ts`
- `src/l4-visual/client/dashboard/HandoffViewer.tsx`

**修改**：
- `src/l4-visual/client/index.tsx`：常驻挂载 WeaveOverlays
- `src/l4-visual/client/dashboard/WeaveEditPanel.tsx`：主区挤压 + PATCH drafting
- `src/l4-visual/client/dashboard/CanvasEditor.tsx`：节点编辑器
- `src/l4-visual/client/dashboard/RoleLibraryPanel.tsx`：+ 新建 + ⚙ 编辑
- `src/l4-visual/host/routes.ts`：新增 `/providers`、`/capabilities`、`/tools`、`/handoff`

### B7 · 测试与验收（1.5d）

**新建**：
- `tests/l2-engine/handoff.spec.ts`
- `tests/l2-engine/handoff-inject.spec.ts`
- `tests/l4-visual/provider-registry.spec.ts`

**修改**：
- `test-env/verify-mvp5.ps1`：加入新 spec

### 依赖关系

```
B1 ──→ B2 ──→ B3
       │
       └──→ B4
       │
       └──→ B5

B6 独立（可与 B1-B5 并行）

B7 依赖 B1-B6 全部完成
```

**关键路径**：B1 → B2 → B4 → B7（约 6d）
**总工时**：约 9.5d

---

## 9. 错误处理与兼容层

### 9.1 A/B 合并时的类型不兼容

| # | 冲突 | 处理 |
|---|---|---|
| E1 | `artifacts`: A `string[]` vs 新 `ArtifactRef[]` | 加 `artifactsAsPaths(env): string[]`；调用方改 `.path` |
| E2 | `openIssues`: A `string[]` vs 新 `OpenIssue[]` | 加 `openIssuesAsStrings(env): string[]` |
| E3 | `provenance` vs 新 `handoff` | 加 `fromLegacyHandoff(legacy): HandoffEnvelope` 适配 |
| E4 | `ProjectMemory` 构造签名变化 | 可选参数，无参调用仍可用 |
| E5 | `setFact` 在 `latest === null` 时 | 自动创建空 envelope 再合并 |
| E6 | `require` 违反 ESM | **全改静态 `import`** |
| E7 | `mergeFacts` 覆盖 LLM `confidence` | 仅值不同才标 conflict；否则保留 LLM 原值 |
| E8 | `handoff ↔ project-memory` 循环依赖 | 严格单向；兼容层只导入 schema |

### 9.2 两组同名文件的处理

**`types.ts` x 2**：

| 现名 | 改为 | 理由 |
|---|---|---|
| `src/shared/types.ts` | `src/shared/role-types.ts` | 内容是角色定义 |
| `src/l2-engine/types.ts` | 保持 | 引擎类型 |

**`graph-control.ts` x 2**：

| 现名 | 改为 | 理由 |
|---|---|---|
| `src/l2-engine/graph-control.ts` | `src/l2-engine/graph-control-memory.ts` | 内存控制 |
| `src/l4-visual/host/graph-control.ts` | `src/l4-visual/host/graph-control-flagfile.ts` | 文件标志位 |

### 9.3 迁移清单（调用方要改的地方）

| 调用方 | 现状 | 改为 |
|---|---|---|
| `state-graph.ts` | `projectMemory.setFacts(facts)` | `projectMemory.mergeEnvelope(nodeId, envelope)` |
| `state-graph.ts` | `projectMemory.toPromptSection()` | `projectMemory.toPromptSection(myRole)` |
| `state-graph.ts` | `extractFactsFromMarkdown(text, source)` | `parseHandoffFromMarkdown(text, opts)` |
| `cli/graph-run-commands.ts` | `new ProjectMemory()` | `new ProjectMemory({ artifactsRoot: root })` |
| `cli/graph-resume-commands.ts` | 无 projectMemory | 从 handoff.json 重建 |

共 ~6 处。

---

## 10. 验收标准

### 10.1 代码层（可单测）

| # | 场景 | 期望 |
|---|---|---|
| 1 | `parseHandoffFromMarkdown` 空输入 | 返回合法空 shell（不崩） |
| 2 | `parseHandoffFromMarkdown` 有 front-matter | 补全 path/hash/size |
| 3 | `mergeEnvelopes(null, curr)` | 返回 curr 副本，不修改入参 |
| 4 | `mergeEnvelopes(prev, curr)` facts 冲突 | 该项 `confidence='conflict'` |
| 5 | `mergeEnvelopes` 时 curr 解决 prev.unmet | 合并后不含该 unmet |
| 6 | `buildHandoffSection` 指派过滤 | 只显示 `suggestedOwner === myRole` |
| 7 | `extractFactsFromMarkdown` 兼容 | 返回 `ProjectFact[]` |
| 8 | `ProjectMemory` 空态 setFact | `current()` 非 null |
| 9 | `pnpm build` | 通过（ESM 无循环） |
| 10 | 旧 API deprecated 转发 | 功能不变 |

### 10.2 运行时（mock 图）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 跑 3 节点图 | `productions/*/handoff.json` 出现 3 个 |
| 2 | 节点 B 的 prompt | 含"【上游交接单】"和节点 A 的 artifacts |
| 3 | 节点 C 的 prompt | 含 A+B 累积的 facts |
| 4 | 节点 A 声明 unmet.blocking=[B] | 节点 B 启动时图暂停 |

### 10.3 端到端（真实 LLM）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 用户说"用 weave 创建 <任意需求>" | 主 agent 调 weave_propose_task |
| 2 | 面板编辑 → 开始 | 图执行 |
| 3 | 查看 trace | 节点 B 的 prompt 含上游交接单 |
| 4 | 查看 node-activity | 节点 B 无重复探测（上游已验证的命令） |
| 5 | 前端 HandoffViewer | 展示累积 facts/artifacts/openIssues |
| 6 | 前端新建角色 | Provider 下拉有数据（不硬编码） |
| 7 | 前端双击节点 | 弹出节点编辑器 |

### 10.4 反例（必须不通过）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 前端代码里搜 provider id | 0 结果 |
| 2 | 前端代码里搜 `<特定工具名>` | 0 结果 |
| 3 | 平台代码里搜领域术语 | 0 结果 |
| 4 | `handoff.ts` 导入 `project-memory.ts` | 应报编译错误 |

---

## 附录 A：修正对照表（演示数据 → 通用占位符）

| 前两次回答里的演示数据 | 性质 | 本文档替换为 |
|---|---|---|
| `<特定产品>需求文档` | 演示 | `<LLM 生成的产物名>` |
| `api.<某服务>.<某实体>` | 演示 | `<service>.<resource>.<status>` |
| `pip install <某依赖>` | 演示 | `<LLM 建议的解决方式>` |
| `<某语言> <版本号>` | 演示 | `<探测得到的真实结果>` |
| `<某 provider id>` | 演示 | `<DSH 环境里的 provider id>` |
| `<某角色 id>` | 演示 | `<角色 YAML 里定义的 id>` |
| `沙箱拦截 <某命令>` | 演示 | `<LLM 判断的问题描述>` |

## 附录 B：本文档与前两次回答的关系

| 项 | 第一次回答 | 第二次回答 | 本文档 |
|---|---|---|---|
| 方案 B 设计 | ✅ 完整 | 部分 | ✅ 完整 |
| 代码示例 | ✅ 但混演示数据 | ✅ 但零散 | ✅ 通用占位符 |
| 通用化原则 | ❌ | ✅ 部分 | ✅ 完整 |
| 数据契约 | ✅ | 部分 | ✅ 完整 |
| 交互设计 | ✅ | 部分 | ✅ 完整 |
| 待办清单 | ✅ | ❌ | ✅ 完整 |
| 错误处理 | ❌ | 部分 | ✅ 完整 |
| ESM 修正 | ❌ | ❌（还犯错） | ✅ |
| 同名文件处理 | ❌ | 提了未展开 | ✅ 完整 |

---

**规划结束**。

下一步建议：从 **B1**（数据结构层）开始，它是所有其他批次的基础，且纯单测可独立验证。