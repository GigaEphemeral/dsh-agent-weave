/**
 * 持久化（ui修复2 §P5）：localStorage 读写（角色 + 图）。
 *
 * 刷新页面后恢复：当前图草稿 / 运行历史缓存。
 */
const ROLES_KEY = 'weave:roles-cache'
const GRAPH_KEY = 'weave:graph-draft'

export interface PersistedGraph {
  id: string
  spec: unknown
  savedAt: number
  name?: string
}

/** 保存图草稿（localStorage；容量保护 1MB 内）。 */
export function saveGraphDraft(id: string, spec: unknown, name?: string): void {
  try {
    const drafts = listGraphDrafts()
    const next = drafts.filter((d) => d.id !== id)
    next.unshift({ id, spec, ...(name !== undefined ? { name } : {}), savedAt: Date.now() })
    localStorage.setItem(GRAPH_KEY, JSON.stringify(next.slice(0, 20)))
  } catch {
    // localStorage 不可用/超限 → 静默忽略
  }
}

/** 读取图草稿列表（最新在前）。 */
export function listGraphDrafts(): PersistedGraph[] {
  try {
    const raw = localStorage.getItem(GRAPH_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as PersistedGraph[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 按 id 读图草稿。 */
export function getGraphDraft(id: string): PersistedGraph | undefined {
  return listGraphDrafts().find((d) => d.id === id)
}

/** 删除图草稿。 */
export function removeGraphDraft(id: string): void {
  try {
    const next = listGraphDrafts().filter((d) => d.id !== id)
    localStorage.setItem(GRAPH_KEY, JSON.stringify(next))
  } catch {
    // 静默忽略
  }
}

/** 角色缓存（角色编辑器/角色库快速加载）。 */
export function saveRolesCache(roles: unknown): void {
  try {
    localStorage.setItem(ROLES_KEY, JSON.stringify({ roles, savedAt: Date.now() }))
  } catch {
    // 静默忽略
  }
}

export function loadRolesCache(): { roles: unknown; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(ROLES_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { roles: unknown; savedAt: number }
    return parsed
  } catch {
    return null
  }
}
