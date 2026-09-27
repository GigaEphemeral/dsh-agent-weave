/**
 * 共享类型定义（MVP-1 P1.1.3）。
 *
 * 设计依据：
 * - RoleDefinition：角色 YAML 的校验后数据模型（Zod 单一真相源）
 * - RoleProfile：角色编译产物，供 workflowEngine 组装 SubagentStartRequest 使用
 * - SubagentProvider：直接使用官方 `@deepseek-ai/dsh-subagent` 类型，不自定义同名类型
 *   （避免与运行时身份分裂；官方契约见 D-001 决策记录）
 */
import { z } from 'zod'

/** 观察者配置（MVP-1 占位，MVP-2 起使用）。 */
export interface ObserverConfig {
  id: string
  role_ref: string
  observe_nodes: string[]
  observation_mode: 'file-watch' | 'event-stream' | 'hybrid'
  intervention_mode: 'flag-only' | 'sanitize' | 'block'
  criteria: string[]
  token_budget: number
}

export const ObserverConfigSchema = z.object({
  id: z.string().min(1),
  role_ref: z.string().min(1),
  observe_nodes: z.array(z.string()),
  observation_mode: z.enum(['file-watch', 'event-stream', 'hybrid']),
  intervention_mode: z.enum(['flag-only', 'sanitize', 'block']),
  criteria: z.array(z.string()),
  token_budget: z.number().int().positive(),
})

/** 角色委派能力（问题二：禁止子代理自动 spawn 下级）。 */
export interface RoleCapability {
  /** 是否允许 spawn 子代理（默认 false）。 */
  allow_delegation: boolean
  /** 允许的最大委派深度（角色自身深度 1 存在；2 = 允许 spawn 一级下级）。 */
  max_depth: number
  /** 允许 spawn 的角色白名单（空 = 不限制）。 */
  allowed_children: string[]
  /** 是否允许执行 shell。 */
  allow_shell: boolean
  /** 是否允许写文件。 */
  allow_write: boolean
}

export const RoleCapabilitySchema = z.object({
  allow_delegation: z.boolean().default(false),
  max_depth: z.number().int().min(0).max(5).default(1),
  allowed_children: z.array(z.string()).default([]),
  allow_shell: z.boolean().default(true),
  allow_write: z.boolean().default(true),
})

/** ★ v2.0：结构化质量门（向后兼容字符串）。 */
export const QualityGateSchema = z.union([
  z.string(), // 旧 YAML 兼容
  z.object({ type: z.literal('non_empty') }),
  z.object({ type: z.literal('min_file_size'), bytes: z.number().int().positive() }),
  z.object({ type: z.literal('min_artifact_count'), n: z.number().int().positive() }),
  z.object({ type: z.literal('contains_section'), section: z.string(), minLength: z.number().int().optional() }),
  z.object({ type: z.literal('no_code_fence'), languages: z.array(z.string()).optional() }),
  z.object({ type: z.literal('forbidden_phrases'), phrases: z.array(z.string()) }),
  z.object({ type: z.literal('require_probe_section') }),
])
export type QualityGate = z.infer<typeof QualityGateSchema>

/** ★ v2.0：角色职责边界（Prompt 层约束，不做工具层控制）。 */
export const RoleBoundarySchema = z.object({
  responsibilities: z.array(z.string()).default([]),
  forbidden: z.array(z.string()).default([]),
  artifact: z.object({
    name: z.string().min(1),
    type: z.enum(['markdown', 'code', 'json', 'text']),
    required_sections: z.array(z.string()).default([]),
  }).optional(),
}).optional()
export type RoleBoundary = z.infer<typeof RoleBoundarySchema>

/** ★ v2.0：探测记录（handoff 块内）。 */
export interface Probe {
  what: string
  how: string
  result: string
  reusable?: boolean // 默认 true
}

/** ★ v2.0：关键决策 + 遗留问题（handoff 块内）。 */
export interface HandoffComment {
  probes: Probe[]
  decisions?: Array<{ topic: string; choice: string; rationale?: string }>
  openIssues?: string[]
}

/** ★ v2.0：共享发现池条目（publish_finding 写入）。 */
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

/** 角色定义（从 YAML 加载后经 Zod 校验）。 */
export interface RoleDefinition {
  schema_version: string
  id: string
  name: string
  /** 指向 skills 目录下 Markdown 文件的路径（相对 skillsDir 或绝对路径）。 */
  system_prompt_ref: string
  traits: string[]
  capabilities: string[]
  /** ★ v2.0：可选（缺省=不做工具层控制，靠 SKILL.md 提醒）。 */
  tools?: string[]
  model: {
    provider: string
    model: string
  }
  memory_scope: 'private' | 'shared'
  lifecycle: 'resident' | 'on-demand' | 'hybrid'
  max_concurrent_children: number
  /** 问题二：委派能力（depthLimit 数据来源，替换 max_concurrent_children 误用）。 */
  capability: RoleCapability
  /** ★ v2.0：结构化质量门（旧字符串自动映射）。 */
  quality_gate: QualityGate[]
  /** ★ v2.0：可选（缺省=不限制，靠 SKILL.md 提醒）。 */
  token_budget?: number
  /** ★ v2.0：职责边界（Prompt 层）。 */
  role_boundary?: RoleBoundary
  handoff: {
    upstream: string[]
    downstream: string[]
    edge_type: 'seq' | 'cond'
  }
  /** 可选观察者配置；zod 推断为 `ObserverConfig[] | undefined`（兼容 exactOptionalPropertyTypes）。 */
  observers?: ObserverConfig[] | undefined
}

export const RoleDefinitionSchema = z.object({
  schema_version: z.literal('1.0'),
  id: z.string().min(1),
  name: z.string().min(1),
  system_prompt_ref: z.string().min(1),
  traits: z.array(z.string()),
  capabilities: z.array(z.string()),
  tools: z.array(z.string()).optional(),
  model: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }),
  memory_scope: z.enum(['private', 'shared']),
  lifecycle: z.enum(['resident', 'on-demand', 'hybrid']),
  max_concurrent_children: z.number().int().positive(),
  capability: RoleCapabilitySchema.default({
    allow_delegation: false,
    max_depth: 1,
    allowed_children: [],
    allow_shell: true,
    allow_write: true,
  }),
  quality_gate: z.array(QualityGateSchema),
  token_budget: z.number().int().positive().optional(),
  role_boundary: RoleBoundarySchema,
  handoff: z.object({
    upstream: z.array(z.string()),
    downstream: z.array(z.string()),
    edge_type: z.enum(['seq', 'cond']),
  }),
  observers: z.array(ObserverConfigSchema).optional(),
})

/** RoleDefinition 的 Zod 推断类型（与 interface 保持一致的双重校验出口）。 */
export type RoleDefinitionInferred = z.infer<typeof RoleDefinitionSchema>

/**
 * 角色编译产物：一个角色的「可执行画像」。
 *
 * 这是 D-001 决策的落地：官方 SubagentProvider 是传输层（spawn/fork/acp），
 * 角色不是 provider，而是每次启动时组装 SubagentStartRequest 的数据源。
 *
 * 字段映射（文档 §3.2）：
 * - name ← role.id
 * - persona ← system_prompt_ref 指向的 skill 文件内容
 * - toolFilter ← role.tools（转 ToolRestriction.allow）
 * - agentOptions ← { provider: role.model.provider, model: role.model.model }
 * - depthLimit ← role.max_concurrent_children
 * - inheritsParentContext ← (role.memory_scope === 'shared')
 */
export interface RoleProfile {
  /** 角色唯一标识（= YAML id）。 */
  name: string
  /** 角色系统提示（skill 文件内容）。 */
  persona: string
  /** 工具最小权限声明（allow 列表）。★ v2.0：空 = 不做工具层控制。 */
  toolFilter: readonly string[]
  /** 完整 { provider, model } 路由（🐛 #4311/#4313 规避：不可省略）。 */
  agentOptions: {
    provider: string
    model: string
  }
  /** 子代理最大并发数（保留，仅元数据）。 */
  depthLimit?: number
  /** 问题二：委派能力（maxDepth 数据来源）。 */
  capability: RoleCapability
  /** G4 记忆纯洁性开关：private → false。 */
  inheritsParentContext: boolean
  /** 角色元数据（供日志/看板使用，不参与请求组装）。 */
  metadata: {
    name: string
    traits: string[]
    capabilities: string[]
    quality_gate: QualityGate[]
    /** ★ v2.0：仅记录，不参与请求组装；缺省表示无限制。 */
    token_budget?: number
    lifecycle: 'resident' | 'on-demand' | 'hybrid'
    handoff: RoleDefinition['handoff']
    /** ★ v2.0：职责边界。 */
    role_boundary?: RoleBoundary
  }
}

/** 角色加载错误（YAML 不存在/读取失败/路径逃逸）。 */
export class RoleLoadError extends Error {
  override readonly name = 'RoleLoadError'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** 角色 Schema 校验错误（YAML 结构非法）。 */
export class RoleSchemaError extends Error {
  override readonly name = 'RoleSchemaError'
  /** Zod 错误明细（字段路径 + 期望类型 + 实际值）。 */
  readonly issues: ReadonlyArray<{ path: string; message: string }>
  constructor(message: string, issues: ReadonlyArray<{ path: string; message: string }>) {
    super(message)
    this.issues = issues
  }
}
