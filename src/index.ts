import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { compileRoleDirectory } from './l3-roles/role-loader.js'
import { registerChainTool } from './l2-engine/chain-tool.js'
import { registerGraphCommands } from './cli/graph-commands.js'
import { logger } from './shared/logger.js'

/**
 * dsh-agent-weave 插件入口（Host 半端）。
 *
 * MVP-1：加载角色 YAML → 编译为 SubagentProvider → 注册到 ctx.subagents；
 * 注册 weave_run_chain 验证工具（执行 R1→R8 单链）。
 */
export const name = 'dsh-agent-weave'

/** 声明依赖的服务：subagents（子代理注册表）+ tools（工具注册）+ skills（探测可选）。 */
export const inject = ['subagents', 'tools', 'skills']

export interface Config {
  /** 角色定义文件所在目录（默认：插件包内 roles/，绝对路径优先） */
  rolesDir?: string
  /** 技能文件所在目录（默认：插件包内 skills/，绝对路径优先） */
  skillsDir?: string
  /** 底层传输 provider 名（默认 spawn，从 ctx.subagents 查找） */
  baseProvider?: string
}

/** 插件包根目录（基于编译产物 lib/index.js 定位，避免依赖 process.cwd()）。 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 解析目录：绝对路径直接用；相对路径基于插件包根。 */
function resolveDir(configPath: string | undefined, fallback: string): string {
  if (configPath !== undefined) return normalize(isAbsolute(configPath) ? configPath : join(PACKAGE_ROOT, configPath))
  return join(PACKAGE_ROOT, fallback)
}

export function apply(ctx: Context, config: Config = {}): void {
  const rolesDir = resolveDir(config.rolesDir, 'roles')
  const skillsDir = resolveDir(config.skillsDir, 'skills')

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

  // 注册单链验证工具（MVP-1 验证用；MVP-2 由 StateGraph 取代）
  registerChainTool(ctx)

  // 注册 CLI 图命令（MVP-2 T4：validate / show / help）
  registerGraphCommands(ctx)

  // 记录编译摘要
  logger.info('weave', '角色注册完成', {
    count: providers.length,
    roles: providers.map((p) => ({ role_id: p.name, inherits_parent_context: p.inheritsParentContext })),
    roles_dir: rolesDir,
  })
}
