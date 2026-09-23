/**
 * SSE 广播器（MVP-4 P4.A.3）。
 *
 * 按 graphId 分发的 SSE 订阅管理：subscribe/unsubscribe/broadcast。
 * handler 持有 response 流式写；断线由 req 'close' 注销。
 */
import type { ServerResponse } from 'node:http'
import type { WsEvent } from '../shared/event-schema.js'

interface Subscriber {
  id: string
  graphId: string
  res: ServerResponse
  lastSeq: number
}

export interface SseBroker {
  /** 订阅一个 graphId 的事件流；返回订阅 id。 */
  subscribe(graphId: string, res: ServerResponse, lastEventId?: string): string
  /** 注销订阅（结束响应）。 */
  unsubscribe(id: string): void
  /** 向指定 graphId 的所有订阅广播事件。 */
  broadcast(graphId: string, event: WsEvent & { seq?: number }): void
  /** 订阅数（可按 graphId 过滤）。 */
  subscriberCount(graphId?: string): number
  /** 释放全部订阅。 */
  dispose(): void
}

export function createSseBroker(): SseBroker {
  const subs = new Map<string, Subscriber>()

  return {
    subscribe(graphId, res, lastEventId) {
      const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(`: connected ${id}\n\n`)
      subs.set(id, { id, graphId, res, lastSeq: lastEventId ? Number.parseInt(lastEventId, 10) : 0 })
      return id
    },
    unsubscribe(id) {
      const sub = subs.get(id)
      if (sub) {
        sub.res.end()
        subs.delete(id)
      }
    },
    broadcast(graphId, event) {
      const line = `data: ${JSON.stringify(event)}\n\n`
      for (const [id, sub] of subs) {
        if (sub.graphId !== graphId) continue
        try {
          sub.res.write(line)
          if (event.seq !== undefined) sub.lastSeq = event.seq
        } catch {
          subs.delete(id)
        }
      }
    },
    subscriberCount(graphId) {
      if (!graphId) return subs.size
      return [...subs.values()].filter((s) => s.graphId === graphId).length
    },
    dispose() {
      for (const sub of subs.values()) sub.res.end()
      subs.clear()
    },
  }
}
