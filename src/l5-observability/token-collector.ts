/**
 * Token 分账（MVP-3 P3.C.4）。
 *
 * 按节点/角色汇总 Token 消耗。数据源：
 * - 引擎 node-end 事件携带的 reportTokenUsage（S13 通道）
 * - 子代理 session 的 assistant/message.data.usage（RES.1 确认字段）
 *
 * 本模块提供：事件侧汇总（引擎通道）+ 会话 usage 解析（session 通道）。
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  totalTokens: number
}

export interface TokenRow {
  node: string
  role: string
  usage: TokenUsage
}

export interface TokenCollector {
  /** 记录一次节点 Token 消耗（引擎 node-end 事件调用）。 */
  record(node: string, role: string, usage: Partial<TokenUsage>): void
  /** 按节点查询。 */
  byNode(node: string): TokenRow | undefined
  /** 按角色汇总。 */
  byRole(role: string): TokenUsage
  /** 全部行。 */
  rows(): TokenRow[]
  /** 总计。 */
  total(): TokenUsage
  /** 合并另一个 collector（如恢复场景）。 */
  merge(other: TokenCollector): void
}

/** 创建 Token 分账收集器。 */
export function createTokenCollector(): TokenCollector {
  const map = new Map<string, TokenRow>()

  const norm = (u: Partial<TokenUsage>): TokenUsage => ({
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    totalTokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0),
  })

  return {
    record(node, role, usage) {
      const u = norm(usage)
      const existing = map.get(node)
      if (existing) {
        existing.usage.inputTokens += u.inputTokens
        existing.usage.outputTokens += u.outputTokens
        existing.usage.cacheReadTokens += u.cacheReadTokens
        existing.usage.totalTokens += u.totalTokens
      } else {
        map.set(node, { node, role, usage: u })
      }
    },
    byNode(node) {
      return map.get(node)
    },
    byRole(role) {
      const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }
      for (const row of map.values()) {
        if (row.role === role) {
          total.inputTokens += row.usage.inputTokens
          total.outputTokens += row.usage.outputTokens
          total.cacheReadTokens += row.usage.cacheReadTokens
          total.totalTokens += row.usage.totalTokens
        }
      }
      return total
    },
    rows: () => [...map.values()],
    total() {
      const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }
      for (const row of map.values()) {
        total.inputTokens += row.usage.inputTokens
        total.outputTokens += row.usage.outputTokens
        total.cacheReadTokens += row.usage.cacheReadTokens
        total.totalTokens += row.usage.totalTokens
      }
      return total
    },
    merge(other) {
      for (const row of other.rows()) {
        this.record(row.node, row.role, row.usage)
      }
    },
  }
}

/**
 * 解析 session 一行 JSON 的 usage（RES.1 确认：assistant/message.data.usage）。
 * 兼容多种嵌套。返回 null 表示无 usage。
 */
export function parseUsageFromSessionLine(line: string): TokenUsage | null {
  let j: unknown
  try {
    j = JSON.parse(line)
  } catch {
    return null
  }
  const evt = j as { type?: string; data?: { usage?: Partial<TokenUsage>; message?: { usage?: Partial<TokenUsage> } } }
  if (evt.type !== 'assistant/message') return null
  const u = evt.data?.usage ?? evt.data?.message?.usage
  if (!u || typeof u.totalTokens !== 'number') return null
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    totalTokens: u.totalTokens,
  }
}
