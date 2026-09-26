/**
 * 节点活动气泡数据源（MVP-5 Phase D #20 头顶气泡）。
 *
 * 订阅全局 SSE，过滤 graphId 的 node-activity 事件，保留每个节点最近一条活动文本。
 */
import { useEffect, useState } from 'react'

export interface ActivityItem {
  text: string
  icon?: string | undefined
  at: number
}

export function useActivityFeed(graphId: string | null): Map<string, ActivityItem> {
  const [activity, setActivity] = useState<Map<string, ActivityItem>>(new Map())

  useEffect(() => {
    if (!graphId) {
      setActivity(new Map())
      return
    }
    const es = new EventSource('/api/weave/stream')
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse((msg as MessageEvent<string>).data) as {
          event_type?: string
          trace_id?: string
          node?: string
          data?: { text?: string; icon?: string }
        }
        if (evt.event_type === 'node-activity' && evt.trace_id === graphId && evt.node && evt.data?.text) {
          setActivity((prev) => {
            const next = new Map(prev)
            next.set(evt.node ?? '', { text: evt.data?.text ?? '', icon: evt.data?.icon, at: Date.now() })
            return next
          })
        }
      } catch { /* 忽略坏帧 */ }
    }
    return () => es.close()
  }, [graphId])

  return activity
}
