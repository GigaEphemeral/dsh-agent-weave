/**
 * 事件流总线（MVP-2 T11）。
 *
 * 把引擎产生的 graph/* 事件统一收集，供终端视图和 HTML 报告消费。
 * - subscribe：订阅所有 graph/* 事件（返回注销函数）
 * - getSnapshot：获取当前执行状态快照
 * - reset：清空
 *
 * 由 src/index.ts 的 apply 中 ctx.on('graph/*') 桥接引擎事件到总线。
 */
import type { TrajectoryEvent } from '../../l2-engine/types.js'

/** 节点状态。 */
export type NodeState = 'idle' | 'running' | 'completed' | 'failed'

/** 执行状态快照。 */
export interface ExecutionSnapshot {
  graphId: string
  /** 当前节点。 */
  current: string
  /** 当前角色。 */
  currentRole: string
  iteration: number
  maxIterations: number
  retryCount: number
  maxRetry: number
  startedAt: number
  elapsedMs: number
  tokenUsed: number
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'waiting' | 'paused'
  trajectory: TrajectoryEvent[]
  nodeStates: Record<string, NodeState>
}

export interface GraphEventBus {
  /** 订阅所有 graph/* 事件（返回注销函数）。 */
  subscribe(handler: (event: TrajectoryEvent) => void): () => void
  /** 获取当前执行状态快照。 */
  getSnapshot(): ExecutionSnapshot
  /** 清空。 */
  reset(): void
}

/** 内部总线接口：额外暴露 handle（供插件 apply 桥接 ctx.on）。 */
export interface GraphEventBusInternal extends GraphEventBus {
  handle(event: TrajectoryEvent): void
}

/** 总线默认配置。 */
export interface EventBusOptions {
  graphId?: string
  maxIterations?: number
  maxRetry?: number
}

/** 创建事件总线（内存态；由插件 apply 生命周期管理）。返回内部接口（含 handle）。 */
export function createEventBus(options: EventBusOptions = {}): GraphEventBusInternal {
  let graphId = options.graphId ?? ''
  let current = ''
  let currentRole = ''
  let iteration = 0
  let retryCount = 0
  const maxIterations = options.maxIterations ?? 25
  const maxRetry = options.maxRetry ?? 3
  let startedAt = 0
  let status: ExecutionSnapshot['status'] = 'running'
  let tokenUsed = 0
  const trajectory: TrajectoryEvent[] = []
  const nodeStates: Record<string, NodeState> = {}
  const listeners = new Set<(event: TrajectoryEvent) => void>()

  function handle(event: TrajectoryEvent): void {
    trajectory.push(event)
    const data = event.data ?? {}

    switch (event.type) {
      case 'graph/start':
        graphId = event.graphId
        startedAt = event.timestamp
        status = 'running'
        break
      case 'graph/node-start':
        current = event.node ?? ''
        nodeStates[event.node ?? ''] = 'running'
        // L10 修复：从 node-start 的 data.role 提取当前角色
        if (typeof data.role === 'string') currentRole = data.role
        break
      case 'graph/node-end': {
        const node = event.node ?? ''
        nodeStates[node] = 'completed'
        const tokens = typeof data.tokenUsed === 'number' ? data.tokenUsed : 0
        tokenUsed += tokens
        if (typeof data.retryCount === 'number') retryCount = data.retryCount
        break
      }
      case 'graph/node-error':
        nodeStates[event.node ?? ''] = 'failed'
        status = 'failed'
        break
      case 'graph/loop-iteration':
        if (typeof data.iteration === 'number') iteration = Math.max(iteration, data.iteration)
        if (typeof data.retryCount === 'number') retryCount = data.retryCount
        break
      case 'graph/error':
        status = 'failed'
        break
      case 'graph/end':
        // P0-10：支持等待/暂停状态（data.status 显式声明；缺省 completed）
        if (data.status === 'paused') status = 'paused'
        else if (data.status === 'waiting') status = 'waiting'
        else status = 'completed'
        break
      default:
        break
    }

    for (const listener of listeners) {
      listener(event)
    }
  }

  return {
    subscribe(handler) {
      listeners.add(handler)
      return () => {
        listeners.delete(handler)
      }
    },
    getSnapshot(): ExecutionSnapshot {
      return {
        graphId,
        current,
        currentRole,
        iteration,
        maxIterations,
        retryCount,
        maxRetry,
        startedAt,
        elapsedMs: startedAt > 0 ? Date.now() - startedAt : 0,
        tokenUsed,
        status,
        trajectory: [...trajectory],
        nodeStates: { ...nodeStates },
      }
    },
    reset() {
      graphId = ''
      current = ''
      currentRole = ''
      iteration = 0
      retryCount = 0
      startedAt = 0
      status = 'running'
      tokenUsed = 0
      trajectory.length = 0
      for (const key of Object.keys(nodeStates)) delete nodeStates[key]
    },
    handle(event) {
      handle(event)
    },
  }
}
