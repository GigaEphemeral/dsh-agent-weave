/**
 * 错误分类（MVP-4 问题五修复 2）。
 *
 * 把引擎节点抛错分类为 PauseReason + 是否需人工介入，供 catch 块决定
 * "暂停 + 通知" vs "普通 node-error"。
 */
import type { PauseReason } from './types.js'

export interface ErrorClassification {
  reason: PauseReason
  needsUserIntervention: boolean
  details: {
    error?: string
    deniedOperation?: string
    requiredPermission?: string
    suggestedAction?: string
  }
}

/** 从错误消息提取被拒操作（write/read/execute ...）。 */
function extractOperation(msg: string): string | undefined {
  const m = msg.match(/(write|read|execute|mkdir|rm)\s+(\S+)/i)
  return m ? `${m[1]} ${m[2]}` : undefined
}

/** 分类错误。 */
export function classifyError(error: Error): ErrorClassification {
  const msg = error.message.toLowerCase()

  if (msg.includes('permission') || msg.includes('operation not permitted') || msg.includes('sandbox')) {
    const op = extractOperation(error.message)
    return {
      reason: 'permission-denied',
      needsUserIntervention: true,
      details: {
        error: error.message,
        ...(op !== undefined ? { deniedOperation: op } : {}),
        requiredPermission: 'workspace-write beyond session workspace',
        suggestedAction: '授权后重试，或跳过该节点',
      },
    }
  }

  if (msg.includes('not found') || msg.includes('not installed') || msg.includes('command not found')) {
    return {
      reason: 'dependency-missing',
      needsUserIntervention: true,
      details: {
        error: error.message,
        suggestedAction: '安装缺失依赖后恢复',
      },
    }
  }

  if (msg.includes('token') || msg.includes('budget') || msg.includes('exceeded')) {
    return {
      reason: 'budget-exceeded',
      needsUserIntervention: true,
      details: {
        error: error.message,
        suggestedAction: '追加预算后恢复',
      },
    }
  }

  if (msg.includes('timeout')) {
    return {
      reason: 'timeout',
      needsUserIntervention: true,
      details: {
        error: error.message,
        suggestedAction: '延长超时或终止',
      },
    }
  }

  // 质量门失败 / 子代理产出空：可重试，提示检查后恢复
  if (msg.includes('质量门未过') || msg.includes('产出为空') || msg.includes('子代理')) {
    return {
      reason: 'tool-error-fatal',
      needsUserIntervention: true,
      details: {
        error: error.message,
        suggestedAction: '检查子代理产出后恢复（weave_graph_resume）',
      },
    }
  }

  return {
    reason: 'tool-error-fatal',
    needsUserIntervention: true,
    details: {
      error: error.message,
      suggestedAction: '检查后恢复（weave_graph_resume）',
    },
  }
}
