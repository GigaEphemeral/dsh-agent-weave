/**
 * weave_propose_task 工具（MVP-5 Phase I：结构化任务入口）。
 *
 * 决策 #1：调用方 = 主 agent（面板编辑后由面板/用户点【开始工作】启动 weave_run_graph）。
 * 主 agent 说"用 weave 创建 XXX"时调本工具，**不直接跑图**。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { resolveExecWorkspace } from './graph-commands.js'
import {
  buildGraphFromTemplate,
  canProposeTask,
  createTask,
  generateTaskId,
  type TaskDraft,
  type TaskTemplate,
} from '../l4-visual/host/task-store.js'
import { getGlobalBroker } from '../l4-visual/host/visual-runtime.js'

export function registerProposeCommand(ctx: Context): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'weave_propose_task',
      description:
        '【首选工具】当用户说"用 weave 创建/编排/做 XXX"时，**必须调用此工具**。' +
        '创建一个任务草稿并打开右侧编辑面板，用户编辑后点【开始工作】才执行图。' +
        '调用后请向用户报告"面板已打开，请编辑后点【开始工作】"，然后停止等待（不要等图跑完，图还没开始跑）。' +
        '**禁止**用 weave_run_chain（已废弃，会中止）或 weave_run_graph（跳过编辑）替代。' +
        '**禁止**在会话已有活跃任务时再次调用（会返回错误提示）。',
      parameters: {
        user_input: { type: 'string', required: true, description: '用户一句话需求' },
        template: {
          type: 'string',
          enum: ['full-sdlc', 'quick-dev', 'research-only', 'custom'],
          description: '草稿模板：full-sdlc（默认六阶段）/ quick-dev（开发-测试-评审）/ research-only / custom',
        },
        graph_path: { type: 'string', description: '自定义图 YAML 路径（custom 模板用）' },
        output_dir: { type: 'string', description: '可选产物目录（默认 <workspace>/productions）' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: value }]
        },
      },
      async execute(args, exec) {
        resolveExecWorkspace(exec) // 校验会话工作区（不直接使用）
        // 单图模式：以调用方 agent 的 sessionId 作为会话标识（工具上下文无顶层 sessionId）
        const sessionId = (exec as { sessionId?: string }).sessionId
          ?? (exec.agent && 'sessionId' in exec.agent ? String((exec.agent as { sessionId?: unknown }).sessionId ?? '') : 'default')

        // 单图模式：会话已有活跃任务 → 拒绝
        const guard = canProposeTask(sessionId)
        if (!guard.ok && guard.existing) {
          const existing = guard.existing
          return [
            `❌ 已有活跃任务（${existing.taskId}，状态：${existing.status}）。`,
            '',
            '请选择一个操作：',
            '  1. 等用户完成当前任务',
            '  2. 调用 POST /api/weave/tasks/:taskId/cancel 取消当前任务',
            '  3. 若用户想开新任务，先取消当前任务',
            '',
            '**不要**尝试不同模板重复调用 weave_propose_task。',
          ].join('\n')
        }

        const template = (args.template ?? 'full-sdlc') as TaskTemplate
        const graph = buildGraphFromTemplate(template)
        const taskId = generateTaskId()
        const task: TaskDraft = createTask({
          taskId,
          sessionId,
          userInput: args.user_input,
          template,
          graph,
          status: 'proposing',
          outputDir: args.output_dir,
          parentAgent: exec.agent,
        })

        // SSE 推送 task-proposed（面板订阅 /api/weave/stream 后自动打开）
        const broker = getGlobalBroker()
        broker?.broadcast('*', {
          trace_id: taskId,
          event_type: 'task-proposed',
          timestamp: Date.now(),
          data: {
            taskId,
            userInput: args.user_input,
            template,
            graph,
            panelUrl: `#weave?taskId=${taskId}`,
          },
        })

        return [
          `✅ 已创建任务草稿（${taskId}）。`,
          '面板已打开（右侧滑出），请编辑工作流后点击【开始工作】。在你确认之前，图不会执行。',
          `模板：${template}`,
          `节点：${task.graph.nodes.map((n) => n.id).join(' → ')}`,
          `面板地址：#weave?taskId=${taskId}`,
        ].join('\n')
      },
    }),
  )
}
