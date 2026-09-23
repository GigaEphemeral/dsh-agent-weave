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
import { createStateGraph, SKIP, type StateGraph } from './state-graph.js'
import { computeGraphSchemaHash, GraphValidationError, parseGraphDefinition } from './graph-definition.js'
import { evaluateCondition } from './condition-edge.js'
import { validateGraph } from './static-validator.js'
import type { GraphDefinitionSpec, TrajectoryEvent } from './types.js'
import type { RunLedger } from '../l5-observability/run-ledger.js'
import type { TokenCollector } from '../l5-observability/token-collector.js'

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
  create<T extends Record<string, unknown>>(maxIterations?: number, artifactsRoot?: string): StateGraph<T> {
    return createStateGraph<T>(
      this.ctx,
      maxIterations ?? this.config.defaultMaxIterations,
      this.config.maxConcurrentChildren,
      artifactsRoot,
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
  fromDefinition<T extends Record<string, unknown>>(
    spec: unknown,
    opts?: {
      /** P4.0.18：产物根目录（缺省 Config.artifactsRoot）。 */
      artifactsRoot?: string
      /** P4.0.18：事件接收器（共享总线桥接）。 */
      eventSink?: (e: TrajectoryEvent) => void
      /** P4.0.18：RunLedger。 */
      ledger?: RunLedger
      /** P4.0.18：TokenCollector。 */
      tokenCollector?: TokenCollector
    },
  ): StateGraph<T> {
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
      opts?.artifactsRoot,
      opts?.eventSink,
      opts?.ledger,
      opts?.tokenCollector,
    )

    for (const node of parsed.nodes) {
      if (node.nodeType === 'role') {
        // MVP-2 只做纯 handler 节点；子代理节点在 MVP-3
        // NEW-10：注册时传 role meta（供 node-start 事件 currentRole）
        graph.addNode(node.id, async () => ({}) as Partial<T>, { role: node.roleRef ?? node.nodeType })
      } else if (node.nodeType === 'condition') {
        // 条件节点：由 edges 的 when 表达式驱动（声明式），此处注册空 handler
        graph.addNode(node.id, async () => ({}) as Partial<T>, { role: node.nodeType })
      } else if (node.nodeType === 'approval') {
        // S8：从 YAML 加载的审批门默认 required:false（CLI/测试场景无 approval 服务时跳过；
        // 需要强制的场景由显式 addApprovalGate 调用方控制 required:true）
        graph.addApprovalGate(node.id, {
          toolName: `weave_approve_${node.id}`,
          reason: `节点 ${node.id} 需审批`,
          required: false,
        })
      }
    }

    // 边：seq 走 addEdge；loop 走 addLoopEdge（含 maxIter）；cond 合成条件函数（S7 修复）
    const condEdgesByFrom = new Map<string, Array<{ when: string; to: string; maxIter?: number }>>()
    for (const edge of parsed.edges) {
      if (edge.type === 'seq') {
        graph.addEdge(edge.from, edge.to)
      } else if (edge.type === 'loop' && edge.maxIter !== undefined) {
        graph.addLoopEdge(edge.from, edge.to, edge.maxIter)
      } else if (edge.type === 'cond' && edge.when !== undefined) {
        const list = condEdgesByFrom.get(edge.from) ?? []
        const entry: { when: string; to: string; maxIter?: number } = { when: edge.when, to: edge.to }
        if (edge.maxIter !== undefined) entry.maxIter = edge.maxIter
        list.push(entry)
        condEdgesByFrom.set(edge.from, list)
      }
    }

    // S7：同一 from 的所有 cond 边合成一个 ConditionHandler（按声明顺序求值）
    for (const [from, condEdges] of condEdgesByFrom) {
      const maxIter = Math.max(...condEdges.map((e) => e.maxIter ?? 1))
      const ctx = this.ctx
      graph.addConditionalEdge(
        from,
        async (state) => {
          for (const edge of condEdges) {
            try {
              // NEW-3：单个条件求值失败不阻塞整条链（记日志 + 继续下一条）
              if (evaluateCondition(edge.when, state as Record<string, unknown>)) {
                return edge.to
              }
            } catch (error) {
              ctx.logger.warn('graph', '条件求值失败，跳过', {
                from,
                to: edge.to,
                when: edge.when,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
          // NEW-4：所有条件都不满足 → SKIP，让引擎尝试静态边（不再直接 END）
          return SKIP
        },
        maxIter,
      )
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
