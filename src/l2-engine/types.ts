/**
 * StateGraph 引擎内部类型契约（MVP-2 T1）。
 *
 * 定义引擎全部核心类型，作为后续模块（图定义/静态验证/checkpoint/合并/条件边/
 * 并发闸/引擎骨架/服务）的契约基础。
 *
 * 来源：RES.10 §一.1/2/4 提炼的实际签名 + RES.8 §三 graphVersion 双字段 + DSH 实测。
 */
import type { Context } from '@deepseek-ai/cordis'

/** 结构化日志接口（与 shared/logger 对齐，解耦引擎对具体实现的依赖）。 */
export interface Logger {
  info(component: string, msg: string, data?: Record<string, unknown>): void
  warn(component: string, msg: string, data?: Record<string, unknown>): void
  error(component: string, msg: string, error: Error, data?: Record<string, unknown>): void
  debug(component: string, msg: string, data?: Record<string, unknown>): void
}

/**
 * 节点处理器：接收 State 和上下文，返回 `Partial<State>` 增量补丁（RES.10 §一.2）。
 * 引擎统一原子合并补丁；节点自身不修改 state。
 */
export type NodeHandler<T> = (
  state: T,
  ctx: GraphNodeContext<T>,
  signal?: AbortSignal,
) => Promise<Partial<T>>

/**
 * 条件处理器：返回下一个节点名（单目标）或并行目标数组（MVP-3 预留）。
 * 返回 `'__END__'` 哨兵表示终止。
 */
export type ConditionHandler<T> = (
  state: T,
  ctx: GraphNodeContext<T>,
  signal?: AbortSignal,
) => string | readonly string[] | '__END__' | Promise<string | readonly string[] | '__END__'>

/** 节点执行上下文。 */
export interface GraphNodeContext<T> {
  /** Cordis 上下文。 */
  ctx: Context
  /** 当前图实例 ID（引擎生成：graph-{ts}-{rand}）。 */
  graphId: string
  /** 图 DSL 版本（RES.8 §三.1）。 */
  graphVersion: string
  /** 轨迹事件发射器（graph/* 事件）。 */
  emit: (event: TrajectoryEvent) => void
  /** 结构化日志。 */
  logger: Logger
  /** checkpoint 回调（节点补丁合并后触发）。 */
  checkpoint: CheckpointCallback<T>
  /** 当前迭代次数（从 1 起）。 */
  iteration: number
  /** 审批上下文（审批门节点需要；经 run options 注入）。 */
  agent?: Agent
}

/**
 * 轨迹事件（graph/* 事件契约，MVP-4 对齐 OTel）。
 * 8 种类型：graph/start / node-start / node-end / node-error / error / end /
 * checkpoint-written / loop-iteration。
 */
export interface TrajectoryEvent {
  type:
    | 'graph/start'
    | 'graph/node-start'
    | 'graph/node-end'
    | 'graph/node-error'
    | 'graph/error'
    | 'graph/end'
    | 'graph/checkpoint-written'
    | 'graph/loop-iteration'
  graphId: string
  /** 关联节点（graph/start、graph/end、graph/error 可为空）。 */
  node?: string
  timestamp: number
  /** 节点耗时（node-end 携带）。 */
  durationMs?: number
  /** 附加数据（如 loop-iteration 的 iteration/maxIter、error 的 message）。 */
  data?: Record<string, unknown>
}

/** 图执行结果（RES.10 §一.2 的 GraphExecutionResult 形态）。 */
export interface GraphExecutionResult<T> {
  graphId: string
  success: boolean
  finalState: T
  trajectory: TrajectoryEvent[]
  iterations: number
  error?: Error
}

/** 运行选项（checkpoint 必需 + agent + 中止信号）。 */
export interface RunOptions<T> {
  /** checkpoint 回调（必需，RES.10 §一.4）。 */
  checkpoint: CheckpointCallback<T>
  /** 审批上下文（审批门需要；MVP-2 经 CLI 注入 mock 或真实 agent）。 */
  agent?: Agent
  /** 中止信号。 */
  signal?: AbortSignal
  /** 初始迭代次数（默认 0，恢复场景用）。 */
  initialIteration?: number
}

/** checkpoint 载荷（节点补丁合并后落盘；含 graphVersion 双字段，RES.8 §三.1）。 */
export interface CheckpointPayload<T> {
  graphId: string
  /** 图 DSL 语义版本（semver）。 */
  graphVersion: string
  /** DSL schema 内容哈希（CVC 内容寻址思想）。 */
  graphSchemaHash: string
  node: string
  state: T
  iteration: number
  timestamp: number
}

/** checkpoint 回调：落盘/记录；不应抛错（吞掉记日志，fail-safe）。 */
export type CheckpointCallback<T> = (payload: CheckpointPayload<T>) => Promise<void>

// === 图定义规格（与 graph-definition.ts 共享） ===

/** 图定义规格（YAML → 已校验数据）。 */
export interface GraphDefinitionSpec {
  version: string
  /** 图 DSL 语义版本（semver，RES.8 §三.1）。 */
  graphVersion: string
  /** DSL schema 内容哈希（CVC 内容寻址思想）。 */
  graphSchemaHash: string
  entryPoint: string
  /** 全局最大迭代次数（默认 25，RES.10 §一.3）。 */
  maxIterations?: number
  nodes: GraphNodeSpec[]
  edges: GraphEdgeSpec[]
  checkpoint: CheckpointSpec
  metadata: GraphMetadata
  observers?: ObserverConfig[]
}

/** 图节点规格。 */
export interface GraphNodeSpec {
  /** 必须匹配 ^[a-z][a-z0-9_-]*$（RES.10 §二.5）。 */
  id: string
  /** 角色引用（role 节点必有；condition/approval 无）。 */
  roleRef?: string
  promptTemplate?: string
  nodeType: 'role' | 'condition' | 'approval'
}

/** 图边规格。 */
export interface GraphEdgeSpec {
  from: string
  to: string
  type: 'seq' | 'cond' | 'loop' | 'parallel'
  /** 条件表达式（cond 边必有）。 */
  when?: string
  /** 循环边最大回退次数（loop 边必有）。 */
  maxIter?: number
}

/** checkpoint 规格。 */
export interface CheckpointSpec {
  strategy: 'node-level'
  storage: 'session-log' | 'sqlite' | 'fs'
}

/** 图元数据。 */
export interface GraphMetadata {
  source: 'canvas' | 'yaml' | 'hybrid'
  createdAt: string
  updatedAt: string
}

/** 观察者配置（MVP-3 全量启用；MVP-2 仅静态校验 + L1）。 */
export interface ObserverConfig {
  id: string
  roleRef: string
  observeNodes: string[]
  observationMode: 'file-watch' | 'event-stream' | 'hybrid'
  interventionMode: 'flag-only' | 'sanitize' | 'block'
  criteria: string[]
  tokenBudget: number
}

/** Agent 最小形态（来自 @deepseek-ai/dsh-agent，RES.3 §三 实测；解耦完整类型）。 */
export interface Agent {
  readonly sessionId: string
  readonly options?: { provider?: string; model?: string }
}
