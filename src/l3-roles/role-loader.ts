/**
 * 角色 Provider 编译器（MVP-1 P1.1.6）。
 *
 * 将角色 YAML 编译为可注册到 ctx.subagents 的 SubagentProvider（D-001 决策修正版）。
 *
 * 编译流水线（文档 §3.2）：
 *   ① 解析 system_prompt_ref 路径（相对 skillsDir 或绝对路径）
 *   ② 读取 skill 文件（不存在/读取失败抛 RoleLoadError）
 *   ③ 映射字段：name ← id，persona ← skill 内容，toolFilter ← tools，
 *      agentOptions ← { provider, model }（完整对象，🐛 #4311/#4313），
 *      depthLimit ← max_concurrent_children，inheritsParentContext ← (memory_scope === 'shared')
 *   ④ 包装为 SubagentProvider：start() 注入角色字段后委托底层 delegate（spawn）
 *
 * 关键约束：
 * - 路径逃逸防护：解析后的路径必须位于 skillsDir 之内（编译期校验）
 * - 不缓存 skill 内容：每次编译重新读取（热重载后不使用过期内容）
 * - 同步编译：skill 读取为同步 IO（Cordis apply 是同步的）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { RoleLoadError, type RoleDefinition, type RoleProfile } from '../shared/types.js'
import { fingerprint } from '../shared/logger.js'
import { parseRoleYaml } from './role-schema.js'

/** 编译选项。 */
export interface CompileOptions {
  /** skill 文件所在目录（system_prompt_ref 相对路径的解析基准）。 */
  skillsDir: string
}

/**
 * 路径逃逸校验：解析后的绝对路径必须位于 skillsDir 内。
 * @returns 规范化后的绝对路径（校验通过时）。
 * @throws {RoleLoadError} 路径逃逸 skillsDir。
 */
export function assertInsideSkillsDir(skillsDir: string, target: string, roleId: string): string {
  const resolvedSkillsDir = resolve(skillsDir)
  const resolvedTarget = resolve(target)
  const rel = relative(resolvedSkillsDir, resolvedTarget)
  const isInside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  if (!isInside) {
    throw new RoleLoadError(
      `skill 路径不允许逃逸 skillsDir: ${target}（由 ${roleId}.system_prompt_ref 引用）`,
    )
  }
  return resolvedTarget
}

/** 解析 system_prompt_ref 到绝对路径（相对路径基于 skillsDir，绝对路径直接使用）。 */
export function resolveSystemPromptPath(skillsDir: string, ref: string): string {
  if (isAbsolute(ref)) return normalize(ref)
  return resolve(skillsDir, ref)
}

/**
 * 将角色 YAML 编译为 RoleProfile（纯数据形态）。
 *
 * @param role - 通过 Zod Schema 校验的角色定义
 * @param options - 编译选项（skillsDir 等）
 * @returns 角色画像（供日志、测试、请求组装使用）
 * @throws {RoleLoadError} skill 文件不存在、读取失败或路径逃逸
 */
export function compileRoleProfile(role: RoleDefinition, options: CompileOptions): RoleProfile {
  const target = resolveSystemPromptPath(options.skillsDir, role.system_prompt_ref)
  const safeTarget = assertInsideSkillsDir(options.skillsDir, target, role.id)

  if (!existsSync(safeTarget)) {
    throw new RoleLoadError(`skill 文件不存在: ${safeTarget}（由 ${role.id}.system_prompt_ref 引用）`)
  }

  let persona: string
  try {
    persona = readFileSync(safeTarget, 'utf8')
  } catch (error) {
    const errno = error instanceof Error && 'code' in error ? String(error.code) : String(error)
    throw new RoleLoadError(`skill 文件读取失败: ${safeTarget}: ${errno}`, { cause: error })
  }

  return {
    name: role.id,
    persona,
    toolFilter: [...role.tools],
    agentOptions: {
      provider: role.model.provider,
      model: role.model.model,
    },
    // 问题二：depthLimit/maxDepth 从 capability.max_depth 读（修正 max_concurrent_children 语义错位）
    depthLimit: role.capability.max_depth,
    capability: role.capability,
    inheritsParentContext: role.memory_scope === 'shared',
    metadata: {
      name: role.name,
      traits: [...role.traits],
      capabilities: [...role.capabilities],
      quality_gate: [...role.quality_gate],
      token_budget: role.token_budget,
      lifecycle: role.lifecycle,
      handoff: {
        upstream: [...role.handoff.upstream],
        downstream: [...role.handoff.downstream],
        edge_type: role.handoff.edge_type,
      },
      ...(role.environment !== undefined ? { environment: role.environment } : {}),
      ...(role.output !== undefined ? { output: role.output } : {}),
      ...(role.description !== undefined ? { description: role.description } : {}),
      ...(role.order !== undefined ? { order: role.order } : {}),
      ...(role.tags !== undefined ? { tags: [...role.tags] } : {}),
      ...(role.suggests_next !== undefined ? { suggests_next: role.suggests_next } : {}),
    },
  }
}

/**
 * 将角色 YAML 编译为可注册的 SubagentProvider。
 *
 * 官方契约（D-001）：SubagentProvider 是传输层抽象，capabilities 为布尔标志；
 * persona/toolFilter/agentOptions 属于 start 请求。因此角色以「包装 provider」
 * 形态存在：start() 在请求中注入角色字段后，委托给底层 delegate（spawn）。
 *
 * @param role - 通过 Zod Schema 校验的角色定义
 * @param options - 编译选项（skillsDir 等）
 * @param delegate - 底层传输 provider（通常为 `spawn`，从 ctx.subagents.getProvider('spawn') 获取）
 * @returns 可注册到 ctx.subagents 的 SubagentProvider
 * @throws {RoleLoadError} skill 文件不存在、读取失败或路径逃逸
 */
/** 问题三 C1：禁止 spawn 的工具名单（角色 allow_delegation=false 时从 toolFilter 剥离）。 */
const FORBIDDEN_TOOLS = new Set(['subagent', 'delegate', 'spawn', 'fork', 'create_child', 'list_subagent_models'])

/** 按 capability 剥离 spawn 类工具（allow_delegation=false 时）。 */
function sanitizeTools(tools: readonly string[], allowDelegation: boolean): string[] {
  if (allowDelegation) return [...tools]
  return tools.filter((t) => !FORBIDDEN_TOOLS.has(t.toLowerCase()))
}

export function compileRoleToProvider(
  role: RoleDefinition,
  options: CompileOptions,
  delegate: Pick<SubagentProvider, 'start' | 'prepareContinuable'>,
): SubagentProvider {
  const profile = compileRoleProfile(role, options)

  const capabilities = {
    agentOptions: true,
    outputSchema: false,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }

  return {
    name: profile.name,
    capabilities,
    inheritsParentContext: profile.inheritsParentContext,
    agentRouteDefaults: profile.agentOptions,
    async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
      // 注入角色字段到请求（角色字段优先于调用方默认）
      const injected: ResolvedSubagentStartRequest = {
        ...request,
        persona: profile.persona,
        // ★ 问题三 C1：剥离 spawn 类工具（allow_delegation=false 时）
        toolFilter: { allow: sanitizeTools(profile.toolFilter, profile.capability.allow_delegation) },
        agentOptions: {
          provider: profile.agentOptions.provider,
          model: profile.agentOptions.model,
        },
        // ★ 问题三 C1：maxDepth 从 capability 读（已由 compileRoleProfile.depthLimit 提供）
        ...(profile.depthLimit !== undefined ? { maxDepth: profile.depthLimit } : {}),
      }
      return delegate.start(injected)
    },
    // 问题三最小版：continuable 子代理（persona/toolFilter/maxDepth 走 request，
    // manager 自己 compose；此处委托底层 delegate 的 prepareContinuable）
    async prepareContinuable(request) {
      if (delegate.prepareContinuable !== undefined) {
        return delegate.prepareContinuable(request)
      }
      return Promise.resolve({})
    },
  }
}

/**
 * 扫描 rolesDir 下的全部 YAML 文件。
 * @param rolesDir - 角色定义目录
 * @returns 排序后的 .yaml/.yml 文件绝对路径列表
 * @throws {RoleLoadError} 角色目录不可读
 */
export function scanRoleFiles(rolesDir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(rolesDir)
  } catch (error) {
    throw new RoleLoadError(
      `角色目录读取失败: ${rolesDir}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  return entries
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort()
    .map((name) => join(rolesDir, name))
}

/**
 * 加载角色目录中的全部角色定义。
 * @param rolesDir - 角色定义目录
 * @returns 角色定义列表（按文件名字母序）
 */
export function loadRoleDefinitions(rolesDir: string): RoleDefinition[] {
  const files = scanRoleFiles(rolesDir)
  const roles: RoleDefinition[] = []
  for (const file of files) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      throw new RoleLoadError(
        `角色文件读取失败: ${file}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    const role = parseRoleYaml(raw, file)
    roles.push(role)
  }
  return roles
}

/** 编译目录内全部角色为 SubagentProvider（供插件 apply 批量注册使用）。 */
export function compileRoleDirectory(
  rolesDir: string,
  options: CompileOptions,
  delegate: Pick<SubagentProvider, 'start'>,
): SubagentProvider[] {
  const roles = loadRoleDefinitions(rolesDir)
  return roles.map((role) => compileRoleToProvider(role, options, delegate))
}

/** 编译目录内全部角色为 RoleProfile（纯数据，供日志/验证）。 */
export function compileRoleProfileDirectory(
  rolesDir: string,
  options: CompileOptions,
): RoleProfile[] {
  const roles = loadRoleDefinitions(rolesDir)
  return roles.map((role) => compileRoleProfile(role, options))
}

/**
 * 角色加载成功日志数据（脱敏：不记录 persona 全文，只记录长度与指纹）。
 */
export function describeRoleProfile(profile: RoleProfile): Record<string, unknown> {
  return {
    role_id: profile.name,
    persona_len: profile.persona.length,
    persona_fp: fingerprint(profile.persona),
    tool_count: profile.toolFilter.length,
    provider: profile.agentOptions.provider,
    model: profile.agentOptions.model,
    memory_scope: profile.inheritsParentContext ? 'shared' : 'private',
  }
}
