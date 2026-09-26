/**
 * MVP-5 Phase I/H：weave_propose_task 工具执行流单测。
 *
 * 通过 mock ctx.tools.register 捕获工具定义，直接调用 execute：
 * - 正常提议 → 返回 taskId + 创建草稿（status=proposing）
 * - 单图模式：同会话已有活跃任务 → 拒绝
 * - 模板参数生效
 */
import { describe, expect, it } from 'vitest'
import { registerProposeCommand } from '../../src/cli/propose-commands'
import { deleteTask, getTask } from '../../src/l4-visual/host/task-store'

interface CapturedTool {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<string>
}

function captureTool(): { tool: CapturedTool; dispose: () => void } {
  let tool: CapturedTool | null = null
  const ctx = {
    tools: {
      register: (t: CapturedTool) => {
        tool = t
        return () => {}
      },
    },
  }
  registerProposeCommand(ctx as never)
  if (!tool) throw new Error('tool not captured')
  return { tool, dispose: () => {} }
}

function makeExec(sessionId: string): unknown {
  return {
    sessionId,
    workspace: 'C:/tmp/weave-test',
    agent: { sessionId, options: {} },
  }
}

describe('weave_propose_task', () => {
  it('创建草稿并返回 taskId（status=proposing，full-sdlc）', async () => {
    const { tool } = captureTool()
    const sessionId = 'sess-propose-1'
    const text = await tool.execute({ user_input: '做个 ETF 工具', template: 'full-sdlc' }, makeExec(sessionId))
    expect(text).toContain('已创建任务草稿')
    const taskIdMatch = /task-\d+-[a-z0-9]+/.exec(text)
    expect(taskIdMatch).not.toBeNull()
    const taskId = taskIdMatch?.[0] ?? ''
    const task = getTask(taskId)
    expect(task?.status).toBe('proposing')
    expect(task?.sessionId).toBe(sessionId)
    expect(task?.template).toBe('full-sdlc')
    expect(task?.graph.nodes).toHaveLength(6)
    deleteTask(taskId)
  })

  it('单图模式：同会话活跃任务存在时拒绝', async () => {
    const { tool } = captureTool()
    const sessionId = 'sess-propose-2'
    const first = await tool.execute({ user_input: 'A', template: 'quick-dev' }, makeExec(sessionId))
    const taskId = /task-\d+-[a-z0-9]+/.exec(first)?.[0] ?? ''
    const second = await tool.execute({ user_input: 'B' }, makeExec(sessionId))
    expect(second).toContain('已有活跃任务')
    deleteTask(taskId)
  })

  it('不同会话互不阻塞（单图模式按 session 隔离）', async () => {
    const { tool } = captureTool()
    const a = await tool.execute({ user_input: 'A', template: 'research-only' }, makeExec('sess-propose-3a'))
    const b = await tool.execute({ user_input: 'B', template: 'research-only' }, makeExec('sess-propose-3b'))
    expect(a).toContain('已创建任务草稿')
    expect(b).toContain('已创建任务草稿')
    const idA = /task-\d+-[a-z0-9]+/.exec(a)?.[0] ?? ''
    const idB = /task-\d+-[a-z0-9]+/.exec(b)?.[0] ?? ''
    deleteTask(idA)
    deleteTask(idB)
  })
})
