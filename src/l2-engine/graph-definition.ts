/**
 * 图 DSL Schema 与解析（MVP-2 T2）。
 *
 * 职责：
 * - 定义图 DSL 的 Zod Schema（节点/边/checkpoint/元数据/观察者 + 图整体）
 * - parseGraphDefinition：未知输入 → 校验 → GraphDefinitionSpec
 * - computeGraphSchemaHash：DSL schema 内容哈希（RES.8 §三.1 CVC 内容寻址思想）
 *
 * 6 条 refine：
 *   ① entryPoint 指向已定义节点
 *   ② 所有边的 from/to 指向已定义节点
 *   ③ 节点 ID 唯一
 *   ④ cond 边必须有 when
 *   ⑤ loop 边必须有 maxIter
 *   ⑥ 自环边只允许 loop 类型
 */
import { createHash } from 'node:crypto'
import { load as yamlLoad } from 'js-yaml'
import { z } from 'zod'
import type { GraphDefinitionSpec } from './types.js'

/** 节点 ID 正则（RES.10 §二.5：dsh-agent-graph 用 ^[a-z][a-z0-9_-]*$）。 */
export const NODE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/

export const GraphNodeSpecSchema = z.object({
  id: z.string().regex(NODE_ID_PATTERN, '节点 ID 必须匹配 ^[a-z][a-z0-9_-]*$'),
  roleRef: z.string().optional(),
  promptTemplate: z.string().optional(),
  nodeType: z.enum(['role', 'condition', 'approval']),
  artifactName: z.string().optional(), // P4.0.6
})

export const GraphEdgeSpecSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    type: z.enum(['seq', 'cond', 'loop', 'parallel']),
    when: z.string().optional(),
    maxIter: z.number().int().positive().optional(),
    edgeRole: z.enum(['normal', 'escalate']).optional(), // P4.0.7
  })
  .refine((edge) => edge.type !== 'cond' || edge.when !== undefined, {
    message: 'cond 边必须有 when 字段',
  })
  .refine((edge) => edge.type !== 'loop' || edge.maxIter !== undefined, {
    message: 'loop 边必须有 maxIter 字段',
  })
  .refine((edge) => edge.from !== edge.to || edge.type === 'loop', {
    message: '自环边只允许 loop 类型（RES.10 §二.5）',
  })

export const CheckpointSpecSchema = z.object({
  strategy: z.literal('node-level'),
  storage: z.enum(['session-log', 'sqlite', 'fs']),
})

export const GraphMetadataSchema = z.object({
  source: z.enum(['canvas', 'yaml', 'hybrid']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const ObserverConfigSchema = z.object({
  id: z.string().min(1),
  roleRef: z.string().min(1),
  observeNodes: z.array(z.string()),
  observationMode: z.enum(['file-watch', 'event-stream', 'hybrid']),
  interventionMode: z.enum(['flag-only', 'sanitize', 'block']),
  criteria: z.array(z.string()),
  tokenBudget: z.number().int().positive(),
})

export const GraphDefinitionSpecSchema = z
  .object({
    version: z.string().min(1),
    graphVersion: z.string().min(1),
    graphSchemaHash: z.string().min(1),
    entryPoint: z.string().min(1),
    // M8 修复：maxIterations 有上限（防误配爆炸）
    maxIterations: z.number().int().min(1).max(1000).optional(),
    nodes: z.array(GraphNodeSpecSchema).min(1),
    edges: z.array(GraphEdgeSpecSchema),
    checkpoint: CheckpointSpecSchema,
    metadata: GraphMetadataSchema,
    observers: z.array(ObserverConfigSchema).optional(),
  })
  .refine((spec) => spec.nodes.some((n) => n.id === spec.entryPoint), {
    message: 'entryPoint 必须指向已定义的节点',
  })
  .refine(
    (spec) => {
      const ids = new Set(spec.nodes.map((n) => n.id))
      return spec.edges.every((e) => ids.has(e.from) && ids.has(e.to))
    },
    { message: '所有边的 from/to 必须指向已定义的节点' },
  )
  .refine(
    (spec) => {
      const ids = spec.nodes.map((n) => n.id)
      return new Set(ids).size === ids.length
    },
    { message: '节点 ID 必须唯一' },
  )

/** 图定义校验错误：携带 Zod issues 明细（字段路径 + 消息）。 */
export class GraphValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(message)
    this.name = 'GraphValidationError'
  }
}

/** 解析并校验图定义（未知输入 → 已校验的 GraphDefinitionSpec）。 */
export function parseGraphDefinition(input: unknown): GraphDefinitionSpec {
  const result = GraphDefinitionSpecSchema.safeParse(input)
  if (!result.success) {
    throw new GraphValidationError(
      '图定义校验失败',
      result.error.issues.map((i) => ({
        path: i.path.join('.') || '$',
        message: i.message,
      })),
    )
  }
  // zod 推断输出与 exactOptionalPropertyTypes 的可选字段表示存在差异，
  // 经 schema 校验后数据已满足 GraphDefinitionSpec 契约，做收窄断言。
  return result.data as GraphDefinitionSpec
}

/** 从 YAML 文本解析图定义（语法错误 → GraphValidationError）。 */
export function parseGraphDefinitionYaml(raw: string, source: string): GraphDefinitionSpec {
  let data: unknown
  try {
    data = yamlLoad(raw)
  } catch (error) {
    throw new GraphValidationError(
      `图定义 YAML 语法错误: ${source}: ${error instanceof Error ? error.message : String(error)}`,
      [{ path: '$', message: 'YAML 解析失败' }],
    )
  }
  return parseGraphDefinition(data)
}

/**
 * 计算 DSL schema 内容哈希（RES.8 §三.1，CVC 内容寻址思想）。
 *
 * 规范化 JSON（仅参与语义的字段，排除 graphSchemaHash 自身与 metadata 时间戳）后
 * 取 SHA-256 前 12 位十六进制。graphVersion 变更/节点边增删都会改变哈希。
 */
export function computeGraphSchemaHash(spec: Omit<GraphDefinitionSpec, 'graphSchemaHash'>): string {
  const canonical = JSON.stringify({
    version: spec.version,
    entryPoint: spec.entryPoint,
    maxIterations: spec.maxIterations,
    nodes: spec.nodes,
    edges: spec.edges,
    checkpoint: spec.checkpoint,
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12)
}
