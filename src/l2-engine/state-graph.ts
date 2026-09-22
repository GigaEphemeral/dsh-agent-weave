/**
 * StateGraph 引擎骨架（MVP-2 T9，核心）。
 *
 * 基于 RES.10 §一.1-6 + RES.5 §四：
 * - addNode / addEdge / addConditionalEdge / addApprovalGate / run
 * - 迭代熔断（进入节点前检查，RES.10 §一.3：第 N 次执行完，第 N+1 次终止）
 * - 全局并发闸（acquire → try → finally release，RES.5 §四）
 * - 审批门 ctx.approval.request 等 allowed-once（RES.10 §一.5）
 * - checkpoint 在"补丁合并后、跳转前"（RES.10 §一.4）
 * - 轨迹事件 8 种（graph/* 契约）
 * - 合并冲突 reject-on-conflict 返回 success: false
 *
 * 注意：addConditionalEdge 接受 ConditionHandler 函数（条件边是函数式路由），
 * 与声明式 edges（seq/loop）并存；条件函数返回下一节点名或 '__END__'。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  ConditionHandler,
  GraphExecutionResult,
  GraphNodeContext,
  NodeHandler,
  RunOptions,
  TrajectoryEvent,
} from './types.js'
import { mergeState } from './atomic-merge.js'
import { createConcurrencyCounter } from './concurrency-counter.js'

export const END = '__END__'

/** 审批服务最小接口（dsh-user-approval 的 ApprovalService.request 形态，运行时存在性检查）。 */
interface ApprovalServiceLike {
  request(req: {
    agent: unknown
    toolName: string
    reason?: string
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | string>
}

export interface StateGraph<T> {
  addNode(name: string, handler: NodeHandler<T>): this
  addEdge(from: string, to: string): this
  /** 声明式循环边：`from → to` 最多回退 maxIter 次，用尽后走审批/终止。 */
  addLoopEdge(from: string, to: string, maxIter: number): this
  addConditionalEdge(from: string, condition: ConditionHandler<T>, maxIter?: number): this
  addApprovalGate(name: string, options: { toolName: string; reason?: string }): this
  run(initialState: T, options: RunOptions<T>): Promise<GraphExecutionResult<T>>
}

/** 声明式边（seq / loop）。 */
interface InternalEdge {
  from: string
  to: string
  type: 'seq' | 'loop'
  maxIter?: number
}

/** 条件边（函数式路由）。 */
interface InternalConditionalEdge {
  from: string
  condition: ConditionHandler<Record<string, unknown>>
  maxIter?: number
  /** 已触发次数（边级熔断）。 */
  used: number
}

export interface SubagentNodeOptions {
  provider: string
  promptTemplate?: string
  outputSchema?: unknown
}

export function createStateGraph<T extends Record<string, unknown>>(
  ctx: Context,
  maxIterations = 25,
  maxConcurrentChildren = 8,
): StateGraph<T> {
  const nodes = new Map<string, NodeHandler<T>>()
  const edges: InternalEdge[] = []
  const conditionalEdges: InternalConditionalEdge[] = []
  const approvalGates = new Map<string, { toolName: string; reason?: string }>()
  let entryPoint: string | null = null

  const concurrency = createConcurrencyCounter(ctx, maxConcurrentChildren)

  return {
    addNode(name, handler) {
      if (name === END) throw new Error('__END__ 是保留哨兵')
      if (nodes.has(name)) throw new Error(`节点已存在: ${name}`)
      nodes.set(name, handler)
      if (!entryPoint) entryPoint = name
      return this
    },

    addEdge(from, to) {
      edges.push({ from, to, type: 'seq' })
      return this
    },

    addLoopEdge(from, to, maxIter) {
      edges.push({ from, to, type: 'loop', maxIter })
      return this
    },

    addConditionalEdge(from, condition, maxIter) {
      // 条件函数在引擎侧以宽松状态类型调用（内部由用户函数按需收窄）
      conditionalEdges.push({
        from,
        condition: condition as ConditionHandler<Record<string, unknown>>,
        ...(maxIter !== undefined ? { maxIter } : {}),
        used: 0,
      })
      return this
    },

    addApprovalGate(name, options) {
      approvalGates.set(name, options)
      if (!nodes.has(name)) {
        // 审批门可无 handler：纯门，空增量
        nodes.set(name, async () => ({}) as Partial<T>)
      }
      return this
    },

    async run(initialState, options) {
      if (!entryPoint) throw new Error('图无入口节点')

      const graphId = `graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const trajectory: TrajectoryEvent[] = []
      let state = initialState
      let current: string = entryPoint
      let iteration = options.initialIteration ?? 0

      const emit = (event: TrajectoryEvent) => {
        trajectory.push(event)
        // graph/* 事件非 Cordis 内置 Events 类型，用宽松签名发射
        ;(ctx.emit as (name: string, payload: unknown) => void)(event.type, event)
      }

      emit({ type: 'graph/start', graphId, timestamp: Date.now() })

      // 循环回退计数（loop 边 used 由条件边/引擎维护）
      const loopUsed = new Map<string, number>()

      while (current !== END) {
        // RES.10 §一.3：计数在"进入节点前"
        if (++iteration > maxIterations) {
          const err = new Error(`迭代次数超过上限（${maxIterations}），疑似死循环，已终止。`)
          emit({ type: 'graph/error', graphId, timestamp: Date.now(), data: { error: err.message } })
          return { graphId, success: false, finalState: state, trajectory, iterations: iteration, error: err }
        }

        // RES.5 §四：全局并发闸
        const acquired = await concurrency.acquire()
        if (!acquired) {
          const err = new Error(`并发闸拒绝激活节点: ${current}`)
          emit({ type: 'graph/node-error', graphId, node: current, timestamp: Date.now(), data: { error: err.message } })
          return { graphId, success: false, finalState: state, trajectory, iterations: iteration, error: err }
        }

        try {
          const handler = nodes.get(current)
          if (!handler) throw new Error(`节点不存在: ${current}`)

          // RES.10 §一.5：审批门执行前先请求审批（approval 服务为可选依赖，运行时探测）
          const gate = approvalGates.get(current)
          const approvalService = (ctx.get('approval') as ApprovalServiceLike | undefined)
          if (gate && options.agent && approvalService) {
            const req: { agent: unknown; toolName: string; reason?: string; signal?: AbortSignal } = {
              agent: options.agent,
              toolName: gate.toolName,
            }
            if (gate.reason !== undefined) req.reason = gate.reason
            if (options.signal !== undefined) req.signal = options.signal
            const outcome = await approvalService.request(req)
            if (outcome !== 'allowed-once') {
              throw new Error(`审批门 "${current}" 未通过（${outcome}）`)
            }
          }

          const nodeCtx: GraphNodeContext<T> = {
            ctx,
            graphId,
            graphVersion: '0.1.0',
            emit,
            logger: ctx.logger,
            checkpoint: options.checkpoint,
            iteration,
            ...(options.agent !== undefined ? { agent: options.agent } : {}),
          }

          emit({ type: 'graph/node-start', graphId, node: current, timestamp: Date.now() })

          const startTime = Date.now()
          const patch = await handler(state, nodeCtx, options.signal)

          // RES.10 §一.2：原子合并 + 冲突检测
          const mergeResult = mergeState(state, patch)
          if (!mergeResult.success) {
            emit({
              type: 'graph/node-error',
              graphId,
              node: current,
              timestamp: Date.now(),
              data: { conflicts: mergeResult.conflicts },
            })
            return {
              graphId,
              success: false,
              finalState: state,
              trajectory,
              iterations: iteration,
              error: new Error(`状态合并冲突: ${JSON.stringify(mergeResult.conflicts)}`),
            }
          }
          state = mergeResult.state as T

          emit({
            type: 'graph/node-end',
            graphId,
            node: current,
            timestamp: Date.now(),
            durationMs: Date.now() - startTime,
          })

          // RES.10 §一.4：checkpoint 在"补丁合并后、跳转前"
          await options.checkpoint({
            graphId,
            graphVersion: '0.1.0',
            graphSchemaHash: '',
            node: current,
            state,
            iteration,
            timestamp: Date.now(),
          })
          emit({ type: 'graph/checkpoint-written', graphId, node: current, timestamp: Date.now() })

          // 解析下一节点：条件边优先（函数式），否则声明式 seq/loop
          const conditional = conditionalEdges.filter((e) => e.from === current)
          let next: string | undefined
          for (const ce of conditional) {
            if (ce.maxIter !== undefined && ce.used >= ce.maxIter) {
              // 边级熔断：跳过该条件边（回退到静态边或终止）
              continue
            }
            const result = await ce.condition(state as unknown as Record<string, unknown>, nodeCtx as never, options.signal)
            const resolved = Array.isArray(result) ? result[0] : result
            if (resolved !== undefined && resolved !== END) {
              ce.used++
              // 条件边命中即一次循环路由决策（回退或推进均属迭代控制）
              emit({
                type: 'graph/loop-iteration',
                graphId,
                node: current,
                timestamp: Date.now(),
                data: { iteration: ce.used, maxIter: ce.maxIter },
              })
              next = resolved
              break
            }
          }

          if (next === undefined) {
            // 声明式边：优先 loop（回退），否则 seq
            const outgoing = edges.filter((e) => e.from === current)
            const loop = outgoing.find((e) => e.type === 'loop')
            if (loop !== undefined) {
              const used = loopUsed.get(`${loop.from}->${loop.to}`) ?? 0
              if (used < (loop.maxIter ?? 1)) {
                loopUsed.set(`${loop.from}->${loop.to}`, used + 1)
                emit({
                  type: 'graph/loop-iteration',
                  graphId,
                  node: current,
                  timestamp: Date.now(),
                  data: { iteration: used + 1, maxIter: loop.maxIter },
                })
                next = loop.to
              } else {
                // loop 用尽 → 走审批路径（cond 边 to 含 approval 或直接终止）
                const approval = edges.find((e) => e.from === current && e.to.includes('approval'))
                next = approval?.to ?? END
              }
            } else {
              const seq = outgoing.find((e) => e.type === 'seq')
              next = seq?.to ?? END
            }
          }

          if (next === END || next === undefined) {
            break
          }
          current = next
        } catch (error) {
          emit({
            type: 'graph/node-error',
            graphId,
            node: current,
            timestamp: Date.now(),
            data: { error: error instanceof Error ? error.message : String(error) },
          })
          return {
            graphId,
            success: false,
            finalState: state,
            trajectory,
            iterations: iteration,
            error: error instanceof Error ? error : new Error(String(error)),
          }
        } finally {
          // RES.5 §四：release 必须在 finally（防止节点失败死锁）
          concurrency.release()
        }
      }

      emit({ type: 'graph/end', graphId, timestamp: Date.now() })
      return { graphId, success: true, finalState: state, trajectory, iterations: iteration }
    },
  }
}
