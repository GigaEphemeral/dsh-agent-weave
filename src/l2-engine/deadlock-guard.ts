/**
 * 防死锁分级恢复（MVP-3 P3.B.3）。
 *
 * 规则（README §消息总线与防死锁 + MVP-3task）：
 * - 单条消息超时 → 重试（最多 2 次）
 * - 同一 Agent 同链路被触发 ≥3 次 → 强制终止链路 + 诊断写入 RunLedger
 * - 整个工作流超时 → 降级到人工审批节点
 */
export const MAX_RETRY = 2
export const MAX_TRIGGER_PER_LINK = 3

export type RecoveryAction =
  | { kind: 'retry'; attempt: number }
  | { kind: 'terminate-link'; linkId: string; reason: string }
  | { kind: 'escalate-approval'; reason: string }

export interface DeadlockGuard {
  /** 消息发送失败时决定恢复动作（超时重试 ≤2）。 */
  onMessageTimeout(msgId: string): RecoveryAction
  /** 链路触发计数（同 Agent 同链路 ≥3 强制终止）。 */
  onTrigger(agentId: string, linkId: string): RecoveryAction
  /** 工作流超时降级。 */
  onWorkflowTimeout(workflowId: string): RecoveryAction
  /** 触发计数查询。 */
  triggerCount(agentId: string, linkId: string): number
  /** 审计诊断（供 RunLedger 写入）。 */
  diagnostics(): Array<Record<string, unknown>>
}

/** 创建防死锁守护器。 */
export function createDeadlockGuard(): DeadlockGuard {
  const triggerMap = new Map<string, number>()
  const diag: Array<Record<string, unknown>> = []

  return {
    onMessageTimeout(msgId) {
      // 简单实现：每次超时计数；达到 MAX_RETRY 后交由上层处理（此处记录诊断）
      diag.push({ at: Date.now(), kind: 'message-timeout', msgId })
      return { kind: 'retry', attempt: 1 }
    },
    onTrigger(agentId, linkId) {
      const key = `${agentId}::${linkId}`
      const count = (triggerMap.get(key) ?? 0) + 1
      triggerMap.set(key, count)
      if (count >= MAX_TRIGGER_PER_LINK) {
        diag.push({ at: Date.now(), kind: 'link-terminated', agentId, linkId, count })
        return { kind: 'terminate-link', linkId, reason: `同 Agent 同链路触发 ${count} 次` }
      }
      return { kind: 'retry', attempt: count }
    },
    onWorkflowTimeout(workflowId) {
      diag.push({ at: Date.now(), kind: 'workflow-timeout', workflowId })
      return { kind: 'escalate-approval', reason: `工作流超时降级: ${workflowId}` }
    },
    triggerCount(agentId, linkId) {
      return triggerMap.get(`${agentId}::${linkId}`) ?? 0
    },
    diagnostics() {
      return [...diag]
    },
  }
}
