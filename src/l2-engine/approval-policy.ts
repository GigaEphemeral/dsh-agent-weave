/**
 * 人工审批分级（MVP-3 P3.D.2）。
 *
 * 三级（R42）：
 * - L1 轻量：质量审核连续 2 次不通过 → 超时 10min 自动继续（异步通知）
 * - L2 标准：retry 达上限 / Token 超硬阈值 → 超时 30min 升级 L3
 * - L3 紧急：安全策略违规 / 死锁 → 无超时（阻塞到人工介入）
 *
 * R43：每级审批的超时行为写入 RunLedger（由调用方记录）。
 */
export type ApprovalLevel = 'L1' | 'L2' | 'L3'

export type ApprovalOutcome = 'allowed' | 'rejected' | 'timeout-auto-continue' | 'timeout-escalate'

export interface ApprovalRequestInput {
  level: ApprovalLevel
  reason: string
  nodeId: string
}

export interface ApprovalGateResult {
  outcome: ApprovalOutcome
  /** 超时行为说明（供 RunLedger）。 */
  audit: string
  /** 超时后升级到的等级（L2→L3）。 */
  escalatedTo?: ApprovalLevel
}

/** 各级超时（毫秒）。L3 无超时。 */
export const APPROVAL_TIMEOUTS: Record<Exclude<ApprovalLevel, 'L3'>, number> = {
  L1: 10 * 60 * 1000,
  L2: 30 * 60 * 1000,
}

export interface ApprovalPolicy {
  /** 决策审批结果（真实实现接 ctx.approval.request；测试注入 mock）。 */
  decide(req: ApprovalRequestInput): Promise<{ allowed: boolean }>
}

/** 创建审批策略执行器。 */
export function createApprovalPolicy(policy: ApprovalPolicy) {
  return {
    /**
     * 执行一次分级审批。
     * @param signal 超时控制（L1/L2 用；L3 忽略超时阻塞）。
     * @param onTimeout 超时回调（真实实现返回 abort；测试返回 timeout 标记）。
     */
    async gate(
      req: ApprovalRequestInput,
      opts: {
        signal?: AbortSignal
        /** 超时检测：返回 true 表示已超时（测试注入）。 */
        timeoutCheck?: () => boolean
      } = {},
    ): Promise<ApprovalGateResult> {
      const timeoutMs = APPROVAL_TIMEOUTS[req.level as Exclude<ApprovalLevel, 'L3'>]
      const start = Date.now()
      const isTimeout = opts.timeoutCheck
        ? opts.timeoutCheck
        : () => (timeoutMs !== undefined && Date.now() - start > timeoutMs) || opts.signal?.aborted === true

      const result = await policy.decide(req)
      if (result.allowed) {
        return { outcome: 'allowed', audit: `${req.level} 审批通过（${req.reason}）` }
      }
      // 未通过：检查超时行为
      if (req.level === 'L1' && isTimeout()) {
        return { outcome: 'timeout-auto-continue', audit: `L1 超时（10min）自动继续：${req.reason}` }
      }
      if (req.level === 'L2' && isTimeout()) {
        return {
          outcome: 'timeout-escalate', escalatedTo: 'L3',
          audit: `L2 超时（30min）升级 L3：${req.reason}`,
        }
      }
      // L3 无超时，或未超时 → 拒绝
      return { outcome: 'rejected', audit: `${req.level} 审批拒绝：${req.reason}` }
    },
  }
}
