/**
 * Bugs-V5「ask_user 主动暂停问用户」单测。
 *
 * 覆盖：
 * - 工具注册（name）+ execute 触发 triggerPause（解析请求字段）+ 无活动图上下文降级
 * - 引擎 catch 路径：节点 triggerPause 后抛错（模拟 interrupt reject）→ 图暂停
 * - 引擎正常路径：节点 triggerPause 后正常返回（模拟 interrupt 未生效）→ 图暂停
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createStateGraph, getAskUserContext } from '../../src/l2-engine/state-graph'
import { registerAskUserTool, type AskUserContext } from '../../src/l2-engine/ask-user-tool'

const RO = { graphVersion: '0.1.0', graphSchemaHash: 'hash' }

interface CapturedTool {
  name: string
  execute: (args: Record<string, unknown>) => Promise<string>
}

/** 用 fake ctx.tools.register 捕获注册的工具定义。 */
function captureTool(userCtx: AskUserContext): CapturedTool {
  let captured: CapturedTool | null = null
  const fakeCtx = {
    tools: {
      register: (tool: unknown) => {
        captured = tool as CapturedTool
        return () => {}
      },
    },
  } as unknown as Context
  registerAskUserTool(fakeCtx, userCtx)
  if (!captured) throw new Error('工具未注册')
  return captured
}

describe('ask_user 工具', () => {
  it('注册名称为 ask_user', () => {
    const tool = captureTool({
      getNodeCtx: () => ({ artifactsRoot: '/tmp', graphId: 'g1', nodeId: 'r1' }),
      triggerPause: () => {},
    })
    expect(tool.name).toBe('ask_user')
  })

  it('execute 在有活动图上下文时触发 triggerPause（解析请求字段）', async () => {
    const calls: Array<{ graphId: string; nodeId: string; question: unknown }> = []
    const tool = captureTool({
      getNodeCtx: () => ({ artifactsRoot: '/tmp', graphId: 'g1', nodeId: 'r1' }),
      triggerPause: (graphId, nodeId, question) => { calls.push({ graphId, nodeId, question }) },
    })

    const out = await tool.execute({
      question: '需要禁手规则吗？',
      options: ['无禁手', '有禁手'],
      default: '无禁手',
      impact: '判定复杂度增加约 0.5 天',
    })
    expect(out).toContain('已触发图暂停')
    expect(calls).toHaveLength(1)
    expect(calls[0].graphId).toBe('g1')
    expect(calls[0].nodeId).toBe('r1')
    expect(calls[0].question).toEqual({
      question: '需要禁手规则吗？',
      options: ['无禁手', '有禁手'],
      default: '无禁手',
      impact: '判定复杂度增加约 0.5 天',
    })
  })

  it('execute 无活动图上下文时降级返回，不触发 triggerPause', async () => {
    let triggered = false
    const tool = captureTool({
      getNodeCtx: () => ({ artifactsRoot: undefined, graphId: '', nodeId: '' }),
      triggerPause: () => { triggered = true },
    })
    const out = await tool.execute({ question: 'q' })
    expect(out).toContain('无活动图上下文')
    expect(triggered).toBe(false)
  })
})

describe('引擎 ask_user 暂停', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-ask-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('catch 路径：triggerPause 后抛错（模拟 interrupt reject）→ 图暂停 awaiting-user-input', async () => {
    const ctx = new Context()
    const g = createStateGraph<Record<string, unknown>>(ctx, 25, 8, root)
    g.addNode('ask', async (_state, nodeCtx) => {
      getAskUserContext().triggerPause(nodeCtx.graphId, 'ask', {
        question: '需要禁手规则吗？',
        options: ['无禁手', '有禁手'],
        default: '无禁手',
        impact: '判定复杂度增加约 0.5 天',
      })
      throw new Error('模拟 interrupt 导致的 reject（stopReason=aborted）')
    })
    g.addEdge('ask', '__END__')
    const r = await g.run(
      { messages: [] } as Record<string, unknown>,
      { checkpoint: async () => {}, ...RO },
    )
    expect(r.success).toBe(true)
    expect(r.data?.paused).toBe(true)
    expect(r.data?.reason).toBe('awaiting-user-input')
    expect(r.data?.resumeFrom).toBe('ask')
    // 暂停快照落盘 + 问题详情存 contextTemplate
    const snapshot = JSON.parse(readFileSync(join(root, 'pauses', `${r.graphId}.json`), 'utf8'))
    expect(snapshot.pauseReason).toBe('awaiting-user-input')
    expect(snapshot.pausedNode).toBe('ask')
    const q = JSON.parse(snapshot.pauseDetails.contextTemplate)
    expect(q.question).toBe('需要禁手规则吗？')
    expect(q.default).toBe('无禁手')
  })

  it('正常路径：triggerPause 后节点正常返回（模拟 interrupt 未生效）→ 图暂停 awaiting-user-input', async () => {
    const ctx = new Context()
    const g = createStateGraph<Record<string, unknown>>(ctx, 25, 8, root)
    g.addNode('ask', async (_state, nodeCtx) => {
      getAskUserContext().triggerPause(nodeCtx.graphId, 'ask', {
        question: 'UI 暗色还是亮色？',
        default: '暗色',
        impact: '影响界面工作量',
      })
      return { messages: [{ role: 'test', node: 'ask', at: Date.now(), stopReason: 'completed' }] }
    })
    g.addEdge('ask', '__END__')
    const r = await g.run(
      { messages: [] } as Record<string, unknown>,
      { checkpoint: async () => {}, ...RO },
    )
    expect(r.success).toBe(true)
    expect(r.data?.paused).toBe(true)
    expect(r.data?.reason).toBe('awaiting-user-input')
    expect(r.data?.resumeFrom).toBe('ask')
    expect(existsSync(join(root, 'pauses', `${r.graphId}.json`))).toBe(true)
    const snapshot = JSON.parse(readFileSync(join(root, 'pauses', `${r.graphId}.json`), 'utf8'))
    expect(snapshot.pauseReason).toBe('awaiting-user-input')
    expect(JSON.parse(snapshot.pauseDetails.contextTemplate).question).toBe('UI 暗色还是亮色？')
  })
})
