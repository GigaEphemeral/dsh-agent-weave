/**
 * weave_run_chain 测试工具（MVP-1 P1.2.4 触发入口）。
 *
 * ⚠️ 工具名必须符合 OpenAI 兼容端点的函数名规范 `^[a-zA-Z0-9_-]{1,128}$`。
 *    🐛 实测：原名 `weave:run-chain` 含冒号，被火山引擎端点拒绝
 *    （400 InvalidParameter: tools.N.function.name expected 1-128 ASCII
 *    letters, digits, underscores or hyphens）。mock server 不校验函数名，
 *    故仅真实 LLM 环境暴露此问题。
 *
 * headless/web 主 Agent 通过此工具执行 R1→R8 单链，验证：
 * - 多角色串行协作（Q4）
 * - 产物落盘 productions/<角色ID>/
 * - 记忆隔离（inheritsParentContext=false，spawn 每次全新 session）
 * - toolFilter（角色 provider 注入 toolFilter，子代理只见自己的工具）
 *
 * 注意：这是 MVP-1 验证工具；MVP-2 起由 StateGraph 引擎取代。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { runChain, chainLogPath, type ChainResult } from './chain-runner.js'
import { buildMvp1Chain } from './mvp1-chain.js'
import { logger } from '../shared/logger.js'

export interface ChainToolResult {
  ok: boolean
  productionsRoot: string
  /** 是否因用户 STOP 标志而中止（阶段边界检查）。 */
  stopped: boolean
  /** 链执行日志路径（用户可实时查看）。 */
  logFile: string
  steps: Array<{
    roleId: string
    artifact: string
    stopReason: string
    outputLength: number
    preview: string
  }>
  error?: string
}

/** 组装并执行单链，返回结构化结果。 */
export async function executeChain(
  ctx: Context,
  exec: ToolRunContext,
  userInput: string,
  productionsRoot?: string,
): Promise<ChainToolResult> {
  const parent = exec.agent
  const root = productionsRoot ?? join(process.cwd(), 'productions')
  if (parent === undefined) {
    return { ok: false, productionsRoot: root, stopped: false, logFile: '', steps: [], error: '工具调用缺少 agent 上下文' }
  }
  try {
    const steps = buildMvp1Chain()
    const result: ChainResult = await runChain(ctx, parent, steps, userInput, root)
    return {
      ok: true,
      productionsRoot: result.productionsRoot,
      stopped: result.stopped,
      logFile: chainLogPath(result.productionsRoot),
      steps: result.steps.map((s) => ({
        roleId: s.roleId,
        artifact: s.artifactPath,
        stopReason: s.stopReason,
        outputLength: s.output.length,
        preview: s.output.slice(0, 120),
      })),
    }
  } catch (error) {
    logger.error('chain-tool', '单链执行失败', error instanceof Error ? error : new Error(String(error)))
    return {
      ok: false,
      productionsRoot: root,
      stopped: false,
      logFile: chainLogPath(root),
      steps: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 注册 weave_run_chain 工具。 */
export function registerChainTool(ctx: Context): () => void {
  const tool = defineTool({
    name: 'weave_run_chain',
    description:
      '执行 MVP-1 单链：按 R1→R2→R4→R6→R7→R8 顺序调用六个角色子代理，每个角色独立 Session（记忆隔离），' +
      '产物落盘 productions/<角色ID>/。执行细节写入 productions/chain.log（可实时查看）；' +
      '在 productions/ 下创建 STOP 文件可在阶段边界中止链。返回各角色产物摘要。',
    parameters: {
      user_input: {
        type: 'string',
        required: true,
        description: '用户一句话需求',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          productionsRoot: { type: 'string', required: true },
          stopped: { type: 'boolean', required: true },
          logFile: { type: 'string', required: true },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                roleId: { type: 'string', required: true },
                artifact: { type: 'string', required: true },
                stopReason: { type: 'string', required: true },
                outputLength: { type: 'integer', required: true },
                preview: { type: 'string', required: true },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        const v = value as ChainToolResult
        const lines = v.steps.map(
          (s) => `  ${s.roleId}: ${s.stopReason} (${s.outputLength} 字符) -> ${s.artifact}`,
        )
        const head = v.stopped ? '单链被 STOP 中止' : `单链执行${v.ok ? '成功' : '失败'}`
        return [
          {
            type: 'text',
            text: `${head}：\n${lines.join('\n')}\n\n实时日志：${v.logFile}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      return executeChain(ctx, exec, args.user_input)
    },
  })
  return ctx.tools.register(tool)
}
