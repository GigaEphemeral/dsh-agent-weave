/**
 * Client 看板类型（MVP-4 P4.C.1/P4.C.3）。
 *
 * 与 Host 端契约对齐：REST /status /spec /tokens /approvals 响应形态。
 */
/** 图定义规格（Client 侧最小视图，与 Host GraphDefinitionSpec 对应）。 */
export interface ClientGraphSpec {
  entryPoint: string
  maxIterations?: number
  nodes: Array<{ id: string; roleRef?: string; nodeType: string; artifactName?: string; inputGate?: { requires: string[] } }>
  edges: Array<{ from: string; to: string; type: string }>
}

/** 执行快照（对应 event-bus ExecutionSnapshot 的 JSON 序列化）。 */
export interface GraphSnapshot {
  graphId: string
  current: string
  currentRole: string
  iteration: number
  maxIterations: number
  retryCount: number
  maxRetry: number
  startedAt: number
  elapsedMs: number
  tokenUsed: number
  status: string
  nodeStates: Record<string, string>
  /** 暂停原因（graph-paused 事件写入）。 */
  pauseReason?: string
  /** 节点空闲告警（idleMs）。 */
  idleWarnings?: Record<string, number>
  /** 节点循环调用告警。 */
  loopAlerts?: Record<string, Record<string, unknown>>
}

/** Token 行。 */
export interface TokenRow {
  node: string
  role: string
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number }
}

/** 审批请求。 */
export interface ApprovalRequest {
  id: string
  graphId: string
  nodeId: string
  level: 'L1' | 'L2' | 'L3'
  reason: string
  createdAt: number
  timeoutMs: number
  resolved?: { decision: 'approved' | 'rejected'; at: number }
}

/** 观察者信号。 */
export interface ObserverSignal {
  id: string
  observer_id: string
  observed_node: string
  signal_level: 'green' | 'yellow' | 'red'
  summary: string
  criteria_matched: string[]
  timestamp: number
}

/** 节点活动行。 */
export interface ActivityLine {
  timestamp: number
  icon: string
  text: string
}

/** 运行历史行。 */
export interface RunHistoryEntry {
  graphId: string
  status: string
  startedAt: number
  artifactsRoot: string
}

/** 恢复点。 */
export interface CheckpointEntry {
  iteration: number
  node: string
  timestamp: number
}

/** SSE 业务事件。 */
export interface WsBizEvent {
  event_type: string
  node?: string
  timestamp: number
  data?: Record<string, unknown>
}
