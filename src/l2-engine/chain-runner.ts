/**
 * 单链编排执行器（MVP-1 P1.2.1 + MVP-3 Phase0 A1/A2/A4 修复）。
 *
 * D-001 修正：官方 workflowEngine 的 agent() 无法按角色选择子代理 provider
 * （opts.provider 是 LLM 路由覆盖），因此 MVP-1 单链用自写编排脚本实现：
 * 按序调用 ctx.subagents.start(角色ID, request)，产物落盘 productions/<角色ID>/。
 *
 * MVP-3 修复（A1/A2/A4）：
 * - A1 (S2)：signal 假中止 → controller 外部创建 + STOP watcher 实时传播（R1-R3）
 * - A2 (S3)：setInterval 未 ctx.effect → 插件级 heartbeat 集合兜底（R4-R6）
 * - A4 (S10)：暂停机制 + 可配置超时（状态机 running/paused/stopped；PAUSE/RESUME；
 *   超时默认进入暂停；三层配置 代码>文件>环境变量）（R9-R17）
 */
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { logger, truncate } from '../shared/logger.js'

/** 心跳间隔（毫秒）：执行期间定期写「仍在执行」日志。 */
export const HEARTBEAT_INTERVAL_MS = 10_000

/** 链日志文件名（位于产物根目录，供用户实时监控）。 */
export const CHAIN_LOG_FILENAME = 'chain.log'

/** 停止标志文件名（用户创建该文件即可在阶段边界中止链）。 */
export const STOP_FLAG_FILENAME = 'STOP'

/** 暂停标志文件名（用户创建该文件 → 当前步骤完成后进入暂停，可恢复）。 */
export const PAUSE_FLAG_FILENAME = 'PAUSE'

/** 恢复标志文件名（暂停中创建该文件 → 从暂停点继续）。 */
export const RESUME_FLAG_FILENAME = 'RESUME'

/** 暂停状态文件名（暂停时落盘，供进程重启后续跑）。 */
export const PAUSE_STATE_FILENAME = 'pause-state.json'

/** 链配置文件（可选；三层配置的第二层）。 */
export const CHAIN_CONFIG_FILENAME = 'chain-config.json'

/** 链日志文件路径。 */
export function chainLogPath(productionsRoot: string): string {
  return join(productionsRoot, CHAIN_LOG_FILENAME)
}

/** 停止标志文件路径。 */
export function stopFlagPath(productionsRoot: string): string {
  return join(productionsRoot, STOP_FLAG_FILENAME)
}

/** 暂停标志文件路径。 */
export function pauseFlagPath(productionsRoot: string): string {
  return join(productionsRoot, PAUSE_FLAG_FILENAME)
}

/** 恢复标志文件路径。 */
export function resumeFlagPath(productionsRoot: string): string {
  return join(productionsRoot, RESUME_FLAG_FILENAME)
}

/** 暂停状态文件路径。 */
export function pauseStatePath(productionsRoot: string): string {
  return join(productionsRoot, PAUSE_STATE_FILENAME)
}

/** 链配置文件路径。 */
export function chainConfigPath(productionsRoot: string): string {
  return join(productionsRoot, CHAIN_CONFIG_FILENAME)
}

/**
 * 写链日志：同时输出到 stdout（DSH 日志）与日志文件（用户可实时 tail）。
 * 日志写入失败绝不影响主流程。
 */
export function chainLog(
  productionsRoot: string,
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>,
): void {
  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    ...(data ?? {}),
  }
  const line = JSON.stringify(entry)
  process.stdout.write(`[weave] ${line}\n`)
  try {
    appendFileSync(chainLogPath(productionsRoot), `${line}\n`, 'utf8')
  } catch {
    // 日志文件不可写时忽略（不阻塞链执行）
  }
}

/** 链中一个角色的执行配置。 */
export interface ChainStep {
  /** 角色 provider 名（= 角色 YAML id）。 */
  roleId: string
  /** 产物相对路径（相对 productions/<roleId>/）。 */
  artifactName: string
  /** 阶段标题。 */
  phase: string
  /** 指令模板：接收 { userInput, upstream } 渲染为 prompt。 */
  prompt: (ctx: ChainPromptContext) => string
}

/** 指令渲染上下文。 */
export interface ChainPromptContext {
  userInput: string
  /** 上游产物的摘要列表（已截断）。 */
  upstream: Array<{ roleId: string; artifactName: string; summary: string; path: string }>
}

/** 链运行状态（A4 状态机）。 */
export type ChainState = 'running' | 'paused' | 'stopped'

/** 单链执行结果（A4：新增 paused/pauseReason/resumeInfo）。 */
export interface ChainResult {
  /** 每个角色的执行结果（按链顺序）。 */
  steps: Array<{
    roleId: string
    artifactPath: string
    output: string
    stopReason: string
  }>
  /** 产物根目录。 */
  productionsRoot: string
  /** 是否因用户 STOP 标志而中止。 */
  stopped: boolean
  /** 是否进入暂停（可恢复）。 */
  paused: boolean
  /** 暂停原因（超时 / 用户暂停 / 外部信号）。 */
  pauseReason?: string
  /** 恢复信息（暂停时记录，供后续续跑）。 */
  resumeInfo?: {
    /** 已完成的步骤数。 */
    completedSteps: number
    /** 下一个要执行的 roleId。 */
    nextRoleId: string
    /** upstream 快照（已完成步骤的摘要 + 路径）。 */
    upstream: ChainPromptContext['upstream']
    /** 暂停时间戳。 */
    pausedAt: number
  }
}

/** 链配置选项（A4：三层配置的代码层；文件/环境变量层见 resolveChainConfig）。 */
export interface ChainOptions {
  /** 整体超时（毫秒）；未配置则无超时。默认 undefined（不超时）。 */
  totalTimeoutMs?: number
  /** 超时触发行为；默认 'pause'（暂停，不丢任务）。 */
  onTimeout?: 'pause' | 'stop'
  /** 每步超时（毫秒），按 roleId 配置；未配置则用 totalTimeoutMs 兜底。 */
  stepTimeoutMs?: Record<string, number>
  /** 用户主动暂停标志文件（默认 <productionsRoot>/PAUSE）。 */
  pauseFlagPath?: string
  /** 恢复标志文件（默认 <productionsRoot>/RESUME）。 */
  resumeFlagPath?: string
  /** 暂停检查间隔（毫秒，默认 2000）。 */
  pauseCheckIntervalMs?: number
  /** 心跳注册器（A2：插件级兜底集合）。 */
  registerHeartbeat?: (t: NodeJS.Timeout) => void
  unregisterHeartbeat?: (t: NodeJS.Timeout) => void
}

/** 暂停状态文件内容（A4 R13：必须落盘）。 */
export interface PauseStateFile {
  pauseReason: string
  resumeInfo: {
    completedSteps: number
    nextRoleId: string
    upstream: ChainPromptContext['upstream']
    pausedAt: number
  }
}

/** 三层配置解析结果（代码 > 配置文件 > 环境变量 > 默认）。 */
export interface ResolvedChainConfig {
  totalTimeoutMs?: number
  onTimeout: 'pause' | 'stop'
  stepTimeoutMs?: Record<string, number>
  pauseCheckIntervalMs: number
}

/** 三层配置解析结果（代码 > 配置文件 > 环境变量 > 默认）。 */
export function resolveChainConfig(
  productionsRoot: string,
  code: ChainOptions,
): ResolvedChainConfig {
  // 配置文件层
  let file: Partial<ChainOptions> = {}
  try {
    file = JSON.parse(readFileSync(chainConfigPath(productionsRoot), 'utf8')) as Partial<ChainOptions>
  } catch {
    file = {}
  }
  // 环境变量层
  const envTimeout = process.env.WEAVE_CHAIN_TIMEOUT_MS
  const envOnTimeout = process.env.WEAVE_CHAIN_ON_TIMEOUT
  // 合并：代码 > 文件 > 环境变量 > 默认
  const totalTimeoutMs = code.totalTimeoutMs ?? file.totalTimeoutMs ?? (envTimeout ? Number(envTimeout) : undefined)
  const onTimeout = code.onTimeout ?? file.onTimeout ?? (envOnTimeout === 'stop' ? 'stop' : 'pause')
  const stepTimeoutMs = code.stepTimeoutMs ?? file.stepTimeoutMs
  const pauseCheckIntervalMs = code.pauseCheckIntervalMs ?? file.pauseCheckIntervalMs ?? 2000
  return {
    ...(totalTimeoutMs !== undefined ? { totalTimeoutMs } : {}),
    onTimeout,
    ...(stepTimeoutMs !== undefined ? { stepTimeoutMs } : {}),
    pauseCheckIntervalMs,
  }
}

/** 写暂停状态文件（R13：落盘，失败不阻塞）。 */
export function writePauseState(file: string, state: PauseStateFile): void {
  try {
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // 写失败不阻塞
  }
}

/** 删除暂停状态文件。 */
export function removePauseState(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    /* 忽略 */
  }
}

/** 读取暂停状态文件（不存在返回 null）。 */
export function readPauseState(file: string): PauseStateFile | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PauseStateFile
  } catch {
    return null
  }
}

/** 等待恢复信号（A4 R14：不自动恢复，用户显式 RESUME/STOP）。 */
export async function waitForResume(
  resumeFlag: string,
  stopFlag: string,
  checkIntervalMs: number,
): Promise<boolean> {
  while (true) {
    if (existsSync(stopFlag)) return false
    if (existsSync(resumeFlag)) {
      try {
        unlinkSync(resumeFlag)
      } catch {
        /* 忽略 */
      }
      return true
    }
    await new Promise((r) => setTimeout(r, checkIntervalMs))
  }
}

/**
 * 提取子代理结果的文本输出。
 */
export function resultToText(result: SubagentResult): string {
  const parts = result.output
    .map((block) => {
      if (block.type === 'text') return block.text
      return ''
    })
    .filter((text) => text.length > 0)
  return parts.join('\n').trim()
}

/**
 * 剥离 Markdown 代码块包裹（针对 .html 等纯代码产物）。
 */
export function stripCodeFence(text: string): string {
  const fenced = /^\s*```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text)
  return fenced?.[1] ?? text
}

/** 是否为纯代码产物（需要剥离 Markdown 包裹）。 */
function isCodeArtifact(artifactName: string): boolean {
  return /\.(html?|js|css|ts|json|py)$/i.test(artifactName)
}

/**
 * 串行执行角色链（MVP-3 A1/A2/A4 修复版）。
 *
 * 控制机制：
 * - STOP 文件：终止（阶段边界）；signal 实时传播（A1 R1-R3）
 * - PAUSE 文件：当前步骤完成后进入暂停，可恢复（A4 R9-R16）
 * - 整体超时：默认进入暂停（onTimeout: 'pause'），不丢已完成任务
 * - 单步超时：只记警告，不改变状态
 * - 暂停状态落盘 pause-state.json（R13），恢复经 RESUME 文件（R14）
 *
 * @param ctx - Cordis 上下文
 * @param parent - 发起 agent
 * @param steps - 链步骤
 * @param userInput - 用户一句话需求
 * @param productionsRoot - 产物根目录
 * @param options - 链配置（代码层）
 */
export async function runChain(
  ctx: Context,
  parent: unknown,
  steps: readonly ChainStep[],
  userInput: string,
  productionsRoot = join(process.cwd(), 'productions'),
  options: ChainOptions = {},
): Promise<ChainResult> {
  const results: ChainResult['steps'] = []
  let upstream: ChainPromptContext['upstream'] = []
  const chainStart = Date.now()

  // A4：三层配置
  const cfg = resolveChainConfig(productionsRoot, options)

  // A4：状态机（用容器对象，避免 TS 闭包写入窄化推断）
  const runState: { value: ChainState } = { value: 'running' }
  let pauseReason: string | undefined

  // A4：路径
  const pauseFlag = options.pauseFlagPath ?? pauseFlagPath(productionsRoot)
  const resumeFlag = options.resumeFlagPath ?? resumeFlagPath(productionsRoot)
  const stopFlag = stopFlagPath(productionsRoot)
  const pauseStateFile = pauseStatePath(productionsRoot)

  mkdirSync(productionsRoot, { recursive: true })
  chainLog(productionsRoot, 'info', '链开始', {
    total_steps: steps.length,
    roles: steps.map((s) => s.roleId),
    productions_root: productionsRoot,
    stop_flag: stopFlag,
    pause_flag: pauseFlag,
    total_timeout_ms: cfg.totalTimeoutMs ?? 'none',
    on_timeout: cfg.onTimeout,
    log_file: chainLogPath(productionsRoot),
  })

  // A1：controller 在 effect 外创建，可被 STOP watcher 触发
  const ctrl = new AbortController()

  // A4：整体超时触发器（默认进入暂停，不 abort）
  let timeoutHandle: NodeJS.Timeout | null = null
  if (cfg.totalTimeoutMs && cfg.onTimeout !== 'stop') {
    timeoutHandle = setTimeout(() => {
      runState.value = 'paused'
      pauseReason = `整体超时（${cfg.totalTimeoutMs}ms）`
      chainLog(productionsRoot, 'warn', '超时触发暂停', {
        pause_reason: pauseReason,
        completed_steps: results.length,
        total_steps: steps.length,
      })
    }, cfg.totalTimeoutMs)
  } else if (cfg.totalTimeoutMs && cfg.onTimeout === 'stop') {
    // 兼容"超时终止"语义（默认不用）
    timeoutHandle = setTimeout(() => {
      runState.value = 'stopped'
      pauseReason = `整体超时（${cfg.totalTimeoutMs}ms）`
      ctrl.abort(new Error(`链整体超时（${cfg.totalTimeoutMs}ms）`))
    }, cfg.totalTimeoutMs)
  }

  // A1+A4：STOP / PAUSE 监听（2 秒轮询；R3 不用 fs.watch）
  const pauseCheckMs = cfg.pauseCheckIntervalMs
  const watcher = setInterval(() => {
    if (existsSync(stopFlag)) {
      runState.value = 'stopped'
      ctrl.abort(new Error('用户 STOP')) // A1：signal 实时传播
    } else if (existsSync(pauseFlag) && runState.value === 'running') {
      runState.value = 'paused'
      pauseReason = '用户主动暂停'
      chainLog(productionsRoot, 'info', '检测到 PAUSE 标志，进入暂停', {
        completed_steps: results.length,
      })
    }
  }, pauseCheckMs)
  options.registerHeartbeat?.(watcher)

  // A2：插件级兜底（effect 只注册一次清理，不每次 runChain 累积）。
  // 兼容测试/无 effect 环境：ctx.effect 不存在时跳过兜底（正常路径的 finally 清理已覆盖）。
  const effectCleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    clearInterval(watcher)
    options.unregisterHeartbeat?.(watcher)
  }
  const dispose =
    typeof (ctx as { effect?: unknown }).effect === 'function'
      ? (ctx as Context).effect(() => effectCleanup)
      : effectCleanup

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!
      if (!step) break

      // 1) 停止检查（阶段边界）：watcher 异步检测 + 同步兜底（STOP 文件刚创建时立即生效）
      if (runState.value === 'stopped' || existsSync(stopFlag)) {
        if (runState.value !== 'stopped') {
          runState.value = 'stopped'
          ctrl.abort(new Error('用户 STOP'))
        }
        chainLog(productionsRoot, 'warn', '检测到 STOP 标志，链终止', {
          stopped_before: step.roleId,
          completed_steps: results.length,
        })
        break
      }

      // 2) 暂停检查（阶段边界）—— 进入等待恢复循环（A4）
      // 2) 暂停检查（阶段边界）：watcher 异步检测 + 同步兜底（PAUSE 文件刚创建时立即生效）
      if (runState.value === 'paused' || existsSync(pauseFlag)) {
        if (runState.value !== 'paused') {
          runState.value = 'paused'
          pauseReason = '用户主动暂停'
        }
        const resumeInfo: ChainResult['resumeInfo'] = {
          completedSteps: results.length,
          nextRoleId: step.roleId,
          upstream,
          pausedAt: Date.now(),
        }
        writePauseState(pauseStateFile, {
          pauseReason: pauseReason ?? 'unknown',
          resumeInfo,
        })

        chainLog(productionsRoot, 'info', '链进入暂停', {
          pause_reason: pauseReason,
          next_role: step.roleId,
          completed_steps: results.length,
          resume_hint: `创建 ${resumeFlag} 恢复；创建 ${stopFlag} 终止`,
        })

        // 等待恢复信号（不退出函数）
        const resumed = await waitForResume(resumeFlag, stopFlag, pauseCheckMs)
        if (!resumed) {
          runState.value = 'stopped'
          break
        }

        // 恢复：清理标志
        runState.value = 'running'
        pauseReason = undefined
        removePauseState(pauseStateFile)
        chainLog(productionsRoot, 'info', '链从暂停恢复', {
          from_role: step.roleId,
          elapsed_total_ms: Date.now() - chainStart,
        })
      }

      const stepDir = join(productionsRoot, step.roleId)
      mkdirSync(stepDir, { recursive: true })
      const artifactPath = join(stepDir, step.artifactName)

      const prompt = step.prompt({ userInput, upstream })
      const provider = ctx.subagents.getProvider(step.roleId)
      const stepStart = Date.now()

      chainLog(productionsRoot, 'info', `阶段开始：${step.phase}`, {
        step: results.length + 1,
        total_steps: steps.length,
        role_id: step.roleId,
        prompt_len: prompt.length,
        upstream_count: upstream.length,
        tool_filter: provider?.capabilities.toolFilter === true ? 'capability-enabled' : 'n/a',
        inherits_parent_context: provider?.inheritsParentContext,
      })
      logger.info('chain', `执行阶段 ${step.phase}（${step.roleId}）`, {
        role_id: step.roleId,
        prompt_len: prompt.length,
        upstream_count: upstream.length,
      })

      // 心跳（A2：registerHeartbeat 兜底）
      const heartbeat = setInterval(() => {
        chainLog(productionsRoot, 'info', `心跳：${step.phase} 仍在执行`, {
          role_id: step.roleId,
          elapsed_s: Math.round((Date.now() - stepStart) / 1000),
        })
      }, HEARTBEAT_INTERVAL_MS)
      options.registerHeartbeat?.(heartbeat)

      // 单步超时（A4 R15：只记警告，不改状态）
      const stepTimeout = cfg.stepTimeoutMs?.[step.roleId]
      let stepTimeoutHandle: NodeJS.Timeout | null = null
      if (stepTimeout) {
        stepTimeoutHandle = setTimeout(() => {
          chainLog(productionsRoot, 'warn', '单步超时', {
            role_id: step.roleId,
            step_timeout_ms: stepTimeout,
            elapsed_s: Math.round((Date.now() - stepStart) / 1000),
          })
        }, stepTimeout)
      }

      let result: SubagentResult
      try {
        // A1：signal 用外部 controller（STOP 时 abort 传播到 LLM 请求）
        const run = await ctx.subagents.start(step.roleId, {
          prompt: [{ type: 'text', text: prompt }],
          parent: parent as never,
          signal: ctrl.signal,
          label: `${step.phase}（${step.roleId}）`,
        })
        result = await run.result
      } finally {
        clearInterval(heartbeat)
        options.unregisterHeartbeat?.(heartbeat)
        if (stepTimeoutHandle) clearTimeout(stepTimeoutHandle)
      }

      const elapsedMs = Date.now() - stepStart
      const rawOutput = resultToText(result)
      const output = isCodeArtifact(step.artifactName) ? stripCodeFence(rawOutput) : rawOutput
      const fenceStripped = isCodeArtifact(step.artifactName) && output !== rawOutput

      writeFileSync(artifactPath, output, 'utf8')
      chainLog(productionsRoot, 'info', `阶段完成：${step.phase}`, {
        role_id: step.roleId,
        stop_reason: result.stopReason,
        elapsed_s: Math.round(elapsedMs / 1000),
        output_len: output.length,
        fence_stripped: fenceStripped,
        artifact: artifactPath,
      })
      logger.info('chain', `阶段完成 ${step.phase}`, {
        role_id: step.roleId,
        stop_reason: result.stopReason,
        output_len: output.length,
        artifact: artifactPath,
      })

      const summary = truncate(output, 500)
      results.push({ roleId: step.roleId, artifactPath, output, stopReason: result.stopReason })
      upstream = [
        ...upstream,
        { roleId: step.roleId, artifactName: step.artifactName, summary, path: artifactPath },
      ]
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    clearInterval(watcher)
    options.unregisterHeartbeat?.(watcher)
    dispose()
  }

  const finalState: ChainState = runState.value === 'stopped' ? 'stopped' : results.length === steps.length ? 'running' : 'paused'

  chainLog(
    productionsRoot,
    'info',
    finalState === 'stopped' ? '链已终止' : finalState === 'paused' ? '链已暂停（可恢复）' : '链结束',
    {
      completed_steps: results.length,
      total_steps: steps.length,
      stopped: finalState === 'stopped',
      paused: finalState === 'paused',
      pause_reason: pauseReason,
      total_elapsed_s: Math.round((Date.now() - chainStart) / 1000),
      artifacts: results.map((r) => r.artifactPath),
    },
  )

  return {
    steps: results,
    productionsRoot,
    stopped: finalState === 'stopped',
    paused: finalState === 'paused',
    ...(pauseReason !== undefined ? { pauseReason } : {}),
    ...(finalState === 'paused'
      ? {
          resumeInfo: {
            completedSteps: results.length,
            nextRoleId: steps[results.length]?.roleId ?? '',
            upstream,
            pausedAt: Date.now(),
          },
        }
      : {}),
  }
}
