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

/** 角色定义（从 YAML 加载后经 Zod 校验）。 */
export interface RoleDefinition {
  schema_version: string
  id: string
  name: string
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
  quality_gate: string[]
  token_budget: number
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
  tools: z.array(z.string()),
  model: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }),
  memory_scope: z.enum(['private', 'shared']),
  lifecycle: z.enum(['resident', 'on-demand', 'hybrid']),
  max_concurrent_children: z.number().int().positive(),
  quality_gate: z.array(z.string()),
  token_budget: z.number().int().positive(),
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
  /** 工具最小权限声明（allow 列表）。 */
  toolFilter: readonly string[]
  /** 完整 { provider, model } 路由（🐛 #4311/#4313 规避：不可省略）。 */
  agentOptions: {
    provider: string
    model: string
  }
  /** 子代理最大并发数。 */
  depthLimit?: number
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
