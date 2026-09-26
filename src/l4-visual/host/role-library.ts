/**
 * 角色库服务（MVP-5 Phase A：描述/排序/搜索；MVP-5B B6：新建/编辑落盘）。
 *
 * 从 rolesDir 加载全部角色定义，支持：
 * - search：按 id/name/description/tags 模糊匹配
 * - sort：order（默认）/ name（按 name 排序）
 * - saveRoleDefinition：角色编辑器表单 → 合法 RoleDefinition YAML 落盘（§5.3）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dump as yamlDump } from 'js-yaml'
import { loadRoleDefinitions } from '../../l3-roles/role-loader.js'
import { RoleDefinitionSchema, RoleSchemaError, type RoleDefinition } from '../../shared/types.js'

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

// ─── MVP-5B B6：角色编辑器落盘（§5.3） ────────────────────────

/** 角色编辑器表单（客户端提交的最小字段集）。 */
export interface RoleFormInput {
  id: string
  name: string
  description?: string
  order?: number
  tags?: string[]
  provider?: string
  model?: string
  capabilities?: string[]
  tools?: string[]
  readable?: string[]
  inputRequires?: string[]
  onlyMarkdown?: boolean
  forbidExtensions?: string[]
  requiredSections?: string[]
  forbidden?: string[]
}

export interface SaveRoleResult {
  ok: boolean
  id?: string
  path?: string
  error?: string
}

/** 从编辑器表单构造合法 RoleDefinition（缺省字段给默认值）。 */
function buildRoleDefinition(form: RoleFormInput): RoleDefinition {
  const id = form.id.trim()
  if (!id) throw new RoleSchemaError('角色 ID 不能为空', [{ path: 'id', message: 'required' }])
  return {
    schema_version: '1.0',
    id,
    name: form.name.trim() || id,
    ...(form.description !== undefined && form.description.trim() ? { description: form.description.trim() } : {}),
    ...(form.order !== undefined ? { order: form.order } : {}),
    tags: form.tags ?? [],
    system_prompt_ref: `${id}/SKILL.md`,
    traits: [],
    capabilities: form.capabilities ?? [],
    tools: form.tools ?? [],
    model: {
      provider: form.provider ?? 'spawn',
      model: form.model ?? 'default',
    },
    memory_scope: 'private',
    lifecycle: 'on-demand',
    max_concurrent_children: 1,
    capability: { allow_delegation: false, max_depth: 1, allowed_children: [], allow_shell: true, allow_write: true },
    quality_gate: [],
    token_budget: 2000,
    handoff: { upstream: [], downstream: [], edge_type: 'seq' },
    ...(form.onlyMarkdown === true || (form.forbidExtensions ?? []).length > 0
      ? {
          output: {
            ...(form.onlyMarkdown === true ? { only_markdown: true } : {}),
            ...((form.forbidExtensions ?? []).length > 0 ? { forbidden_extensions: form.forbidExtensions } : {}),
          },
        }
      : {}),
  }
}

/**
 * 保存角色定义到 rolesDir（新建/编辑共用）。
 * 返回 { ok, id, path }；校验失败返回 ok:false + error。
 */
export function saveRoleDefinition(form: RoleFormInput): SaveRoleResult {
  const dir = getRolesDir()
  try {
    const role = buildRoleDefinition(form)
    const parsed = RoleDefinitionSchema.safeParse(role)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      return { ok: false, error: `角色定义校验失败: ${issues}` }
    }
    const yaml = `# ${role.name}（由角色编辑器创建）\n` + yamlDump(role, { noRefs: true, lineWidth: 120 })
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${role.id}.yaml`)
    writeFileSync(file, yaml, 'utf8')
    return { ok: true, id: role.id, path: `roles/${role.id}.yaml` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
