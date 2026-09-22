/**
 * 单链编排执行器（MVP-1 P1.2.1）。
 *
 * D-001 修正：官方 workflowEngine 的 agent() 无法按角色选择子代理 provider
 * （opts.provider 是 LLM 路由覆盖），因此 MVP-1 单链用自写编排脚本实现：
 * 按序调用 ctx.subagents.start(角色ID, request)，产物落盘 productions/<角色ID>/。
 *
 * 数据流（文档 §3.3）：
 *   R1 → R2 → R4 → R6 → R7 → R8
 *   每个角色：上游产物落盘 → 下游通过「摘要 + 文件路径」引用（不传全文）
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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

/** 链日志文件路径。 */
export function chainLogPath(productionsRoot: string): string {
  return join(productionsRoot, CHAIN_LOG_FILENAME)
}

/** 停止标志文件路径。 */
export function stopFlagPath(productionsRoot: string): string {
  return join(productionsRoot, STOP_FLAG_FILENAME)
}

/**
 * 写链日志：同时输出到 stdout（DSH 日志）与日志文件（用户可实时 tail）。
 *
 * 🐛 设计动机：编排在 DSH 进程内执行，用户看不到进程 stdout；
 *    故把执行细节落盘为用户可读日志，避免只能依赖外部监看。
 *    日志写入失败绝不影响主流程。
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

/** 单链执行结果。 */
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
 *
 * 🐛 实测：角色可能把代码包在 ```html ... ``` 里；若直接落盘为 .html，
 *    文件首尾会带代码块标记导致无法直接运行。此处做稳妥剥离。
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
 * 串行执行角色链。
 *
 * 可观测性与控制（用户可自主监控 + 中止，无需外部监看）：
 * - 执行细节写入 `<productionsRoot>/chain.log`（用户可 `Get-Content -Wait` 实时看）
 * - 每 {@link HEARTBEAT_INTERVAL_MS} 写一次心跳（含已耗时），用于区分「在干活」与「卡死」
 * - 阶段边界检查 `<productionsRoot>/STOP` 文件；存在则中止后续阶段
 *
 * @param ctx - Cordis 上下文（提供 ctx.subagents）
 * @param parent - 发起 agent（每个子代理的父；运行时由调用方传入真实 Agent）
 * @param steps - 链步骤
 * @param userInput - 用户一句话需求
 * @param productionsRoot - 产物根目录（默认 <cwd>/productions）
 * @returns 各角色执行结果（含中止标记）
 */
export async function runChain(
  ctx: Context,
  parent: unknown,
  steps: readonly ChainStep[],
  userInput: string,
  productionsRoot = join(process.cwd(), 'productions'),
): Promise<ChainResult> {
  const results: ChainResult['steps'] = []
  let upstream: ChainPromptContext['upstream'] = []
  const chainStart = Date.now()
  let stopped = false

  mkdirSync(productionsRoot, { recursive: true })
  chainLog(productionsRoot, 'info', '链开始', {
    total_steps: steps.length,
    roles: steps.map((s) => s.roleId),
    productions_root: productionsRoot,
    stop_flag: stopFlagPath(productionsRoot),
    log_file: chainLogPath(productionsRoot),
  })

  for (const step of steps) {
    // 停止检查（阶段边界）：用户创建 STOP 文件即中止
    if (existsSync(stopFlagPath(productionsRoot))) {
      stopped = true
      chainLog(productionsRoot, 'warn', '检测到 STOP 标志，链中止', {
        stopped_before: step.roleId,
        completed_steps: results.length,
        elapsed_ms: Date.now() - chainStart,
      })
      break
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

    // 心跳：每 10 秒写一次「仍在执行 + 已耗时」，供用户判断是否卡死
    const heartbeat = setInterval(() => {
      chainLog(productionsRoot, 'info', `心跳：${step.phase} 仍在执行`, {
        role_id: step.roleId,
        elapsed_s: Math.round((Date.now() - stepStart) / 1000),
      })
    }, HEARTBEAT_INTERVAL_MS)

    let result: SubagentResult
    try {
      // 启动角色子代理（角色 provider 会注入 persona/toolFilter/agentOptions）
      // parent 由调用方传入真实 Agent（本模块不持有 dsh-agent 类型定义，运行时断言）
      const run = await ctx.subagents.start(step.roleId, {
        prompt: [{ type: 'text', text: prompt }],
        parent: parent as never,
        signal: new AbortController().signal,
        label: `${step.phase}（${step.roleId}）`,
      })
      result = await run.result
    } finally {
      clearInterval(heartbeat)
    }

    const elapsedMs = Date.now() - stepStart
    const rawOutput = resultToText(result)
    // 纯代码产物（.html 等）剥离 Markdown 代码块包裹，保证可直接运行
    const output = isCodeArtifact(step.artifactName) ? stripCodeFence(rawOutput) : rawOutput
    const fenceStripped = isCodeArtifact(step.artifactName) && output !== rawOutput

    // 产物落盘（fail-fast：非 completed 也落盘现场，便于排查）
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

  chainLog(productionsRoot, 'info', stopped ? '链已中止' : '链结束', {
    completed_steps: results.length,
    total_steps: steps.length,
    stopped,
    total_elapsed_s: Math.round((Date.now() - chainStart) / 1000),
    artifacts: results.map((r) => r.artifactPath),
  })

  return { steps: results, productionsRoot, stopped }
}
