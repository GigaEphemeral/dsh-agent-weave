/**
 * ask_user 工具（Bugs-V5：允许 subagent 主动暂停并向用户提问）。
 *
 * 链路：
 * 1. 工具 execute → pendingAskUser.set + 触发 pause trigger
 * 2. pause trigger → interruptSubagent 打断当前 subagent
 * 3. subagent/end 事件 → waitForSubagentEnd reject → addSubagent throw → run() catch
 * 4. run() catch 检查 pendingAskUser → 命中 → 走 ask-user 暂停流程（写快照 + 通知）
 * 5. 用户回答 → weave_graph_resume additional_context → sendMessage 给同一 childId
 * 6. subagent 收到回答继续
 *
 * 为什么挂 300ms 再返回：给 interruptSubagent 一点时间生效。
 * 即使 subagent 在 300ms 内又做了操作，run() 的 catch 和正常流程都会检查
 * pendingAskUser，都能正确捕获。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { logger } from '../shared/logger.js'

export interface AskUserRequest {
  question: string
  options?: string[]
  default?: string
  impact?: string
}

export interface AskUserContext {
  getNodeCtx: () => { artifactsRoot: string | undefined; graphId: string; nodeId: string }
  triggerPause: (graphId: string, nodeId: string, question: AskUserRequest) => void
}

export function registerAskUserTool(ctx: Context, userCtx: AskUserContext): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'ask_user',
      description:
        '★ 关键决策点，暂停当前图执行，向用户提问。' +
        '\n\n【什么时候用】' +
        '\n- 需求模糊，有多个合理方案，且选择会影响下游大量工作（如"要不要 AI 对战""支持几种难度"）' +
        '\n- 涉及用户偏好/风格选择（如"UI 用暗色还是亮色"）' +
        '\n- 涉及安全/权限/预算/外部依赖的决策' +
        '\n\n【什么时候不用】' +
        '\n- 有行业标准可循（如"五子棋棋盘 15×15"、"俄罗斯方块 10×20"）' +
        '\n- 影响范围小（如"按钮圆角多少像素"）' +
        '\n- 上游已有明确约束（读上游产物即可）' +
        '\n- 一次节点最多问 **3 次**——超过就用默认假设 + 记入产物"待确认问题清单"' +
        '\n\n【调用后会发生什么】' +
        '\n- 当前图**立即暂停**（写暂停快照 + 通过审批卡通知主 agent）' +
        '\n- 用户在主 agent chat 里看到你的问题 + 选项 + 默认 + 影响' +
        '\n- 用户回答后，主 agent 调 weave_graph_resume，你会收到回答继续' +
        '\n- 用户长时间不回答，图会用 default 假设继续（**必须提供 default**）' +
        '\n\n【调用前】先输出一行"[动作] 需要用户决策：<问题摘要>"。',
      parameters: {
        question: {
          type: 'string',
          required: true,
          description: '要问用户什么（清晰、具体、一次一件事；不要问"要不要继续"这类废话）',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：预置选项（供用户快速选择，2-4 个为宜）',
        },
        default: {
          type: 'string',
          description: '默认假设（用户超时不回答时用；强烈建议必填，避免图卡死）',
        },
        impact: {
          type: 'string',
          description: '影响范围（这个决策错了会怎样，帮用户快速判断）',
        },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: value as string }]
        },
      },
      async execute(args) {
        const nodeCtx = userCtx.getNodeCtx()
        if (!nodeCtx.graphId || !nodeCtx.nodeId) {
          return '⚠ 无活动图上下文，ask_user 无法触发暂停'
        }

        const request: AskUserRequest = {
          question: String(args.question),
          ...(args.options !== undefined ? { options: args.options as string[] } : {}),
          ...(args.default !== undefined ? { default: String(args.default) } : {}),
          ...(args.impact !== undefined ? { impact: String(args.impact) } : {}),
        }

        logger.info('weave-ask-user', '节点主动提问，触发图暂停', {
          graphId: nodeCtx.graphId,
          nodeId: nodeCtx.nodeId,
          question: request.question.slice(0, 200),
          hasDefault: !!request.default,
          hasOptions: !!request.options,
        })

        // ★ 触发暂停（内部会写 pendingAskUser + interrupt 当前 subagent）
        userCtx.triggerPause(nodeCtx.graphId, nodeCtx.nodeId, request)

        // ★ 给 interrupt 一点时间生效（即使 subagent 又做了一步也无妨——
        //    run() 的 catch 和正常流程都会检查 pendingAskUser）
        await new Promise((r) => setTimeout(r, 300))

        return '⏸ 已触发图暂停，等待用户决策。请勿继续操作，等待用户回复后图会自动恢复。'
      },
    }),
  )
}
