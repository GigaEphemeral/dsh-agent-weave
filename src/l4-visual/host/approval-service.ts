/**
 * 审批闭环服务（MVP-4 P4.B.3）。
 *
 * 内存态审批请求：create 广播 approval-request → 等待 → resolve 广播 approval-decided
 * 并唤醒等待方；超时自动 rejected。SSE broker 推送状态变更。
 */
import type { SseBroker } from './sse-broker.js'

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

export type ApprovalDecision = 'approved' | 'rejected' | 'timeout'

export interface ApprovalService {
  /** 创建审批请求（广播 approval-request；带超时自动拒绝）。 */
  create(input: Omit<ApprovalRequest, 'id' | 'createdAt'>): ApprovalRequest
  /** 列出请求（可按 graphId 过滤）。 */
  list(graphId?: string): ApprovalRequest[]
  /** 待决请求。 */
  pending(graphId?: string): ApprovalRequest[]
  /** 决议（approved/rejected）；已决议返回 false。 */
  resolve(id: string, decision: 'approved' | 'rejected'): boolean
  /** 等待某请求决议（信号中止 → timeout）。 */
  waitFor(id: string, signal?: AbortSignal): Promise<ApprovalDecision>
}

export function createApprovalService(broker: SseBroker): ApprovalService {
  const requests = new Map<string, ApprovalRequest>()
  const resolvers = new Map<string, Array<(d: ApprovalDecision) => void>>()

  return {
    create(input) {
      const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const req: ApprovalRequest = { ...input, id, createdAt: Date.now() }
      requests.set(id, req)
      broker.broadcast(input.graphId, {
        trace_id: input.graphId,
        event_type: 'approval-request',
        node: input.nodeId,
        timestamp: Date.now(),
        data: { approvalId: id, level: input.level, reason: input.reason, timeoutMs: input.timeoutMs },
      })
      if (Number.isFinite(input.timeoutMs)) {
        setTimeout(() => {
          if (!req.resolved) {
            req.resolved = { decision: 'rejected', at: Date.now() }
            const list = resolvers.get(id) ?? []
            for (const r of list) r('timeout')
            resolvers.delete(id)
          }
        }, input.timeoutMs)
      }
      return req
    },
    list(graphId) {
      return graphId ? [...requests.values()].filter((r) => r.graphId === graphId) : [...requests.values()]
    },
    pending(graphId) {
      return [...requests.values()].filter((r) => r.graphId === graphId && !r.resolved)
    },
    resolve(id, decision) {
      const req = requests.get(id)
      if (!req || req.resolved) return false
      req.resolved = { decision, at: Date.now() }
      broker.broadcast(req.graphId, {
        trace_id: req.graphId,
        event_type: 'approval-decided',
        node: req.nodeId,
        timestamp: Date.now(),
        data: { approvalId: id, decision },
      })
      const list = resolvers.get(id) ?? []
      for (const r of list) r(decision)
      resolvers.delete(id)
      return true
    },
    waitFor(id, signal) {
      return new Promise<ApprovalDecision>((resolve) => {
        const req = requests.get(id)
        if (req?.resolved) { resolve(req.resolved.decision); return }
        const list = resolvers.get(id) ?? []
        list.push(resolve)
        resolvers.set(id, list)
        signal?.addEventListener('abort', () => resolve('timeout'), { once: true })
      })
    },
  }
}
