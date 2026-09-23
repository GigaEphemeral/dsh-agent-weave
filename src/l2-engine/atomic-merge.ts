/**
 * 原子合并引擎（MVP-2 T6 + 审查修复 S12/M1）。
 *
 * 节点返回 `Partial<State>` 增量补丁，引擎统一原子合并（RES.10 §一.2 浅合并 +
 * LangGraph Reducer 思想）：
 * - 可合并字段（@mergeable）：messages 追加 / artifacts 深合并 / retry_count 累加
 * - 首次写入：直接赋值
 * - 值相同：无操作
 * - 值不同且不可合并：reject-on-conflict（不静默覆盖，返回 conflicts）
 *
 * 审查修复：
 * - S12：结果对象用 Object.create(null)（无原型），防 __proto__ 原型污染
 * - M1：artifacts 递归深合并（合并嵌套对象，符合"深合并"注释语义）
 */
export interface MergeResult<T> {
  success: boolean
  state?: T
  conflicts?: Array<{ field: string; prev: unknown; patch: unknown }>
}

/** 可合并字段（@mergeable）。 */
export const MERGEABLE_FIELDS = new Set(['messages', 'artifacts', 'retry_count'])

/** 危险键（S12 补强：显式跳过，防止原型污染/属性遮蔽）。 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 合并策略：输入 prev 与 patch，输出合并结果。 */
type MergeStrategy = (prev: unknown, patch: unknown) => unknown

/** 判断是否为纯对象（非数组/null）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 递归深合并两个纯对象（M1 修复：artifacts 嵌套对象也合并）。 */
function deepMergeObjects(prev: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev }
  for (const [key, patchValue] of Object.entries(patch)) {
    const prevValue = out[key]
    if (isPlainObject(prevValue) && isPlainObject(patchValue)) {
      out[key] = deepMergeObjects(prevValue, patchValue)
    } else {
      out[key] = patchValue
    }
  }
  return out
}

const STRATEGIES: Record<string, MergeStrategy> = {
  messages: (prev, patch) => [
    ...((prev as unknown[] | undefined) ?? []),
    ...((patch as unknown[] | undefined) ?? []),
  ],
  artifacts: (prev, patch) => {
    const prevObj = isPlainObject(prev) ? prev : {}
    const patchObj = isPlainObject(patch) ? patch : {}
    return deepMergeObjects(prevObj, patchObj)
  },
  retry_count: (prev, patch) => ((prev as number | undefined) ?? 0) + ((patch as number | undefined) ?? 0),
}

/**
 * 原子合并 prev 与 patch。
 *
 * @returns 成功时 { success: true, state }；冲突时 { success: false, conflicts }（不产生部分 state）。
 */
export function mergeState<T extends Record<string, unknown>>(prev: T, patch: Partial<T>): MergeResult<T> {
  const conflicts: MergeResult<T>['conflicts'] = []
  // S12：无原型对象 → patch 含 __proto__ 也不会污染原型
  const result: Record<string, unknown> = Object.assign(Object.create(null), prev)

  for (const [key, patchValue] of Object.entries(patch)) {
    // S12 补强：危险键直接跳过（不合并、不冲突）
    if (DANGEROUS_KEYS.has(key)) continue
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
  // S12：返回给调用方前转回普通对象（带 Object.prototype）
  return { success: true, state: { ...result } as T }
}
