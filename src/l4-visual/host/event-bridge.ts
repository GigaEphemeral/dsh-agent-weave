/**
 * 事件桥接（MVP-4 P4.B.2 + P4.B.12）。
 *
 * 全局共享 bus 的 graph/* 事件 → SSE 广播（转 WsEvent，带 roleMap）。
 * 启动时 bus 可能尚未创建（图未运行）→ 500ms 轮询等待；插件卸载时清理。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SseBroker } from './sse-broker.js'
import { trajectoryToWsEvent } from '../shared/event-schema.js'
import { getGlobalBus } from './shared-bus.js'
import { getGraph } from './spec-registry.js'

/** 启动事件桥接；返回注销函数。 */
export function startEventBridge(ctx: Context, broker: SseBroker): () => void {
  let unsub: (() => void) | null = null

  const connect = (): boolean => {
    const bus = getGlobalBus()
    if (!bus) return false
    unsub = bus.subscribe((evt) => {
      const entry = getGraph(evt.graphId)
      const roleMap = entry?.roleMap ?? {}
      broker.broadcast(evt.graphId, trajectoryToWsEvent(evt, roleMap))
    })
    return true
  }

  if (!connect()) {
    const timer = setInterval(() => {
      if (connect()) clearInterval(timer)
    }, 500)
    ctx.effect(() => () => clearInterval(timer))
  }

  return () => {
    unsub?.()
  }
}
