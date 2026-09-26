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

/** 环境前提检查（MVP-5 问题 2：Environment Gate）。 */
export interface RoleEnvironment {
  preflight: Array<{
    cmd: string
    expect_contains?: string | undefined
    expect_exit_zero?: boolean | undefined
  }>
}

export const RoleEnvironmentSchema = z.object({
  preflight: z.array(z.object({
    cmd: z.string().min(1),
    expect_contains: z.string().optional(),
    expect_exit_zero: z.boolean().optional(),
  })).default([]),
})

/** 角色输出约束（MVP-5 问题 1/3：Output Gate，只校验节点自身产物）。 */
export interface RoleOutputGate {
  only_markdown?: boolean | undefined
  forbidden_extensions?: string[] | undefined
  forbidden_content_patterns?: string[] | undefined
}

export const RoleOutputGateSchema = z.object({
  only_markdown: z.boolean().optional(),
  forbidden_extensions: z.array(z.string()).optional(),
  forbidden_content_patterns: z.array(z.string()).optional(),
})

/** 产出项（ui修复2：output.produces；供节点级覆盖与产物校验）。 */
export interface RoleProduceItem {
  kind: 'doc' | 'code' | 'test' | 'script' | 'config' | 'data'
  name: string
  contract?: string | undefined
}

export const RoleProduceItemSchema = z.object({
  kind: z.enum(['doc', 'code', 'test', 'script', 'config', 'data']),
  name: z.string().min(1),
  contract: z.string().optional(),
})

/** 消费项（ui修复2：input.consumes；声明消费的上游产物）。 */
export interface RoleConsumeItem {
  kind: string
  name: string
  from?: string | undefined
}

export const RoleConsumeItemSchema = z.object({
  kind: z.string(),
  name: z.string().min(1),
  from: z.string().optional(),
})

/** 角色输入声明（ui修复2：requires 上游依赖 + consumes 消费产物）。 */
export interface RoleInputDecl {
  requires: string[]
  consumes: RoleConsumeItem[]
}

export const RoleInputDeclSchema = z.object({
  requires: z.array(z.string()).default([]),
  consumes: z.array(RoleConsumeItemSchema).default([]),
}).optional()

/** 角色输出声明（ui修复2：produces 产出清单 + 约束）。 */
export interface RoleOutputDecl extends RoleOutputGate {
  produces: RoleProduceItem[]
  requiredSections?: string[] | undefined
}

export const RoleOutputDeclSchema = z.object({
  produces: z.array(RoleProduceItemSchema).default([]),
  only_markdown: z.boolean().optional(),
  forbidden_extensions: z.array(z.string()).optional(),
  forbidden_content_patterns: z.array(z.string()).optional(),
  requiredSections: z.array(z.string()).optional(),
}).optional()

/** 角色定义（从 YAML 加载后经 Zod 校验）。 */
export interface RoleDefinition {
  schema_version: string
  id: string
  name: string
  /** MVP-5 Phase A：角色库展示描述（hover 提示）。 */
  description?: string | undefined
  /** MVP-5 Phase A：角色库排序权重（小在前）。 */
  order?: number | undefined
  /** MVP-5 Phase A：角色标签（搜索/分组）。 */
  tags?: string[] | undefined
  /** MVP-5 Phase A：引导式画布推荐下一步。 */
  suggests_next?: Array<{
    roleRef: string
    label?: string | undefined
    reason?: string | undefined
  }> | undefined
  /** 指向 skills 目录下 Markdown 文件的路径（相对 skillsDir 或绝对路径）。 */
  system_prompt_ref: string
  traits: string[]
  capabilities: string[]
  /** 角色允许使用的全局工具名（最小权限声明，映射为 toolFilter）。 */
  tools: string[]
  model: {
    provider: string
    model: string
  }
  memory_scope: 'private' | 'shared'
  lifecycle: 'resident' | 'on-demand' | 'hybrid'
  max_concurrent_children: number
  /** 问题二：委派能力（depthLimit 数据来源，替换 max_concurrent_children 误用）。 */
  capability: RoleCapability
  quality_gate: string[]
  token_budget: number
  handoff: {
    upstream: string[]
    downstream: string[]
    edge_type: 'seq' | 'cond'
  }
  /** 可选观察者配置；zod 推断为 `ObserverConfig[] | undefined`（兼容 exactOptionalPropertyTypes）。 */
  observers?: ObserverConfig[] | undefined
  /** MVP-5 问题 2：环境前提检查（可选）。 */
  environment?: RoleEnvironment | undefined
  /** MVP-5 问题 1/3：输出约束（可选）。 */
  output?: RoleOutputGate | undefined
  /** ui修复2：输入声明（requires/consumes）。 */
  input?: RoleInputDecl | undefined
  /** ui修复2：产出清单（produces，可含 contract）。 */
  produces?: RoleProduceItem[] | undefined
}

export const RoleDefinitionSchema = z.object({
  schema_version: z.literal('1.0'),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  order: z.number().optional(),
  tags: z.array(z.string()).optional(),
  suggests_next: z.array(z.object({
    roleRef: z.string().min(1),
    label: z.string().optional(),
    reason: z.string().optional(),
  })).optional(),
  system_prompt_ref: z.string().min(1),
  traits: z.array(z.string()),
  capabilities: z.array(z.string()),
  tools: z.array(z.string()),
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
  quality_gate: z.array(z.string()),
  token_budget: z.number().int().positive(),
  handoff: z.object({
    upstream: z.array(z.string()),
    downstream: z.array(z.string()),
    edge_type: z.enum(['seq', 'cond']),
  }),
  observers: z.array(ObserverConfigSchema).optional(),
  environment: RoleEnvironmentSchema.optional(),
  output: RoleOutputGateSchema.optional(),
  input: RoleInputDeclSchema,
  produces: z.array(RoleProduceItemSchema).optional(),
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
  /** 工具最小权限声明（allow 列表）。 */
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
    quality_gate: string[]
    token_budget: number
    lifecycle: 'resident' | 'on-demand' | 'hybrid'
    handoff: RoleDefinition['handoff']
    /** MVP-5 问题 2：环境前提检查。 */
    environment?: RoleDefinition['environment']
    /** MVP-5 问题 1/3：输出约束。 */
    output?: RoleDefinition['output']
    /** MVP-5 Phase A：角色库元数据。 */
    description?: string | undefined
    order?: number | undefined
    tags?: string[] | undefined
    suggests_next?: RoleDefinition['suggests_next']
    /** ui修复2：产出清单（produces）。 */
    produces?: RoleDefinition['produces']
    /** ui修复2：输入声明（consumes/requires）。 */
    input?: RoleDefinition['input']
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
