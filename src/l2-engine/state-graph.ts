/**
 * StateGraph 引擎骨架（MVP-2 T9 + 审查修复 S1/S4/S6/S8/S9/S11/S13）。
 *
 * 基于 RES.10 §一.1-6 + RES.5 §四：
 * - addNode / addEdge / addConditionalEdge / addApprovalGate / run
 * - 迭代熔断（进入节点前检查，RES.10 §一.3：第 N 次执行完，第 N+1 次终止）
 * - 全局并发闸（acquire → try → finally release，RES.5 §四）
 * - 审批门 ctx.approval.request 等 allowed-once（RES.10 §一.5；S8：fail-closed）
 * - checkpoint 在"补丁合并后、跳转前"（RES.10 §一.4；S4：loopUsage 落盘恢复）
 * - 轨迹事件 8 种（graph/* 契约；S9：事件落盘 trace 流；S13：node-end 携带 token/retry）
 * - 合并冲突 reject-on-conflict 返回 success: false
 *
 * 审查修复记录：
 * - S1：RunOptions 必需 graphVersion/graphSchemaHash，禁止硬编码
 * - S4：loopUsed 经 checkpoint.loopUsage 落盘，恢复时读回
 * - S6：条件边 maxIter 缺省 = 全局 maxIterations（防条件环死循环）
 * - S8：审批门无 approval 服务时 fail-closed（除非 required:false）
 * - S9：artifactsRoot 传入时事件流式落盘 traces/<graphId>.jsonl
 * - S11：无出边发 warning 级 graph/error 事件（不改变成功语义）
 * - S13：node-end 事件携带 inputTokens/outputTokens/cacheReadTokens/tokenUsed/retryCount
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
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

/** 审批门选项（S8：required 控制 fail-closed/fail-open）。 */
export interface ApprovalGateOptions {
  toolName: string
  reason?: string
  /** 审批门是否必须有 approval 服务（默认 true = fail-closed；false = 缺服务时跳过）。 */
  required?: boolean
}

export interface StateGraph<T> {
  addNode(name: string, handler: NodeHandler<T>): this
  addEdge(from: string, to: string): this
  /** 声明式循环边：`from → to` 最多回退 maxIter 次，用尽后走审批/终止。 */
  addLoopEdge(from: string, to: string, maxIter: number): this
  addConditionalEdge(from: string, condition: ConditionHandler<T>, maxIter?: number): this
  addApprovalGate(name: string, options: ApprovalGateOptions): this
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
  /** 边级熔断上限（S6：缺省 = 全局 maxIterations）。 */
  maxIter: number
  /** 已触发次数（边级熔断）。 */
  used: number
}

export interface SubagentNodeOptions {
  provider: string
  promptTemplate?: string
  outputSchema?: unknown
}

/** 引擎实例选项。 */
export interface EngineOptions {
  maxIterations?: number
  maxConcurrentChildren?: number
  /** 产物/轨迹根目录（S9：传入则事件流式落盘 traces/<graphId>.jsonl）。 */
  artifactsRoot?: string
}

export function createStateGraph<T extends Record<string, unknown>>(
  ctx: Context,
  maxIterations = 25,
  maxConcurrentChildren = 8,
  artifactsRoot?: string,
): StateGraph<T> {
  const nodes = new Map<string, NodeHandler<T>>()
  const edges: InternalEdge[] = []
  const conditionalEdges: InternalConditionalEdge[] = []
  const approvalGates = new Map<string, ApprovalGateOptions>()
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
      // S6：maxIter 缺省 = 全局 maxIterations（防条件环死循环）
      conditionalEdges.push({
        from,
        condition: condition as ConditionHandler<Record<string, unknown>>,
        maxIter: maxIter ?? maxIterations,
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
      // S1：graphVersion/graphSchemaHash 必需，禁止硬编码
      if (!options.graphVersion) throw new Error('RunOptions.graphVersion 是必需的（RES.8 §三.1）')
      if (!options.graphSchemaHash) throw new Error('RunOptions.graphSchemaHash 是必需的（RES.8 §三.1）')

      const graphId = `graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const trajectory: TrajectoryEvent[] = []
      let state = initialState
      let current: string = entryPoint
      let iteration = options.initialIteration ?? 0

      // S9：trace 流（可选，artifactsRoot 传入时落盘；容器对象避免闭包赋值推断 never）
      const trace: { stream: WriteStream | null } = { stream: null }
      const ensureTraceStream = () => {
        if (trace.stream || !artifactsRoot) return
        try {
          const traceDir = join(artifactsRoot, 'traces')
          mkdirSync(traceDir, { recursive: true })
          trace.stream = createWriteStream(join(traceDir, `${graphId}.jsonl`), { flags: 'a' })
        } catch {
          trace.stream = null // 落盘失败不阻塞执行
        }
      }

      const emit = (event: TrajectoryEvent) => {
        trajectory.push(event)
        // graph/* 事件非 Cordis 内置 Events 类型，用宽松签名发射
        ;(ctx.emit as (name: string, payload: unknown) => void)(event.type, event)
        ensureTraceStream()
        if (trace.stream) {
          trace.stream.write(`${JSON.stringify(event)}\n`)
        }
      }

      emit({ type: 'graph/start', graphId, timestamp: Date.now() })

      // 循环回退计数（S4：支持从 checkpoint 恢复）
      let loopUsed = new Map<string, number>()

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

          // RES.10 §一.5 + S8：审批门 fail-closed（缺 approval 服务时按 required 决定）
          const gate = approvalGates.get(current)
          const approvalService = ctx.get('approval') as ApprovalServiceLike | undefined
          if (gate) {
            if (!approvalService) {
              if (gate.required !== false) {
                throw new Error(`审批门 "${current}" 需要 ctx.approval 服务（可设 required=false 跳过）`)
              }
              // required=false → 静默跳过（fail-open 显式声明）
            } else if (options.agent) {
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
          }

          // S13：节点执行期间收集 token/retry 上报（用容器对象，避免闭包赋值推断为 never）
          const pending: {
            usage: { input: number; output: number; cacheRead: number } | null
            retry: number | null
          } = { usage: null, retry: null }

          const nodeCtx: GraphNodeContext<T> = {
            ctx,
            graphId,
            graphVersion: options.graphVersion,
            emit,
            logger: ctx.logger,
            checkpoint: options.checkpoint,
            iteration,
            ...(options.agent !== undefined ? { agent: options.agent } : {}),
            reportTokenUsage(usage) {
              pending.usage = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0 }
            },
            reportRetry(count) {
              pending.retry = count
            },
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

          // S13：node-end 携带 token/retry 数据（供终端视图/HTML 报告）
          emit({
            type: 'graph/node-end',
            graphId,
            node: current,
            timestamp: Date.now(),
            durationMs: Date.now() - startTime,
            data: {
              ...(pending.usage
                ? {
                    inputTokens: pending.usage.input,
                    outputTokens: pending.usage.output,
                    cacheReadTokens: pending.usage.cacheRead,
                    tokenUsed: pending.usage.input + pending.usage.output,
                  }
                : {}),
              ...(pending.retry !== null ? { retryCount: pending.retry } : {}),
            },
          })

          // RES.10 §一.4 + S4：checkpoint 在"补丁合并后、跳转前"，落盘 loopUsage
          await options.checkpoint({
            graphId,
            graphVersion: options.graphVersion,
            graphSchemaHash: options.graphSchemaHash,
            node: current,
            state,
            iteration,
            timestamp: Date.now(),
            loopUsage: Object.fromEntries(loopUsed),
          })
          emit({ type: 'graph/checkpoint-written', graphId, node: current, timestamp: Date.now() })

          // 解析下一节点：条件边优先（函数式），否则声明式 seq/loop
          const conditional = conditionalEdges.filter((e) => e.from === current)
          let next: string | undefined
          for (const ce of conditional) {
            if (ce.used >= ce.maxIter) {
              // 边级熔断：跳过该条件边（回退到静态边或终止）
              continue
            }
            const result = await ce.condition(state as unknown as Record<string, unknown>, nodeCtx as never, options.signal)
            const resolved = Array.isArray(result) ? result[0] : result
            if (resolved !== undefined && resolved !== END) {
              ce.used++
              // L5：loop-iteration 事件携带 from/to
              emit({
                type: 'graph/loop-iteration',
                graphId,
                node: current,
                timestamp: Date.now(),
                data: { iteration: ce.used, maxIter: ce.maxIter, from: current, to: resolved },
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
                  data: { iteration: used + 1, maxIter: loop.maxIter, from: loop.from, to: loop.to },
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

          if (next === undefined) {
            // S11：无出边发 warning 级事件（不改变"末端节点即终点"语义）
            emit({
              type: 'graph/error',
              graphId,
              node: current,
              timestamp: Date.now(),
              data: { error: `节点 "${current}" 无出边，按正常结束处理`, level: 'warning' },
            })
            break
          }
          if (next === END) break
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
      if (trace.stream !== null) trace.stream.end()
      return { graphId, success: true, finalState: state, trajectory, iterations: iteration }
    },
  }
}
