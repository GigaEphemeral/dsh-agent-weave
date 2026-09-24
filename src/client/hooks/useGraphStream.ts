/**
 * 图数据流 hook（MVP-4 P4.C.3）。
 *
 * 按 graphId 拉取 /status + /spec，并订阅 SSE /stream 增量更新快照。
 */
import { useEffect, useState } from 'react'
import type { ClientGraphSpec, GraphSnapshot, WsBizEvent } from '../types'

export interface GraphStream {
  snap: GraphSnapshot | null
  spec: ClientGraphSpec | null
  roleMap: Record<string, string>
}

/** 根据 graphId 拉取状态+规格，订阅 SSE 实时流。 */
export function useGraphStream(graphId: string | null): GraphStream {
  const [snap, setSnap] = useState<GraphSnapshot | null>(null)
  const [spec, setSpec] = useState<ClientGraphSpec | null>(null)
  const [roleMap, setRoleMap] = useState<Record<string, string>>({})

  // 拉取 status + spec（graphId 切换时重置）
  useEffect(() => {
    if (!graphId) {
      setSnap(null)
      setSpec(null)
      setRoleMap({})
      return
    }
    fetch(`/api/weave/graph/${graphId}/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && setSnap(s))
      .catch(() => {})
    fetch(`/api/weave/graph/${graphId}/spec`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setSpec(d.spec as ClientGraphSpec)
          setRoleMap(d.roleMap as Record<string, string>)
        }
      })
      .catch(() => {})
  }, [graphId])

  // SSE 实时流
  useEffect(() => {
    if (!graphId) return
    const es = new EventSource(`/api/weave/graph/${graphId}/stream`)
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as WsBizEvent
        setSnap((prev) => applyEvent(prev, event))
      } catch {
        // 忽略解析失败
      }
    }
    // onerror 自动重连（EventSource 内置）
    return () => es.close()
  }, [graphId])

  return { snap, spec, roleMap }
}

/** 事件增量应用到快照。 */
export function applyEvent(prev: GraphSnapshot | null, event: WsBizEvent): GraphSnapshot | null {
  if (!prev) return prev
  const next: GraphSnapshot = { ...prev, nodeStates: { ...prev.nodeStates } }
  const data = event.data ?? {}
  switch (event.event_type) {
    case 'node-start':
      if (event.node) {
        next.current = event.node
        next.nodeStates[event.node] = 'running'
      }
      break
    case 'node-end':
      if (event.node) next.nodeStates[event.node] = 'completed'
      if (typeof data.tokenUsed === 'number') next.tokenUsed += data.tokenUsed as number
      break
    case 'node-error':
      if (event.node) next.nodeStates[event.node] = 'failed'
      break
    case 'loop-iteration':
      if (typeof data.iteration === 'number') next.iteration = data.iteration as number
      break
    case 'graph-end':
      next.status = data.status === 'paused' ? 'paused' : data.status === 'waiting' ? 'waiting' : 'completed'
      break
    case 'graph-paused':
      next.status = 'paused'
      if (typeof data.reason === 'string') next.pauseReason = data.reason
      break
    case 'node-idle-warning':
      if (event.node) {
        next.idleWarnings = { ...(next.idleWarnings ?? {}), [event.node]: (data.idleMs as number) ?? 0 }
        notifyIdle(event.node, (data.idleMs as number) ?? 0)
      }
      break
    case 'node-loop-detected':
      if (event.node) {
        next.loopAlerts = { ...(next.loopAlerts ?? {}), [event.node]: data }
      }
      break
  }
  return next
}

/** 空闲告警 → 浏览器 Notification（仅提示，不中止）。 */
function notifyIdle(node: string, idleMs: number): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  try {
    const idleMin = Math.round(idleMs / 60_000)
    new Notification(`节点 ${node} 已 ${idleMin} 分钟无活动`, { body: '可能卡死，可在看板点击暂停' })
  } catch {
    // 通知失败不影响主流程
  }
}
