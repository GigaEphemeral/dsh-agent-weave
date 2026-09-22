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
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { logger, truncate } from '../shared/logger.js'

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
 * 串行执行角色链。
 *
 * @param ctx - Cordis 上下文（提供 ctx.subagents）
 * @param parent - 发起 agent（每个子代理的父；运行时由调用方传入真实 Agent）
 * @param steps - 链步骤
 * @param userInput - 用户一句话需求
 * @param productionsRoot - 产物根目录（默认 <cwd>/productions）
 * @returns 各角色执行结果
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

  for (const step of steps) {
    const stepDir = join(productionsRoot, step.roleId)
    mkdirSync(stepDir, { recursive: true })
    const artifactPath = join(stepDir, step.artifactName)

    const prompt = step.prompt({ userInput, upstream })
    logger.info('chain', `执行阶段 ${step.phase}（${step.roleId}）`, {
      role_id: step.roleId,
      prompt_len: prompt.length,
      upstream_count: upstream.length,
    })

    // 启动角色子代理（角色 provider 会注入 persona/toolFilter/agentOptions）
    // parent 由调用方传入真实 Agent（本模块不持有 dsh-agent 类型定义，运行时断言）
    const run = await ctx.subagents.start(step.roleId, {
      prompt: [{ type: 'text', text: prompt }],
      parent: parent as never,
      signal: new AbortController().signal,
      label: `${step.phase}（${step.roleId}）`,
    })

    const result = await run.result
    const output = resultToText(result)

    // 产物落盘（fail-fast：非 completed 也落盘现场，便于排查）
    writeFileSync(artifactPath, output, 'utf8')
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

  return { steps: results, productionsRoot }
}
