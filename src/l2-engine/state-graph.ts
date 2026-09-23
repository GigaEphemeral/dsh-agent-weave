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
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ConditionHandler,
  GraphExecutionResult,
  GraphNodeContext,
  NodeHandler,
  NodeMeta,
  RunOptions,
  TrajectoryEvent,
} from './types.js'
import { mergeState } from './atomic-merge.js'
import { createQueueingCounter } from './concurrency-counter.js'
import { edgeKey, resolveNextNode } from './condition-edge.js'
import type { RunLedger, LedgerEventType } from '../l5-observability/run-ledger.js'
import type { TokenCollector } from '../l5-observability/token-collector.js'
import { logger } from '../shared/logger.js'

/** 已注册 provider 名列表（安全读取，失败返回空——问题 2 定位日志用）。 */
function safeProviderList(ctx: Context): string[] {
  try {
    return ctx.subagents.list()
  } catch {
    return []
  }
}

/** 子代理端信息最小形态（subagent/end 事件载荷）。 */
interface SubagentEndLike {
  id: string
  provider: string
  stopReason?: string
  lastAssistantMessage?: Array<{ type: string; text?: string }>
}

/**
 * 等待一个 durable child 的 subagent/end 事件（问题三：continuable 无 result，
 * 结果经生命周期事件异步返回）。订阅发生在调用时；超时/中止兜底返回空 output。
 * 默认 5 分钟（LLM 子代理执行量级），超时记日志并返回空（不挂死图）。
 */
function waitForSubagentEnd(
  ctx: Context,
  childId: string,
  signal?: AbortSignal,
  timeoutMs = 300_000,
): Promise<{ output: Array<{ type: string; text?: string }>; stopReason: string }> {
  return new Promise((resolve) => {
    let done = false
    let timer: NodeJS.Timeout | null = null
    const finish = (info?: SubagentEndLike): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      ;(ctx as unknown as { off(name: string, cb: (info: SubagentEndLike) => void): void }).off('subagent/end', onEnd)
      resolve({
        output: info?.lastAssistantMessage ?? [],
        stopReason: info?.stopReason ?? 'completed',
      })
    }
    const onEnd = (info: SubagentEndLike): void => {
      if (info.id === childId) finish(info)
    }
    ;(ctx as unknown as { on(name: string, cb: (info: SubagentEndLike) => void): void }).on('subagent/end', onEnd)
    timer = setTimeout(() => {
      logger.warn('weave-addsubagent', '等待 subagent/end 超时，返回空 output', {
        childId,
        timeoutMs,
      })
      finish()
    }, timeoutMs)
    signal?.addEventListener('abort', () => finish(), { once: true })
  })
}

/** 循环回退反馈（问题三预留：基于当前状态向原子代理说明为何打回）。 */
function buildFeedbackFromState(state: Record<string, unknown>, node: string): string {
  const messages = (state.messages as Array<{ node?: string; stopReason?: string }> | undefined) ?? []
  const last = messages[messages.length - 1]
  return `[工作流反馈] 节点 ${node} 需要你基于上下文继续处理。\n` +
    `上游状态：messages=${messages.length} 条。\n` +
    `请根据已有工作继续，不要从头开始。${last?.stopReason ? `（上次 stopReason: ${last.stopReason}）` : ''}`
}

/** 轨迹事件 → ledger 事件类型映射（P1-1）。 */
function mapToLedgerType(type: TrajectoryEvent['type']): LedgerEventType {
  switch (type) {
    case 'graph/start': return 'graph/start'
    case 'graph/node-start': return 'graph/node-start'
    case 'graph/node-end': return 'graph/node-end'
    case 'graph/node-error': return 'graph/node-error'
    case 'graph/end': return 'graph/end'
    case 'graph/checkpoint-written': return 'checkpoint-written'
    default: return 'checkpoint-written' // error / loop-iteration → 保守映射
  }
}

export const END = '__END__'
/** NEW-4：显式跳过本条件边，让引擎尝试下一条或静态边。 */
export const SKIP = '__SKIP__'

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
  /** NEW-10：addNode 支持 meta（role 数据来源，供 node-start 事件）。 */
  addNode(name: string, handler: NodeHandler<T>, meta?: NodeMeta): this
  /** P3.A.1：添加真实子代理节点（role 节点接 ctx.subagents.start，产物落盘）。 */
  addSubagent(name: string, options: SubagentNodeOptions): this
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
  /** 角色 provider 名（= 角色 YAML id，如 R6-developer）。 */
  provider: string
  /** prompt 模板：可含 {{user_input}} / {{upstream}} / {{state}} 占位。 */
  promptTemplate?: string
  outputSchema?: unknown
  /** 产物落盘目录（相对 artifactsRoot/<graphId>/<node>/）；缺省不落盘。 */
  artifactName?: string
  /** 节点 meta（NEW-10 currentRole 数据来源）。 */
  role?: string
}

/** 引擎实例选项。 */
export interface EngineOptions {
  maxIterations?: number
  maxConcurrentChildren?: number
  /** 产物/轨迹根目录（S9：传入则事件流式落盘 traces/<graphId>.jsonl）。 */
  artifactsRoot?: string
}

/** P4.0.1 + P1-1/P1-2：引擎可选观测接入点。 */
export interface EngineObservability {
  /** 事件接收器（每个 graph/* 事件同步回调，供共享总线桥接）。 */
  eventSink?: (event: TrajectoryEvent) => void
  /** RunLedger（只追加审计账本，P1-1）。 */
  ledger?: RunLedger
  /** Token 分账收集器（node-end 时写，P1-2）。 */
  tokenCollector?: TokenCollector
  /** P4.B.7：节点完成观察器（返回 signaled 则写 ledger + emit observer-signal）。 */
  observer?: {
    observe(node: string, state: Record<string, unknown>): { signaled: boolean; signal?: Record<string, unknown> }
  }
}

export function createStateGraph<T extends Record<string, unknown>>(
  ctx: Context,
  maxIterations = 25,
  maxConcurrentChildren = 8,
  artifactsRoot?: string,
  eventSink?: (event: TrajectoryEvent) => void,
  ledger?: RunLedger,
  tokenCollector?: TokenCollector,
  observer?: EngineObservability['observer'],
): StateGraph<T> {
  const nodes = new Map<string, NodeHandler<T>>()
  const nodeMetas = new Map<string, NodeMeta>() // NEW-10
  const edges: InternalEdge[] = []
  const conditionalEdges: InternalConditionalEdge[] = []
  const approvalGates = new Map<string, ApprovalGateOptions>()
  let entryPoint: string | null = null

  // P3.D.4：排队版并发闸（超限排队等待，非拒绝）
  const concurrency = createQueueingCounter(ctx, maxConcurrentChildren)

  /** 节点角色（P1-2 token 分账 data source；缺省回退 nodeType/节点名）。 */
  const roleOf = (node: string): string => nodeMetas.get(node)?.role ?? node

  return {
    addNode(name, handler, meta) {
      if (name === END) throw new Error('__END__ 是保留哨兵')
      if (nodes.has(name)) throw new Error(`节点已存在: ${name}`)
      nodes.set(name, handler)
      if (meta !== undefined) nodeMetas.set(name, meta) // NEW-10
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

    // P3.A.1 + 问题三最小版：真实子代理节点（role 节点用 startContinuable 建 durable child，
    // 子代理 session 持久化，后续可被 sendMessage 互动/循环回退复用）
    addSubagent(name, options) {
      if (name === END || name === SKIP) throw new Error(`${name} 是保留哨兵`)
      if (nodes.has(name)) throw new Error(`节点已存在: ${name}`)
      // 节点级持久化：node → durable child session id（同一节点复用同一子代理）
      const childIdByNode = new Map<string, string>()
      nodes.set(name, async (state, nodeCtx, signal) => {
        const agent = nodeCtx.agent
        if (!agent) throw new Error(`子代理节点 "${name}" 需要 RunOptions.agent（真实 Agent 作 parent）`)
        const upstreamArtifacts = state.artifacts as Record<string, string> | undefined
        const upstreamSummary = upstreamArtifacts
          ? Object.entries(upstreamArtifacts).map(([n, p]) => `[${n}] ${p}`).join('\n')
          : '（无上游产物）'
        // 通道 C（问题 5）：行为约束——子代理每步输出 [动作]，供观测"在干什么"
        const prompt = (options.promptTemplate ??
          '以 {{provider}} 角色完成任务：\n{{user_input}}\n\n上游产物：\n{{upstream}}\n\n' +
          '【行为约束】每次调用工具前，先输出一行 "[动作] 正在 <做什么>（工具: <toolName>）"，例如 "[动作] 正在搜索相关文件（工具: glob）"。')
          .replaceAll('{{provider}}', options.provider)
          .replaceAll('{{user_input}}', String((state.user_input as string | undefined) ?? ''))
          .replaceAll('{{upstream}}', upstreamSummary)
        const startAt = Date.now()
        // 问题 2 定位日志①：start 调用前（确认参数与 provider 解析路径）
        logger.info('weave-addsubagent', 'start 调用前', {
          node: name,
          provider: options.provider,
          hasAgent: Boolean(agent),
          agentSession: agent?.sessionId ?? '',
          graphId: nodeCtx.graphId,
          iteration: nodeCtx.iteration,
          signalAborted: signal?.aborted ?? false,
          registeredProviders: safeProviderList(nodeCtx.ctx),
          promptLen: prompt.length,
          existingChildId: childIdByNode.get(name) ?? '',
        })

        const existingChildId = childIdByNode.get(name)
        let result: { output: Array<{ type: string; text?: string }>; stopReason: string }

        if (!existingChildId) {
          // 首次激活：startContinuable 建 durable child（问题三最小版）
          try {
            const started = await nodeCtx.ctx.subagents.startContinuable({
              provider: options.provider,
              label: `${name}（${options.provider}）`,
              request: {
                prompt: [{ type: 'text', text: prompt }],
                parent: agent as never,
                ...(options.role !== undefined ? { label: `${name}（${options.provider}）` } : {}),
              },
              signal: signal ?? new AbortController().signal,
            })
            childIdByNode.set(name, started.childId)
            // 问题 2 定位日志③：continuable 创建成功（childId 持久化）
            logger.info('weave-addsubagent', 'startContinuable 返回', {
              node: name,
              provider: options.provider,
              childId: started.childId,
              elapsedMs: Date.now() - startAt,
            })
            // 等待初始 turn 完成（subagent/end 事件驱动；这里用生命周期事件等待）
            result = await waitForSubagentEnd(nodeCtx.ctx, started.childId, signal)
          } catch (error) {
            // 问题 2 定位日志②：startContinuable 抛错（区分"没调到 delegate"）
            logger.error('weave-addsubagent', 'startContinuable() 抛错', error instanceof Error ? error : new Error(String(error)), {
              node: name,
              provider: options.provider,
              elapsedMs: Date.now() - startAt,
            })
            throw error
          }
        } else {
          // 循环回退/后续激活：sendMessage 追加反馈（问题三预留；MVP-4 最小版仅创建）
          // 注：sendMessage 单向投递，结果经 subagent/end 事件异步返回，见 waitForSubagentEnd
          const feedback = buildFeedbackFromState(state, name)
          try {
            await nodeCtx.ctx.subagents.sendMessage(
              agent as never,
              existingChildId as never, // SessionId 品牌类型由运行期保证
              [{ type: 'text', text: feedback }],
              { signal: signal ?? new AbortController().signal },
            )
            logger.info('weave-addsubagent', 'sendMessage 反馈已投递', {
              node: name,
              childId: existingChildId,
              feedbackLen: feedback.length,
            })
            result = await waitForSubagentEnd(nodeCtx.ctx, existingChildId, signal)
          } catch (error) {
            logger.error('weave-addsubagent', 'sendMessage 失败', error instanceof Error ? error : new Error(String(error)), {
              node: name,
              childId: existingChildId,
            })
            throw error
          }
        }

        const text = result.output.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim()
        // 问题 2 定位日志④：result 内容（确认 stopReason / output 是否为空）
        logger.info('weave-addsubagent', '子代理执行返回', {
          node: name,
          provider: options.provider,
          childId: childIdByNode.get(name) ?? '',
          stopReason: result.stopReason,
          outputBlocks: result.output.length,
          textLen: text.length,
          textHead: text.slice(0, 200),
          elapsedMs: Date.now() - startAt,
        })

        // 产物落盘（artifactsRoot 传入且配置 artifactName 时）
        const patch: Record<string, unknown> = {
          messages: [{ role: options.provider, node: name, at: Date.now(), stopReason: result.stopReason }],
        }
        if (options.artifactName && artifactsRoot) {
          const nodeDir = join(artifactsRoot, 'graph-artifacts', name)
          mkdirSync(nodeDir, { recursive: true })
          const file = join(nodeDir, options.artifactName)
          writeFileSync(file, text, 'utf8')
          patch.artifacts = { [name]: file }
        }
        return patch as Partial<T>
      })
      if (options.role !== undefined) nodeMetas.set(name, { role: options.role })
      if (!entryPoint) entryPoint = name
      return this
    },

    async run(initialState, options) {
      if (!entryPoint) throw new Error('图无入口节点')
      // S1：graphVersion/graphSchemaHash 必需，禁止硬编码
      if (!options.graphVersion) throw new Error('RunOptions.graphVersion 是必需的（RES.8 §三.1）')
      if (!options.graphSchemaHash) throw new Error('RunOptions.graphSchemaHash 是必需的（RES.8 §三.1）')

      // ★ 问题一步骤0：graphId 从 options 读（外部指定统一值），缺省才自己生成
      const graphId = options.graphId ?? `graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const trajectory: TrajectoryEvent[] = []
      let state = initialState
      let current: string = entryPoint
      let iteration = options.initialIteration ?? 0

      // S9：trace 事件落盘（可选，artifactsRoot 传入时同步追加；可靠性优先）
      const trace: { file: string | null } = { file: null }
      const ensureTraceFile = () => {
        if (trace.file || !artifactsRoot) return
        try {
          const traceDir = join(artifactsRoot, 'traces')
          mkdirSync(traceDir, { recursive: true })
          trace.file = join(traceDir, `${graphId}.jsonl`)
        } catch {
          trace.file = null // 落盘失败不阻塞执行
        }
      }

      const emit = (event: TrajectoryEvent) => {
        trajectory.push(event)
        // graph/* 事件非 Cordis 内置 Events 类型，用宽松签名发射
        ;(ctx.emit as (name: string, payload: unknown) => void)(event.type, event)
        // P4.0.1：可选事件接收器（共享总线/SSE 桥接）
        eventSink?.(event)
        // P1-1：RunLedger 只追加（node 级事件；error/loop 保守映射）
        if (ledger && event.node) {
          ledger.append({
            type: mapToLedgerType(event.type),
            graphId: event.graphId,
            node: event.node,
            timestamp: event.timestamp,
            ...(event.data !== undefined ? { data: event.data } : {}),
          })
        }
        // P1-2：node-end 写 token 分账（真实数值非 0 来源）
        if (event.type === 'graph/node-end' && event.data) {
          const d = event.data
          if (typeof d.inputTokens === 'number') {
            tokenCollector?.record(event.node ?? '', roleOf(event.node ?? ''), {
              inputTokens: d.inputTokens,
              outputTokens: (d.outputTokens as number) ?? 0,
              cacheReadTokens: (d.cacheReadTokens as number) ?? 0,
            })
          }
        }
        // P4.B.7：node-end 后触发观察者（signaled → ledger + emit observer-signal）
        if (event.type === 'graph/node-end' && observer && event.node) {
          try {
            const result = observer.observe(event.node, state)
            if (result.signaled && result.signal) {
              const sigEvt: TrajectoryEvent = {
                type: 'graph/observer-signal',
                graphId: event.graphId,
                node: event.node,
                timestamp: Date.now(),
                data: result.signal,
              }
              ledger?.append({
                type: 'observer-signal',
                graphId: event.graphId,
                node: event.node,
                timestamp: sigEvt.timestamp,
                data: result.signal,
              })
              eventSink?.(sigEvt)
            }
          } catch {
            // 观察失败不阻塞执行（fail-open）
          }
        }
        ensureTraceFile()
        if (trace.file) {
          try {
            appendFileSync(trace.file, `${JSON.stringify(event)}\n`, 'utf8')
          } catch {
            // 追加失败静默（不阻塞执行）
          }
        }
      }

      emit({ type: 'graph/start', graphId, timestamp: Date.now() })

      // 循环回退计数（S4 落盘恢复；NEW-2：initialLoopUsage 接通恢复）
      const loopUsed = options.initialLoopUsage
        ? new Map(Object.entries(options.initialLoopUsage))
        : new Map<string, number>()

      while (current !== END) {
        // P4.D.1：节点边界 STOP 检查（先于迭代计数——STOP 应立即可终止）
        if (artifactsRoot && existsSync(join(artifactsRoot, 'STOP'))) {
          emit({ type: 'graph/end', graphId, timestamp: Date.now(), data: { stopped: true } })
          return { graphId, success: true, finalState: state, trajectory, iterations: iteration, data: { stopped: true } }
        }
        // P4.D.1：节点边界 PAUSE 检查（等待 RESUME/STOP；200ms 轮询 + 外部中止）
        if (artifactsRoot && existsSync(join(artifactsRoot, 'PAUSE'))) {
          emit({ type: 'graph/end', graphId, timestamp: Date.now(), data: { status: 'paused', pausedAt: Date.now() } })
          // 暂停等待循环：RESUME 文件出现或 STOP 文件出现或 signal 中止
          while (existsSync(join(artifactsRoot, 'PAUSE'))) {
            if (options.signal?.aborted) {
              emit({ type: 'graph/end', graphId, timestamp: Date.now(), data: { status: 'failed', reason: 'aborted' } })
              return { graphId, success: false, finalState: state, trajectory, iterations: iteration, error: new Error('暂停等待被中止') }
            }
            if (existsSync(join(artifactsRoot, 'STOP'))) {
              emit({ type: 'graph/end', graphId, timestamp: Date.now(), data: { stopped: true } })
              return { graphId, success: true, finalState: state, trajectory, iterations: iteration, data: { stopped: true } }
            }
            await new Promise((r) => setTimeout(r, 200))
          }
          // 恢复：发 node-start 续跑（PAUSE 文件被删除或 RESUME 写入）
          emit({ type: 'graph/checkpoint-written', graphId, node: current, timestamp: Date.now(), data: { resumed: true } })
        }

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
            // P1-3：优先走分级审批策略（approvalPolicy 存在时）
            if (options.approvalPolicy) {
              const gateResult = await options.approvalPolicy.gate(
                { level: 'L2', reason: gate.reason ?? `节点 ${current} 需审批`, nodeId: current },
                { ...(options.signal !== undefined ? { signal: options.signal } : {}) },
              )
              if (gateResult.outcome !== 'allowed') {
                // 超时自动继续/升级仍可放行（L1 timeout-auto-continue 语义）
                if (gateResult.outcome !== 'timeout-auto-continue') {
                  throw new Error(`审批门 "${current}" 未通过（${gateResult.outcome}：${gateResult.audit}）`)
                }
              }
            } else if (!approvalService) {
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

          // NEW-10：node-start 携带 role（currentRole 数据来源）
          emit({
            type: 'graph/node-start',
            graphId,
            node: current,
            timestamp: Date.now(),
            data: { role: nodeMetas.get(current)?.role ?? '' },
          })

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

          // 解析下一节点：条件边优先（函数式），否则声明式（S5：统一走 resolveNextNode）
          const conditional = conditionalEdges.filter((e) => e.from === current)
          let next: string | undefined
          for (const ce of conditional) {
            if (ce.used >= ce.maxIter) {
              // 边级熔断：跳过该条件边（回退到静态边或终止）
              continue
            }
            const result = await ce.condition(state as unknown as Record<string, unknown>, nodeCtx as never, options.signal)
            const resolved = Array.isArray(result) ? result[0] : result
            // NEW-4：SKIP 显式跳过，让引擎尝试下一条条件边或静态边
            if (resolved === SKIP) continue
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
            // S5：统一调用 resolveNextNode（声明式 seq/loop 决策唯一实现）
            const usage = Object.fromEntries(loopUsed)
            next = resolveNextNode(current, edges as never, state as unknown as Record<string, unknown>, usage)
            const key = edgeKey(current, next)
            if (next !== END && edges.some((e) => e.from === current && e.type === 'loop' && e.to === next)) {
              loopUsed.set(key, (loopUsed.get(key) ?? 0) + 1)
              emit({
                type: 'graph/loop-iteration',
                graphId,
                node: current,
                timestamp: Date.now(),
                data: { iteration: loopUsed.get(key), from: current, to: next },
              })
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
      return { graphId, success: true, finalState: state, trajectory, iterations: iteration }
    },
  }
}
