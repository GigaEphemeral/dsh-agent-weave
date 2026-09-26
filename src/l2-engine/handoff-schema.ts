/**
 * 结构化交接单 Schema 层（MVP-5B B1）。
 *
 * 纯 schema + 纯解析：无 IO、无状态、无运行时依赖（仅 zod/js-yaml）。
 *
 * 依赖方向严格单向（E8）：
 *   handoff-schema.ts ← handoff.ts ← project-memory.ts ← state-graph.ts
 *
 * 机制与内容分离（§1.1）：
 * - 本文件只定义【机制】：字段名/类型/枚举/解析语法。
 * - 不包含【内容】：键名约定、具体值、领域术语全部由角色层/LLM 运行时填充。
 */
import { load as yamlLoad } from 'js-yaml'
import { z } from 'zod'

// ─── 子类型 ────────────────────────────────────────────────

/** 产物引用（path/hash/sizeBytes 由引擎补全，其余由 LLM 填）。 */
export const ArtifactRefSchema = z.object({
  /** 相对 artifactsRoot 的路径。 */
  path: z.string().min(1),
  kind: z.enum(['doc', 'code', 'test', 'script', 'config', 'data']),
  /** 给下游的紧凑摘要（LLM 填）。 */
  summary: z.string().default(''),
  /** 下游必须遵守的约束（自由文本，LLM 填，可选）。 */
  contract: z.string().optional(),
  /** 引擎补全：sha256 前 16 位。 */
  hash: z.string().default(''),
  /** 引擎补全：字节数。 */
  sizeBytes: z.number().int().nonnegative().default(0),
})
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>

/** 已确认的项目事实（key 由 LLM 自定义，如 <domain>.<entity>.<attr>）。 */
export const ProjectFactSchema = z.object({
  key: z.string().min(1),
  category: z.enum(['environment', 'api', 'constraint', 'file-system', 'reference', 'other']),
  value: z.string(),
  confidence: z.enum(['confirmed', 'assumed', 'conflict']).default('confirmed'),
  summary: z.string().default(''),
  /** 引擎或 LLM 填（来源角色/节点）。 */
  source: z.string().default(''),
})
export type ProjectFact = z.infer<typeof ProjectFactSchema>

/** 环境事实（verified = 探测过的，cmd = 探测方式，便于审计）。 */
export const VerifiedFactSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  /** 探测命令（审计用）。 */
  cmd: z.string().default(''),
  at: z.number().default(() => Date.now()),
  source: z.string().default(''),
})
export type VerifiedFact = z.infer<typeof VerifiedFactSchema>

/** 未满足的环境前提（blocking 列出被阻塞的下游节点）。 */
export const UnmetRequirementSchema = z.object({
  key: z.string().min(1),
  required: z.string().default(''),
  /** LLM 建议的解决方式。 */
  suggestion: z.string().default(''),
  /** 被阻塞的下游节点 ID 列表。 */
  blocking: z.array(z.string()).default([]),
})
export type UnmetRequirement = z.infer<typeof UnmetRequirementSchema>

/** 未解决问题（suggestedOwner 指向角色 ID 或 'user'）。 */
export const OpenIssueSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['blocker', 'warning', 'info']).default('warning'),
  summary: z.string(),
  evidence: z.string().default(''),
  suggestedOwner: z.string().default('user'),
  /** 被阻塞的下游节点 ID 列表。 */
  blocking: z.array(z.string()).default([]),
})
export type OpenIssue = z.infer<typeof OpenIssueSchema>

// ─── 顶层 ──────────────────────────────────────────────────

/** 完整交接单信封（引擎写 handoff.json 的稳定结构）。 */
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
    /** 读了哪些上游节点（引擎累积）。 */
    upstream: z.array(z.string()).default([]),
    /** 建议下游读（LLM/角色层可填）。 */
    downstream: z.array(z.string()).default([]),
    completed: z.boolean().default(false),
  }).default({ upstream: [], downstream: [], completed: false }),
})
export type HandoffEnvelope = z.infer<typeof HandoffEnvelopeSchema>

// ─── LLM 侧 front-matter schema（子集） ─────────────────────

/**
 * LLM 只填【内容字段】；引擎补全【元数据字段】。
 * 严格校验：任一条不合法（缺 key/value、非法 category/confidence）→ 整段视为无效
 * （parseFrontMatter 返回 null，调用方回退空 shell，禁止部分解析产生幻觉）。
 */
const FrontMatterSchema = z.object({
  facts: z.array(z.object({
    key: z.string(),
    category: z.enum(['environment', 'api', 'constraint', 'file-system', 'reference', 'other']).default('other'),
    value: z.string(),
    confidence: z.enum(['confirmed', 'assumed']).default('confirmed'),
    summary: z.string().default(''),
  })).default([]),

  artifacts: z.array(z.object({
    path: z.string(),
    kind: z.enum(['doc', 'code', 'test', 'script', 'config', 'data']).default('doc'),
    summary: z.string().default(''),
    contract: z.string().optional(),
  })).default([]),

  environment: z.object({
    verified: z.array(z.object({
      key: z.string(),
      value: z.string(),
      cmd: z.string().default(''),
    })).default([]),
    unmet: z.array(z.object({
      key: z.string(),
      required: z.string().default(''),
      suggestion: z.string().default(''),
      blocking: z.array(z.string()).default([]),
    })).default([]),
  }).optional(),

  openIssues: z.array(z.object({
    id: z.string(),
    severity: z.enum(['blocker', 'warning', 'info']).default('warning'),
    summary: z.string(),
    evidence: z.string().default(''),
    suggestedOwner: z.string().default('user'),
    blocking: z.array(z.string()).default([]),
  })).default([]),
})

/** LLM 侧 front-matter 解析结果（内容字段，元数据由引擎补全）。 */
export type FrontMatter = z.infer<typeof FrontMatterSchema>

/**
 * 从 markdown 顶部 YAML front-matter 解析（纯语法解析，不做 IO）。
 *
 * 语法：文件头部 `---\n<yaml>\n---`。
 * 无 front-matter / YAML 非法 / 结构不合法 → 返回 null（调用方回退空 shell）。
 */
export function parseFrontMatter(content: string): FrontMatter | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  const raw = match?.[1]
  if (!raw) return null
  let data: unknown
  try {
    data = yamlLoad(raw)
  } catch {
    return null
  }
  const result = FrontMatterSchema.safeParse(data)
  return result.success ? result.data : null
}

/** 校验完整 envelope（供 readHandoffJson 用）；非法返回 null。 */
export function validateEnvelope(input: unknown): HandoffEnvelope | null {
  const result = HandoffEnvelopeSchema.safeParse(input)
  return result.success ? result.data : null
}
