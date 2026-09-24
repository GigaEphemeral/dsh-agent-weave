import { isAbsolute, join, normalize, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'
import { compileRoleDirectory } from './l3-roles/role-loader.js'
import { registerChainTool } from './l2-engine/chain-tool.js'
import { registerGraphCommands } from './cli/graph-commands.js'
import { registerVisualCommands } from './cli/graph-visual-commands.js'
import { registerGraphRunCommand } from './cli/graph-run-commands.js'
import { registerGraphResumeCommand } from './cli/graph-resume-commands.js'
import { GraphEngineService } from './l2-engine/graph-service.js'
import { registerVisualRuntime } from './l4-visual/host/visual-runtime.js'
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

/** 基于 import.meta.url 计算的"疑似"包根（可能被 DSH loader 影响）。 */
const SUSPECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * ★ 兼容性探测：DSH cordis loader 加载 bundle 形态时 import.meta.url 可能不可靠，
 * 导致 PACKAGE_ROOT 被算成 lib/。这里按优先级探测真实目录：
 *   1. SUSPECT_ROOT/roles         （正常情况）
 *   2. SUSPECT_ROOT/../roles      （import.meta.url 多了一层子目录时）
 *   3. SUSPECT_ROOT/../../roles   （更深的偏移，兜底）
 */
function locateDir(name: string): string {
  const primary = join(SUSPECT_ROOT, name) // ★ 主候选（兜底返回值）
  const candidates = [
    primary,
    join(SUSPECT_ROOT, '..', name),
    join(SUSPECT_ROOT, '..', '..', name),
  ]
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  return primary // ★ 不索引数组
}

/** 解析目录：绝对路径直接用；相对路径基于探测到的包根。 */
function resolveDir(configPath: string | undefined, fallback: string): string {
  if (configPath !== undefined) {
    return normalize(isAbsolute(configPath) ? configPath : join(SUSPECT_ROOT, configPath))
  }
  return locateDir(fallback)
}

export function apply(ctx: Context, config: Config = {}): void {
  const rolesDir = resolveDir(config.rolesDir, 'roles')
  const skillsDir = resolveDir(config.skillsDir, 'skills')
  const baseProviderName = config.baseProvider ?? 'spawn'

  // ★ 单一真相源：打印一次，便于诊断
  console.log(
      '[weave] SUSPECT_ROOT =', SUSPECT_ROOT,
      '| import.meta.url =', import.meta.url,
      '| rolesDir =', rolesDir,
      '| rolesDir exists =', existsSync(rolesDir),
      '| skillsDir =', skillsDir,
      '| skillsDir exists =', existsSync(skillsDir),
  )

  // 角色注册（延迟重试，等待 spawn provider 就绪）
  const tryRegisterRoles = (): boolean => {
    const delegate = ctx.subagents.getProvider(baseProviderName)
    if (delegate === undefined) return false

    const providers = compileRoleDirectory(rolesDir, { skillsDir }, delegate)
    for (const provider of providers) {
      ctx.subagents.registerProvider(provider)
      logger.info('role-loader', `注册角色 ${provider.name}`, {
        role_id: provider.name,
        inherits_parent_context: provider.inheritsParentContext,
        agent_route_defaults: provider.agentRouteDefaults,
      })
    }
    logger.info('weave', '角色注册完成', {
      count: providers.length,
      roles: providers.map((p) => ({ role_id: p.name, inherits_parent_context: p.inheritsParentContext })),
      roles_dir: rolesDir,
    })
    return true
  }

  if (!tryRegisterRoles()) {
    // 轮询等待 spawn provider（最多 5 秒，每 100ms 一次）
    let attempts = 0
    const maxAttempts = 50
    const timer = setInterval(() => {
      attempts++
      if (tryRegisterRoles() || attempts >= maxAttempts) {
        clearInterval(timer)
        if (attempts >= maxAttempts) {
          logger.error(
              'weave',
              '等待 spawn provider 超时，跳过角色注册（图命令不受影响）',
              new Error('spawn provider 未注册'),
              { base_provider: baseProviderName },
          )
        }
      }
    }, 100)
    // 插件卸载时清除定时器
    ctx.effect(() => () => clearInterval(timer))
  }

  // ─── 工具 & 服务注册 ──────────────────────────────────────
  registerChainTool(ctx)
  registerGraphCommands(ctx)
  registerVisualCommands(ctx)
  // ★ 关键：把已解析的 rolesDir 传给图执行命令（单一真相源）
  registerGraphRunCommand(ctx, { rolesDir })
  registerGraphResumeCommand(ctx)

  ctx.plugin(GraphEngineService, {
    defaultMaxIterations: 25,
    logTrajectory: true,
    maxConcurrentChildren: 8,
  })

  // MVP-4 Phase B：可视化 REST/SSE 运行时（webServer 鸭子类型，headless 静默跳过）
  const disposeVisual = registerVisualRuntime(ctx)
  ctx.effect(() => disposeVisual)

  logger.info('weave', 'MVP-2 图引擎与命令就绪', {
    graph_service: true,
    visual_runtime: true,
    commands: [
      'weave_graph_validate',
      'weave_graph_show',
      'weave_graph_help',
      'weave_graph_watch',
      'weave_graph_report',
      'weave_graph_status',
      'weave_graph_tail',
      'weave_run_graph',
    ],
  })
}