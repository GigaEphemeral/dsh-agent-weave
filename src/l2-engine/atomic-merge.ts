/**
 * 原子合并引擎（MVP-2 T6）。
 *
 * 节点返回 `Partial<State>` 增量补丁，引擎统一原子合并（RES.10 §一.2 浅合并 +
 * LangGraph Reducer 思想）：
 * - 可合并字段（@mergeable）：messages 追加 / artifacts 深合并 / retry_count 累加
 * - 首次写入：直接赋值
 * - 值相同：无操作
 * - 值不同且不可合并：reject-on-conflict（不静默覆盖，返回 conflicts）
 */
export interface MergeResult<T> {
  success: boolean
  state?: T
  conflicts?: Array<{ field: string; prev: unknown; patch: unknown }>
}

/** 可合并字段（@mergeable）。 */
export const MERGEABLE_FIELDS = new Set(['messages', 'artifacts', 'retry_count'])

/** 合并策略：输入 prev 与 patch，输出合并结果。 */
type MergeStrategy = (prev: unknown, patch: unknown) => unknown

const STRATEGIES: Record<string, MergeStrategy> = {
  messages: (prev, patch) => [
    ...((prev as unknown[] | undefined) ?? []),
    ...((patch as unknown[] | undefined) ?? []),
  ],
  artifacts: (prev, patch) => ({
    ...((prev as object | undefined) ?? {}),
    ...((patch as object | undefined) ?? {}),
  }),
  retry_count: (prev, patch) => ((prev as number | undefined) ?? 0) + ((patch as number | undefined) ?? 0),
}

/**
 * 原子合并 prev 与 patch。
 *
 * @returns 成功时 { success: true, state }；冲突时 { success: false, conflicts }（不产生部分 state）。
 */
export function mergeState<T extends Record<string, unknown>>(prev: T, patch: Partial<T>): MergeResult<T> {
  const conflicts: MergeResult<T>['conflicts'] = []
  const result: Record<string, unknown> = { ...prev }

  for (const [key, patchValue] of Object.entries(patch)) {
    const prevValue = (prev as Record<string, unknown>)[key]

    if (MERGEABLE_FIELDS.has(key)) {
      const strategy = STRATEGIES[key]
      if (strategy !== undefined) {
        result[key] = strategy(prevValue, patchValue)
      }
    } else if (prevValue === undefined) {
      // 首次写入：直接赋值
      result[key] = patchValue
    } else if (prevValue !== patchValue) {
      // 冲突：reject-on-conflict
      conflicts.push({ field: key, prev: prevValue, patch: patchValue })
    }
    // 值相同时：无操作（不写 result，保持原值）
  }

  if (conflicts.length > 0) {
    return { success: false, conflicts }
  }
  return { success: true, state: result as T }
}
