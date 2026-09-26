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
        '创建 weave 任务草稿并打开右侧编辑面板。**不直接执行图**。' +
        '用于用户说"用 weave 创建/编排 XXX"时。' +
        '用户会在面板中编辑工作流（角色/门禁/模型），确认后点击【开始工作】才执行。',
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
            '请先完成、取消或等待该任务结束，再创建新任务。',
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
