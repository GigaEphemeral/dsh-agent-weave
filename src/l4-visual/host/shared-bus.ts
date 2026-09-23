/**
 * 全局共享事件总线（MVP-4 P4.0.1，修复 P0-2：bus 不共享）。
 *
 * 单图模式（P4.0.16）：同一时间只维护一个活跃 bus。
 * - setGlobalBus(graphId)：按 graphId 创建/复用总线（同一 graphId 返回同一实例）
 * - getGlobalBus()：当前活跃总线（供事件桥接）
 * - getGlobalSnapshot()：当前快照（供 REST /status）
 * - resetGlobalBus()：清空（新图运行前调用）
 */
import { createEventBus, type GraphEventBusInternal, type ExecutionSnapshot } from './event-bus.js'

let globalBus: GraphEventBusInternal | null = null
let globalGraphId: string | null = null

export function setGlobalBus(graphId: string): GraphEventBusInternal {
  if (globalGraphId === graphId && globalBus !== null) return globalBus
  globalBus = createEventBus({ graphId, maxIterations: 25 })
  globalGraphId = graphId
  return globalBus
}

export function getGlobalBus(): GraphEventBusInternal | null {
  return globalBus
}

export function getGlobalSnapshot(): ExecutionSnapshot | null {
  return globalBus?.getSnapshot() ?? null
}

export function resetGlobalBus(): void {
  globalBus = null
  globalGraphId = null
}
