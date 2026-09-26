/**
 * 角色库服务（MVP-5 Phase A：描述/排序/搜索）。
 *
 * 从 rolesDir 加载全部角色定义，支持：
 * - search：按 id/name/description/tags 模糊匹配
 * - sort：order（默认）/ name（按 name 排序）
 */
import { loadRoleDefinitions } from '../../l3-roles/role-loader.js'
import type { RoleDefinition } from '../../shared/types.js'

let rolesDir: string | null = null

/** 设置角色目录（由 index.ts 单一真相源传入；未设置时用默认当前目录 roles）。 */
export function setRolesDir(dir: string): void {
  rolesDir = dir
}

export function getRolesDir(): string {
  return rolesDir ?? process.cwd() + '/roles'
}

export interface RoleListQuery {
  search?: string | undefined
  sort?: 'order' | 'name' | undefined
}

export interface RoleLibraryEntry {
  id: string
  name: string
  description?: string | undefined
  order?: number | undefined
  tags: string[]
  suggests_next?: RoleDefinition['suggests_next'] | undefined
  tools: string[]
}

/** 将 RoleDefinition 转为角色库展示条目。 */
export function toRoleEntry(role: RoleDefinition): RoleLibraryEntry {
  return {
    id: role.id,
    name: role.name,
    ...(role.description !== undefined ? { description: role.description } : {}),
    ...(role.order !== undefined ? { order: role.order } : {}),
    tags: role.tags ?? [],
    ...(role.suggests_next !== undefined ? { suggests_next: role.suggests_next } : {}),
    tools: [...role.tools],
  }
}

/** 加载并搜索/排序角色库。 */
export function listRoles(query: RoleListQuery = {}): RoleLibraryEntry[] {
  const roles = loadRoleDefinitions(getRolesDir())
  const q = (query.search ?? '').trim().toLowerCase()
  const filtered = q
    ? roles.filter((r) =>
        r.id.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q) ||
        (r.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      )
    : roles

  const sort = query.sort ?? 'order'
  return filtered
    .sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, 'zh')
      const ao = a.order ?? Number.MAX_SAFE_INTEGER
      const bo = b.order ?? Number.MAX_SAFE_INTEGER
      return ao - bo || a.id.localeCompare(b.id)
    })
    .map(toRoleEntry)
}

/** 按 id 查单个角色（不存在返回 undefined）。 */
export function getRole(id: string): RoleLibraryEntry | undefined {
  const role = loadRoleDefinitions(getRolesDir()).find((r) => r.id === id)
  return role ? toRoleEntry(role) : undefined
}
