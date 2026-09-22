/**
 * ctx.graph 服务（MVP-2 T10，RES.10 §一.7 服务形态）。
 *
 * GraphEngineService extends Service：
 * - create<T>()：创建隔离 StateGraph 实例（默认配置）
 * - fromDefinition<T>(spec)：从图 DSL 创建（校验 + 静态验证 + 构建）
 * - Config 用 zod 校验：defaultMaxIterations / logTrajectory / maxConcurrentChildren
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { createStateGraph, type StateGraph } from './state-graph.js'
import { computeGraphSchemaHash, GraphValidationError, parseGraphDefinition } from './graph-definition.js'
import { validateGraph } from './static-validator.js'
import type { GraphDefinitionSpec } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    graph: GraphEngineService
  }
}

export class GraphEngineService extends Service {
  static Config = z.object({
    defaultMaxIterations: z.number().int().min(1).default(25),
    logTrajectory: z.boolean().default(true),
    maxConcurrentChildren: z.number().int().min(1).default(8),
  })

  private readonly config: z.infer<typeof GraphEngineService.Config>

  constructor(ctx: Context, config: z.infer<typeof GraphEngineService.Config>) {
    super(ctx, 'graph')
    this.config = config
  }

  /** 创建隔离的 StateGraph 实例（默认配置或显式 maxIterations）。 */
  create<T extends Record<string, unknown>>(maxIterations?: number): StateGraph<T> {
    return createStateGraph<T>(
      this.ctx,
      maxIterations ?? this.config.defaultMaxIterations,
      this.config.maxConcurrentChildren,
    )
  }

  /**
   * 从图 DSL 定义创建图（校验 + 静态验证 + 构建节点/边）。
   *
   * MVP-2：role 节点为纯 handler 占位（子代理节点 MVP-3 接入）。
   * 条件边（cond/loop）从 GraphEdgeSpec 转换为函数式条件边——MVP-2 用
   * resolveNextNode 的声明式 edges 语义，故 seq 边走 addEdge，loop/cond 由
   * 声明式 edges 承载（state-graph 内部支持 InternalEdge type）。
   *
   * @throws GraphValidationError 校验失败
   */
  fromDefinition<T extends Record<string, unknown>>(spec: unknown): StateGraph<T> {
    const parsed = parseGraphDefinition(spec)
    const validation = validateGraph(parsed, {
      registeredRoles: new Set(this.registeredRoles()),
    })
    if (!validation.valid) {
      throw new GraphValidationError('图校验失败', validation.errors)
    }

    const graph = createStateGraph<T>(
      this.ctx,
      parsed.maxIterations ?? this.config.defaultMaxIterations,
      this.config.maxConcurrentChildren,
    )

    for (const node of parsed.nodes) {
      if (node.nodeType === 'role') {
        // MVP-2 只做纯 handler 节点；子代理节点在 MVP-3
        graph.addNode(node.id, async () => ({}) as Partial<T>)
      } else if (node.nodeType === 'condition') {
        // 条件节点：由 edges 的 when 表达式驱动（声明式），此处注册空 handler
        graph.addNode(node.id, async () => ({}) as Partial<T>)
      } else if (node.nodeType === 'approval') {
        graph.addApprovalGate(node.id, { toolName: `weave_approve_${node.id}`, reason: `节点 ${node.id} 需审批` })
      }
    }

    // 边：seq 走 addEdge；loop 走 addLoopEdge（含 maxIter）
    for (const edge of parsed.edges) {
      if (edge.type === 'seq') {
        graph.addEdge(edge.from, edge.to)
      } else if (edge.type === 'loop' && edge.maxIter !== undefined) {
        graph.addLoopEdge(edge.from, edge.to, edge.maxIter)
      }
      // cond 边：MVP-2 由 CLI/引擎层通过 evaluateCondition + resolveNextNode 处理，
      // 声明式 edges 已在 fromDefinition 内按 type 传入——这里 seq/loop 已覆盖。
      // cond 边依赖 when 表达式，需引擎侧声明式支持（见 state-graph InternalEdge）。
      // 当前 MVP-2 引擎用条件函数路由，cond 表达式转函数由更高层（workflow 运行器）完成。
    }

    return graph
  }

  /** 计算图定义的 schema hash（供 checkpoint graphVersion 双字段使用）。 */
  schemaHash(spec: GraphDefinitionSpec): string {
    return computeGraphSchemaHash(spec)
  }

  /** 已注册角色名（来自 ctx.subagents，RES.3 实测 list() 存在）。 */
  private registeredRoles(): string[] {
    try {
      return this.ctx.subagents.list()
    } catch {
      return []
    }
  }
}

// 标记类插件可被 ctx.plugin(GraphEngineService, config) 直接挂载
export default GraphEngineService
