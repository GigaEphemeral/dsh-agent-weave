import { isAbsolute, join, normalize } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { compileRoleDirectory } from './l3-roles/role-loader.js'
import { logger } from './shared/logger.js'

/**
 * dsh-agent-weave 插件入口（Host 半端）。
 *
 * MVP-1：加载角色 YAML → 编译为 SubagentProvider → 注册到 ctx.subagents。
 * 每个角色包装 spawn provider，start() 注入 persona/toolFilter/agentOptions。
 */
export const name = 'dsh-agent-weave'

/** 声明依赖的服务：subagents（子代理注册表）+ skills（技能服务，探测可选）。 */
export const inject = ['subagents', 'skills']

export interface Config {
  /** 角色定义文件所在目录，默认 ./roles（相对插件包根） */
  rolesDir?: string
  /** 技能文件所在目录，默认 ./skills（相对插件包根） */
  skillsDir?: string
  /** 底层传输 provider 名（默认 spawn，从 ctx.subagents 查找） */
  baseProvider?: string
}

/** 解析默认目录：相对插件包根解析，支持绝对路径。 */
function resolveDir(configPath: string | undefined, fallback: string, cwd: string): string {
  if (configPath !== undefined) return configPath
  return normalize(isAbsolute(fallback) ? fallback : join(cwd, fallback))
}

export function apply(ctx: Context, config: Config = {}): void {
  // 解析配置
  const cwd = process.cwd()
  const rolesDir = resolveDir(config.rolesDir, 'roles', cwd)
  const skillsDir = resolveDir(config.skillsDir, 'skills', cwd)

  // 查找底层 delegate provider（spawn）
  const delegate = ctx.subagents.getProvider(config.baseProvider ?? 'spawn')
  if (delegate === undefined) {
    logger.error('weave', '找不到底层 subagent provider，跳过角色注册', new Error('spawn provider 未注册'), {
      base_provider: config.baseProvider ?? 'spawn',
    })
    return
  }

  // 编译并注册全部角色（注册即 effect：插件卸载时自动撤销）
  const providers = compileRoleDirectory(rolesDir, { skillsDir }, delegate)
  for (const provider of providers) {
    ctx.subagents.registerProvider(provider)
    logger.info('role-loader', `注册角色 ${provider.name}`, {
      role_id: provider.name,
      inherits_parent_context: provider.inheritsParentContext,
      agent_route_defaults: provider.agentRouteDefaults,
    })
  }

  // 记录编译摘要
  logger.info('weave', '角色注册完成', {
    count: providers.length,
    roles: providers.map((p) => ({ role_id: p.name, inherits_parent_context: p.inheritsParentContext })),
  })
}
