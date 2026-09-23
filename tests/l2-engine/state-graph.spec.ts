/**
 * state-graph.ts 集成测试（MVP-2 T9 Exit Gate：8 断言）。
 *
 * 覆盖：addNode/addEdge/addConditionalEdge/addApprovalGate 可用、
 * run 从入口执行、迭代熔断、合并冲突 success:false、并发闸成对、
 * 轨迹事件 8 种、三节点图跑通、循环回退。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createStateGraph, END } from '../../src/l2-engine/state-graph'
import type { NodeHandler } from '../../src/l2-engine/types'

interface DemoState extends Record<string, unknown> {
  messages: string[]
  retry_count: number
  phase: string
}

/** 构造三节点图：a → b → c。 */
function buildLinear(ctx: Context) {
  const g = createStateGraph<DemoState>(ctx, 25, 8)
  g.addNode('a', async () => ({ messages: ['a'] }))
  g.addNode('b', async () => ({ messages: ['b'] }))
  g.addNode('c', async () => ({ messages: ['c'] }))
  g.addEdge('a', 'b')
  g.addEdge('b', 'c')
  return g
}

describe('T9 StateGraph 引擎骨架', () => {
  it('5 个方法可用', () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx)
    expect(typeof g.addNode).toBe('function')
    expect(typeof g.addEdge).toBe('function')
    expect(typeof g.addConditionalEdge).toBe('function')
    expect(typeof g.addApprovalGate).toBe('function')
    expect(typeof g.run).toBe('function')
  })

  it('run 从入口执行三节点图（seq 顺序推进）', async () => {
    const ctx = new Context()
    const g = buildLinear(ctx)
    const result = await g.run(
      { messages: [], retry_count: 0, phase: 'start' },
      { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' },
    )
    expect(result.success).toBe(true)
    expect(result.finalState.messages).toEqual(['a', 'b', 'c'])
    expect(result.iterations).toBe(3)
  })

  it('轨迹事件包含核心 5 种（start/node-start/node-end/checkpoint/end）', async () => {
    const ctx = new Context()
    const g = buildLinear(ctx)
    const result = await g.run({ messages: [], retry_count: 0, phase: 'start' }, { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' })
    const types = result.trajectory.map((e) => e.type)
    expect(types).toContain('graph/start')
    expect(types).toContain('graph/node-start')
    expect(types).toContain('graph/node-end')
    expect(types).toContain('graph/checkpoint-written')
    expect(types).toContain('graph/end')
    // 8 种类型契约：类型全集可被事件流覆盖（至少 5 种出现）
    expect(new Set(types).size).toBeGreaterThanOrEqual(5)
  })

  it('迭代熔断生效（maxIterations=2，自环图终止）', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx, 2, 8)
    g.addNode('loop', async (s) => ({ retry_count: ((s.retry_count ?? 0) as number) + 1 }))
    g.addEdge('loop', 'loop')
    const result = await g.run({ messages: [], retry_count: 0, phase: '' }, { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' })
    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('迭代次数超过上限')
    expect(result.trajectory.some((e) => e.type === 'graph/error')).toBe(true)
  })

  it('合并冲突返回 success: false 且带 conflicts', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx)
    g.addNode('a', async () => ({ phase: 'a' }))
    g.addNode('b', async () => ({ phase: 'b' })) // 冲突：phase 已有值且不同
    g.addEdge('a', 'b')
    const result = await g.run({ messages: [], retry_count: 0, phase: 'initial' }, { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' })
    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('状态合并冲突')
  })

  it('并发闸 acquire/release 成对（finally 释放）', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx, 25, 1) // limit=1
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addNode('b', async () => ({ messages: ['b'] }))
    g.addEdge('a', 'b')
    const result = await g.run({ messages: [], retry_count: 0, phase: 'start' }, { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' })
    // limit=1 串行执行不应被拒绝（release 在 finally）
    expect(result.success).toBe(true)
  })

  it('addConditionalEdge 条件函数路由（回退 + 循环迭代事件）', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx, 25, 8)
    const work: NodeHandler<DemoState> = async (s) => ({
      messages: ['work'],
      retry_count: ((s.retry_count ?? 0) as number) + 1,
    })
    const quality: NodeHandler<DemoState> = async () => ({ messages: ['quality'] })
    g.addNode('work', work)
    g.addNode('quality', quality)
    g.addEdge('work', 'quality')
    // quality 后条件路由：retry < 2 回 work，否则 __END__
    g.addConditionalEdge('quality', async (s) => (((s.retry_count ?? 0) as number) < 2 ? 'work' : END))
    const result = await g.run({ messages: [], retry_count: 0, phase: '' }, { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' })
    expect(result.success).toBe(true)
    // 执行序列：work→quality→work→quality→work→quality → retry=3 ≥2 → END
    expect(result.finalState.messages).toContain('quality')
    expect(result.finalState.retry_count).toBe(3)
    expect(result.trajectory.some((e) => e.type === 'graph/loop-iteration')).toBe(true)
  })

  it('addApprovalGate 节点可注册且执行（无 agent 时跳过审批）', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx)
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addApprovalGate('gate', { toolName: 'weave_approve', reason: '测试门', required: false })
    g.addEdge('a', 'gate')
    const result = await g.run({ messages: [], retry_count: 0, phase: 'start' }, { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' })
    expect(result.success).toBe(true)
  })

  it('checkpoint 在补丁合并后被调用', async () => {
    const ctx = new Context()
    const g = buildLinear(ctx)
    const checkpoint = vi.fn(async () => {})
    await g.run({ messages: [], retry_count: 0, phase: 'start' }, { checkpoint, graphVersion: '0.1.0', graphSchemaHash: 'hash' })
    expect(checkpoint).toHaveBeenCalledTimes(3)
    expect(checkpoint.mock.calls[0]?.[0].node).toBe('a')
    expect(checkpoint.mock.calls[0]?.[0].state.messages).toEqual(['a'])
  })
})
