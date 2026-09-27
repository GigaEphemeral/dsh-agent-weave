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
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
import { validateNodeOutput } from './node-validator.js'
import { getGraphControl, clearGraphControl } from './graph-control.js'
import { classifyError } from './error-classifier.js'
import { writePauseSnapshot } from './pause-snapshot.js'
import { waitForSubagentEnd, PauseError } from './subagent-waiter.js'
import { buildRoleBoundaryBlock } from '../l3-roles/role-prompt.js'
import { buildUpstreamContextBlocks } from './handoff-extractor.js'
import type { PauseSnapshot } from './types.js'
import type { RunLedger, LedgerEventType } from '../l5-observability/run-ledger.js'
import type { TokenCollector } from '../l5-observability/token-collector.js'
import { logger } from '../shared/logger.js'
import { reusableFindingsText } from './findings-pool.js'

/** ★ v2.0 Phase E：当前节点上下文（publish_finding 用；handler 前后设置）。 */
let currentNodeCtx: { artifactsRoot: string | undefined; graphId: string; nodeId: string } | null = null
export function getCurrentNodeCtx(): { artifactsRoot: string | undefined; graphId: string; nodeId: string } {
  return currentNodeCtx ?? { artifactsRoot: undefined, graphId: '', nodeId: '' }
}

/** ★ 问题2：全局 graphId → (nodeId → childId) 映射（节点级控制：interrupt/sendMessage）。 */
const graphNodeChildren = new Map<string, Map<string, string>>()
export function getNodeChildId(graphId: string, nodeId: string): string | undefined {
  return graphNodeChildren.get(graphId)?.get(nodeId)
}
export function clearGraphNodeChildren(graphId: string): void {
  graphNodeChildren.delete(graphId)
}

/** ★ 问题2：全局 graphId → parentAgent（interrupt 的 authority）。 */
const graphParentAgents = new Map<string, unknown>()
export function getParentAgent(graphId: string): unknown {
  return graphParentAgents.get(graphId)
}

/** 已注册 provider 名列表（安全读取，失败返回空——问题 2 定位日志用）。 */
function safeProviderList(ctx: Context): string[] {
  try {
    return ctx.subagents.list()
  } catch {
    return []
  }
}

/** 循环回退反馈（问题三预留：基于当前状态向原子代理说明为何打回）。 */
function buildFeedbackFromState(state: Record<string, unknown>, node: string): string {
  const messages = (state.messages as Array<{ node?: string; stopReason?: string }> | undefined) ?? []
  const last = messages[messages.length - 1]
  return `[工作流反馈] 节点 ${node} 需要你基于上下文继续处理。\n` +
    `上游状态：messages=${messages.length} 条。\n` +
    `请根据已有工作继续，不要从头开始。${last?.stopReason ? `（上次 stopReason: ${last.stopReason}）` : ''}`
}

/** 问题三 D1：输入门禁检查（上游产物存在且非空）。 */
function checkInputGate(
  inputGate: { requires: string[]; requiresAny?: string[] } | undefined,
  state: Record<string, unknown>,
  name: string,
): void {
  if (!inputGate) return
  const artifacts = state.artifacts as Record<string, string> | undefined
  const missing: string[] = []
  const check = (reqNode: string): void => {
    const path = artifacts?.[reqNode]
    if (!path) {
      missing.push(`${reqNode}（未产出）`)
      return
    }
    try {
      // v2.0：size < 50 视为空（避免"占位 1 字节"假通过）
      if (!existsSync(path) || statSync(path).size < 50) {
        missing.push(`${reqNode}（产物为空或过小）`)
      }
    } catch {
      missing.push(`${reqNode}（产物不可读）`)
    }
  }
  if (inputGate.requires.length > 0) {
    for (const reqNode of inputGate.requires) check(reqNode)
  } else if (inputGate.requiresAny && inputGate.requiresAny.length > 0) {
    const anyOk = inputGate.requiresAny.some((n) => {
      const p = artifacts?.[n]
      return p !== undefined && existsSync(p) && statSync(p).size >= 50
    })
    if (!anyOk) missing.push(`requiresAny（均未产出有效产物）`)
  }
  if (missing.length > 0) {
    throw new Error(`输入门禁未过（节点 ${name}）: ${missing.join(', ')}`)
  }
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
  /** 问题四：质量门（产物验证；空数组不验证）。★ v2.0：结构化 QualityGate。 */
  qualityGate?: readonly (string | { type: string; [k: string]: unknown })[]
  /** 问题三 D1：输入门禁（要求上游节点产物存在且非空）。 */
  inputGate?: {
    requires: string[]
    requiresAny?: string[]
  }
  /** ★ v2.0：角色定义（Prompt 边界块注入 + quality_gate 数据源）。 */
  roleDefinition?: { id: string; capabilities: string[]; role_boundary?: { responsibilities?: string[]; forbidden?: string[]; artifact?: { name: string; type: string; required_sections: string[] } } }
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

  /** 问题五：node → durable child session id（同节点复用同一子代理；恢复场景预填）。 */
  const childIdByNode = new Map<string, string>()

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
      nodes.set(name, async (state, nodeCtx, signal) => {
        const agent = nodeCtx.agent
        if (!agent) throw new Error(`子代理节点 "${name}" 需要 RunOptions.agent（真实 Agent 作 parent）`)
        // 问题三 D1：输入门禁（上游产物存在且非空；缺失 → 抛错 → 图停）
        checkInputGate(options.inputGate, state, name)
        // ★ v2.0 Phase F：上游产物 handoff 注入（已探测/已决策/遗留 → 下游避免重复探测）
        const upstreamArtifacts = state.artifacts as Record<string, string> | undefined
        let upstreamSummary = '（无上游产物）'
        if (upstreamArtifacts && Object.keys(upstreamArtifacts).length > 0) {
          const blocks: string[] = []
          for (const [n, p] of Object.entries(upstreamArtifacts)) {
            let text = ''
            try {
              if (existsSync(p) && statSync(p).size < 1_048_576) {
                text = readFileSync(p, 'utf8')
              }
            } catch {
              // 读取失败仅列路径
            }
            if (text.length > 0) {
              blocks.push(`【上游 ${n} 产物】\n  · 文件: ${p}`)
              blocks.push(...buildUpstreamContextBlocks(text))
            } else {
              blocks.push(`【上游 ${n} 产物】\n  · 路径: ${p}`)
            }
          }
          upstreamSummary = blocks.join('\n')
        }
        // 通道 C（问题 5）：行为约束——子代理每步输出 [动作]，供观测"在干什么"
        // ★ v2 问题2 方案B：默认模板强调"单一职责"（防止 R1 越权做 R2/R4/R6 的活）
        const defaultTemplate = `你是 {{provider}}，请完成下列**单一职责**任务。

【用户原始需求】（这是整个工作流的输入，不是你一个人的任务）
{{user_input}}

【上游产物】（你只需基于这些内容工作）
{{upstream}}

【你的任务】
仅完成 {{provider}} 角色职责范围内的产出。**不要越权做其他角色的工作**。
例如：你是需求分析师时，只写需求文档，**不要写代码/架构/测试文档**。

【你的产出】
文件名：{{artifactName}}
写完即结束，不要在产物外附加说明性文字。

【行为约束】
每次调用工具前，先输出一行 "[动作] 正在 <做什么>（工具: <toolName>）"。`
        // ★ 问题1 修法：user_input 只给 entry 节点（无 seq 上游）；下游节点不注入原始需求（防越权）
        const hasSeqUpstream = edges.some((e) => e.to === name && e.type === 'seq')
        const userInputForPrompt = hasSeqUpstream
          ? '（本节点是下游节点，用户原始需求已在上游产物中体现。**你只做自己职责范围内的产出**，不要越权生产其他角色的产物。）'
          : String((state.user_input as string | undefined) ?? '')
        const prompt = (options.promptTemplate ?? defaultTemplate)
          .replaceAll('{{provider}}', options.provider)
          .replaceAll('{{user_input}}', userInputForPrompt)   // ★ 改这行：entry 才注入完整需求
          .replaceAll('{{upstream}}', upstreamSummary)
          .replaceAll('{{artifactName}}', options.artifactName ?? `${name}.md`)
        // ★ v2.0：Prompt 边界块注入（职责/禁止/产物要求/handoff 模板/探测协作）
        const boundaryBlock = buildRoleBoundaryBlock(
          options.roleDefinition as never,
          options.provider,
        )
        // ★ v2.0 Phase E：注入共享发现池（其他节点已探测，避免重复）
        const findingsText = artifactsRoot ? reusableFindingsText(artifactsRoot, nodeCtx.graphId) : ''
        const promptWithBoundary = `${prompt}\n\n${boundaryBlock}${findingsText ? `\n\n${findingsText}` : ''}`
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
          promptLen: promptWithBoundary.length,
          existingChildId: childIdByNode.get(name) ?? '',
        })

        const existingChildId = childIdByNode.get(name)
        let result: { output: Array<{ type: string; text?: string }>; stopReason: string }

        try {
          let activeChildId: string
          if (!existingChildId) {
            // 首次激活：startContinuable 建 durable child（问题三最小版）
            const started = await nodeCtx.ctx.subagents.startContinuable({
              provider: options.provider,
              label: `${name}（${options.provider}）`,
              request: {
                prompt: [{ type: 'text', text: promptWithBoundary }],
                parent: agent as never,
              },
              signal: signal ?? new AbortController().signal,
            })
            childIdByNode.set(name, started.childId)
            // ★ 问题2：登记到全局映射（节点级控制用）
            {
              let m = graphNodeChildren.get(nodeCtx.graphId)
              if (!m) { m = new Map(); graphNodeChildren.set(nodeCtx.graphId, m) }
              m.set(name, started.childId)
            }
            activeChildId = started.childId
            // 问题 2 定位日志③：continuable 创建成功（childId 持久化）
            logger.info('weave-addsubagent', 'startContinuable 返回', {
              node: name,
              provider: options.provider,
              childId: activeChildId,
              elapsedMs: Date.now() - startAt,
            })
          } else {
            // 循环回退/后续激活：sendMessage 追加反馈（保留记忆复用同一 child）
            const feedback = buildFeedbackFromState(state, name)
            await nodeCtx.ctx.subagents.sendMessage(
              agent as never,
              existingChildId as never, // SessionId 品牌类型由运行期保证
              [{ type: 'text', text: feedback }],
              { signal: signal ?? new AbortController().signal },
            )
            activeChildId = existingChildId
            logger.info('weave-addsubagent', 'sendMessage 反馈已投递', {
              node: name,
              childId: existingChildId,
              feedbackLen: feedback.length,
            })
          }

          // ★ 步骤3：新 waiter 订阅活动 → 转发 graph/node-activity / idle-warning / loop-detected
          // （问题三 A3：无硬超时；A4/A5：中止 → interrupt；D2/D3：循环/空闲仅提示）
          // ★ Bugs-V1 §9.4：图级控制信号优先（graphSignal）；缺省用 run signal
          const effectiveSignal = nodeCtx.graphSignal ?? signal
          result = await waitForSubagentEnd(nodeCtx.ctx, activeChildId, {
            ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
            parentAgent: agent, // 关键：父 Agent 作 interrupt authority（A5）
            onActivity: (activity) => {
              nodeCtx.emit({
                type: 'graph/node-activity',
                graphId: nodeCtx.graphId,
                node: name,
                timestamp: Date.now(),
                data: { childId: activeChildId, ...activity },
              })
            },
            onIdleWarning: (idleMs) => {
              nodeCtx.emit({
                type: 'graph/node-idle-warning',
                graphId: nodeCtx.graphId,
                node: name,
                timestamp: Date.now(),
                data: { childId: activeChildId, idleMs },
              })
            },
            onLoopDetected: (tool, repeatCount) => {
              nodeCtx.emit({
                type: 'graph/node-loop-detected',
                graphId: nodeCtx.graphId,
                node: name,
                timestamp: Date.now(),
                data: { childId: activeChildId, tool, repeatCount },
              })
            },
          })
        } catch (error) {
          // 问题 2 定位日志②：start 抛错（区分"没调到 delegate"）
          logger.error('weave-addsubagent', '子代理启动/执行抛错', error instanceof Error ? error : new Error(String(error)), {
            node: name,
            provider: options.provider,
            elapsedMs: Date.now() - startAt,
          })
          throw error
        }

        // ★ v2 问题4 修法1：双重保险——waitForSubagentEnd 已 reject 非 completed，这里再确认
        if (result.stopReason !== 'completed') {
          const err = new Error(`子代理 ${name} 异常结束: stopReason=${result.stopReason}`)
          logger.warn('weave-addsubagent', '子代理非正常结束，节点失败', {
            node: name,
            stopReason: result.stopReason,
            childId: childIdByNode.get(name) ?? '',
          })
          throw err
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
        // 问题四修复1+2 + v2.0：质量门验证（结构化 gate；失败 → 抛错 → 整图停）
        if (options.qualityGate && options.qualityGate.length > 0) {
          const validation = validateNodeOutput(patch, options.qualityGate as never)
          if (!validation.passed) {
            const err = new Error(`质量门未过（节点 ${name}）: ${validation.failures.join('; ')}`)
            logger.warn('weave-addsubagent', '质量门未过，节点失败（整图终止）', {
              node: name,
              failures: validation.failures,
            })
            throw err
          }
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
      // ★ 问题2：登记 parentAgent（节点级 interrupt 的 authority）
      graphParentAgents.set(graphId, options.agent)
      const trajectory: TrajectoryEvent[] = []
      let state = initialState
      // ★ 问题五：startFrom 覆盖入口（恢复场景从暂停节点续跑）
      let current: string = options.startFrom ?? entryPoint
      let iteration = options.initialIteration ?? 0
      // ★ 问题五：恢复场景预填 childSessions（同一子代理复用，不新建）
      if (options.restoredChildSessions) {
        for (const [node, childId] of Object.entries(options.restoredChildSessions)) {
          childIdByNode.set(node, childId)
        }
      }
      // ★ 问题五：已完成节点（恢复场景跳过已完成的产物验证）
      const completedNodes = new Set<string>(options.completedNodes ?? [])

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
        // 问题四修复3：内存化图控制（stop/pause 优先于文件轮询，响应即时）
        const ctrl = getGraphControl(graphId)
        if (ctrl.isStopped()) {
          emit({ type: 'graph/end', graphId, timestamp: Date.now(), data: { stopped: true } })
          return { graphId, success: true, finalState: state, trajectory, iterations: iteration, data: { stopped: true } }
        }
        if (ctrl.isPaused()) {
          emit({ type: 'graph/end', graphId, timestamp: Date.now(), data: { status: 'paused', pausedAt: Date.now() } })
          await ctrl.waitForResume()
          if (ctrl.isStopped()) {
            emit({ type: 'graph/end', graphId, timestamp: Date.now(), data: { stopped: true } })
            return { graphId, success: true, finalState: state, trajectory, iterations: iteration, data: { stopped: true } }
          }
          emit({ type: 'graph/checkpoint-written', graphId, node: current, timestamp: Date.now(), data: { resumed: true } })
        }

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
            // ★ Bugs-V1 §9.4：图级控制信号（暂停/终止打断 subagent）
            graphSignal: ctrl.getSignal(),
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
          // ★ v2.0 Phase E：publish_finding 上下文（handler 执行期间可写发现池）
          currentNodeCtx = { artifactsRoot, graphId, nodeId: current }
          let patch: Partial<T>
          try {
            patch = await handler(state, nodeCtx, options.signal)
          } finally {
            currentNodeCtx = null
          }

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
          // ★ 问题五：记录已完成节点（恢复快照用）
          completedNodes.add(current)

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
          const err = error instanceof Error ? error : new Error(String(error))
          // ★ 问题三 B1/A4+A5 + Bugs-V1 §9.4：用户暂停（PauseError）→ 写快照 + graph/paused
          if (error instanceof PauseError) {
            logger.info('weave', '图暂停（用户暂停）', { graphId, node: current })
            if (artifactsRoot) {
              try {
                const snapshot: PauseSnapshot<T> = {
                  graphId,
                  graphVersion: options.graphVersion,
                  graphSchemaHash: options.graphSchemaHash,
                  pausedNode: current,
                  pausedAt: Date.now(),
                  iteration,
                  resumeFrom: current,
                  pauseReason: 'user-pause',
                  pauseDetails: { suggestedAction: '点恢复继续，或用 weave_graph_resume 恢复' },
                  state,
                  loopUsage: Object.fromEntries(loopUsed),
                  childSessions: Object.fromEntries(childIdByNode),
                  completedNodes: [...completedNodes],
                }
                writePauseSnapshot(artifactsRoot, snapshot)
              } catch (snapErr) {
                logger.warn('weave', '暂停快照落盘失败', {
                  graphId,
                  error: snapErr instanceof Error ? snapErr.message : String(snapErr),
                })
              }
            }
            emit({
              type: 'graph/paused',
              graphId,
              node: current,
              timestamp: Date.now(),
              data: { reason: 'user-pause', childId: error.childId, resumeFrom: current },
            })
            // ★ 问题2：暂停通知主 agent（防自动重跑）
            await notifyMainAgentPaused(ctx, options.agent, {
              graphId,
              node: current,
              reason: 'user-pause',
              ...(artifactsRoot !== undefined ? { artifactsRoot } : {}),
            })
            // 不 clearGraphControl（等 resume 重置信号）
            return {
              graphId, success: true, finalState: state, trajectory, iterations: iteration,
              data: { paused: true, reason: 'user-pause', resumeFrom: current },
            }
          }
          // ★ Bugs-V1 §9.4：用户终止（stop）→ graph/end stopped，不写快照
          if (ctrl.isStopped()) {
            logger.info('weave', '图终止（用户停止）', { graphId, node: current })
            emit({ type: 'graph/end', graphId, node: current, timestamp: Date.now(), data: { stopped: true } })
            clearGraphControl(graphId)
            clearGraphNodeChildren(graphId)
            graphParentAgents.delete(graphId)
            return {
              graphId, success: true, finalState: state, trajectory, iterations: iteration,
              data: { stopped: true },
            }
          }
          // ★ 问题五修复3：错误分类 → 需人工介入 → 暂停快照 + 通知（不再只发 node-error）
          const classification = classifyError(err)
          if (classification.needsUserIntervention && artifactsRoot) {
            try {
              const snapshot: PauseSnapshot<T> = {
                graphId,
                graphVersion: options.graphVersion,
                graphSchemaHash: options.graphSchemaHash,
                pausedNode: current,
                pausedAt: Date.now(),
                iteration,
                resumeFrom: current,
                pauseReason: classification.reason,
                pauseDetails: classification.details,
                state,
                loopUsage: Object.fromEntries(loopUsed),
                childSessions: Object.fromEntries(childIdByNode),
                completedNodes: [...completedNodes],
              }
              writePauseSnapshot(artifactsRoot, snapshot)
              emit({
                type: 'graph/end',
                graphId,
                node: current,
                timestamp: Date.now(),
                data: {
                  status: 'paused',
                  pauseReason: classification.reason,
                  resumeFrom: current,
                  error: err.message,
                },
              })
              logger.warn('weave', '图暂停（需人工介入）', {
                graphId,
                node: current,
                pauseReason: classification.reason,
                snapshotPath: `pauses/${graphId}.json`,
              })
              // ★ 问题2：暂停通知主 agent（防自动重跑）
              await notifyMainAgentPaused(ctx, options.agent, {
                graphId,
                node: current,
                reason: classification.reason,
                ...(artifactsRoot !== undefined ? { artifactsRoot } : {}),
              })
            } catch (snapshotErr) {
              logger.error('weave', '暂停快照落盘失败，回退 node-error', snapshotErr instanceof Error ? snapshotErr : new Error(String(snapshotErr)), { graphId })
            }
            return {
              graphId,
              success: false,
              finalState: state,
              trajectory,
              iterations: iteration,
              error: err,
              data: { paused: true, pauseReason: classification.reason, resumeFrom: current },
            }
          }

          emit({
            type: 'graph/node-error',
            graphId,
            node: current,
            timestamp: Date.now(),
            data: { error: err.message },
          })
          return {
            graphId,
            success: false,
            finalState: state,
            trajectory,
            iterations: iteration,
            error: err,
          }
        } finally {
          // RES.5 §四：release 必须在 finally（防止节点失败死锁）
          concurrency.release()
        }
      }

      emit({ type: 'graph/end', graphId, timestamp: Date.now() })
      // 问题四修复3：运行结束释放内存控制状态
      clearGraphControl(graphId)
      // ★ 问题2：运行结束清理节点级控制映射
      clearGraphNodeChildren(graphId)
      graphParentAgents.delete(graphId)
      return { graphId, success: true, finalState: state, trajectory, iterations: iteration }
    },
  }
}

/** ★ 问题2：图暂停时通知主 agent（防它自动重跑）。双通道：approval 卡 + PAUSED 文件 fallback。 */
async function notifyMainAgentPaused(
  ctx: Context,
  agent: unknown,
  info: { graphId: string; node: string; reason: string; artifactsRoot?: string },
): Promise<void> {
  const reasonText =
    `⚠ 图 ${info.graphId} 已在节点 ${info.node} 暂停（${info.reason}）。\n` +
    `图执行循环已停止，不会再创建下一步子代理。\n\n` +
    `【主 agent 必读】\n` +
    `1. 向用户报告暂停位置与原因，等待用户明确指示。\n` +
    `2. 禁止自动调用 weave_run_graph 重跑整个图（重复消耗 token）。\n` +
    `3. 用户指示继续时，调用 weave_graph_resume graph_id=${info.graphId}。\n` +
    `4. 用户指示放弃时，无需进一步操作。`

  const approvalService = ctx.get('approval') as ApprovalServiceLike | undefined
  if (approvalService && agent) {
    try {
      await approvalService.request({ agent, toolName: 'weave.graph.paused', reason: reasonText })
      logger.info('weave', '已通过 approval 通知主 agent', { graphId: info.graphId })
      return
    } catch (err) {
      logger.warn('weave', 'approval 通知失败，走 fallback', {
        graphId: info.graphId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (info.artifactsRoot) {
    try {
      writeFileSync(join(info.artifactsRoot, 'PAUSED'), reasonText, 'utf8')
      logger.info('weave', '已写 PAUSED 文件（fallback）', { graphId: info.graphId })
    } catch (err) {
      logger.warn('weave', '写 PAUSED 失败', { graphId: info.graphId, error: String(err) })
    }
  }
}
