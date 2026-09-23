/**
 * 代码审查修复验证（MVP-2.5）。
 *
 * 覆盖：
 * - S1：RunOptions.graphVersion/graphSchemaHash 必需，缺失抛错
 * - S8：审批门 fail-closed（缺 approval 服务且 required 默认 → 抛错；required:false → 跳过）
 * - S12：atomic-merge 原型污染防护（__proto__ 键不污染）
 * - S13：node-end 事件携带 reportTokenUsage/reportRetry 数据
 * - M1：artifacts 递归深合并
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createStateGraph, END } from '../../src/l2-engine/state-graph'
import { mergeState } from '../../src/l2-engine/atomic-merge'

interface DemoState extends Record<string, unknown> {
  messages: string[]
  retry_count: number
}

const RO = { graphVersion: '0.1.0', graphSchemaHash: 'hash' }

describe('S1 graphVersion 必需', () => {
  it('缺失 graphVersion 抛错', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx)
    g.addNode('a', async () => ({ messages: ['a'] }))
    await expect(
      g.run({ messages: [], retry_count: 0 }, { checkpoint: async () => {}, graphSchemaHash: 'h' } as never),
    ).rejects.toThrow(/graphVersion 是必需的/)
  })

  it('缺失 graphSchemaHash 抛错', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx)
    g.addNode('a', async () => ({ messages: ['a'] }))
    await expect(
      g.run({ messages: [], retry_count: 0 }, { checkpoint: async () => {}, graphVersion: '0.1.0' } as never),
    ).rejects.toThrow(/graphSchemaHash 是必需的/)
  })

  it('提供完整字段正常运行', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx)
    g.addNode('a', async () => ({ messages: ['a'] }))
    const r = await g.run({ messages: [], retry_count: 0 }, { checkpoint: async () => {}, ...RO })
    expect(r.success).toBe(true)
  })
})

describe('S8 审批门 fail-closed', () => {
  it('approval 门无服务且 required 默认 → 抛错（fail-closed）', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx)
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addApprovalGate('gate', { toolName: 'x' }) // required 默认 true
    g.addEdge('a', 'gate')
    const r = await g.run({ messages: [], retry_count: 0 }, { checkpoint: async () => {}, ...RO })
    expect(r.success).toBe(false)
    expect(r.error?.message).toContain('需要 ctx.approval 服务')
  })

  it('approval 门 required:false → 静默跳过', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx)
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addApprovalGate('gate', { toolName: 'x', required: false })
    g.addEdge('a', 'gate')
    const r = await g.run({ messages: [], retry_count: 0 }, { checkpoint: async () => {}, ...RO })
    expect(r.success).toBe(true)
  })
})

describe('S12 原型污染防护', () => {
  it('patch 含 __proto__ 键不污染结果对象原型', () => {
    const patch = JSON.parse('{"__proto__": {"polluted": true}, "messages": ["x"]}') as Record<string, unknown>
    const r = mergeState({ messages: [] }, patch as never)
    expect(r.success).toBe(true)
    const state = r.state as Record<string, unknown>
    expect((state as unknown as { polluted?: boolean }).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('S13 node-end 携带 token/retry 数据', () => {
  it('reportTokenUsage/reportRetry 后 node-end 事件携带数据', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx)
    g.addNode('a', async (_s, nodeCtx) => {
      nodeCtx.reportTokenUsage?.({ input: 100, output: 50, cacheRead: 20 })
      nodeCtx.reportRetry?.(2)
      return { messages: ['a'] }
    })
    const r = await g.run({ messages: [], retry_count: 0 }, { checkpoint: async () => {}, ...RO })
    const endEvent = r.trajectory.find((e) => e.type === 'graph/node-end')
    expect(endEvent?.data?.inputTokens).toBe(100)
    expect(endEvent?.data?.outputTokens).toBe(50)
    expect(endEvent?.data?.cacheReadTokens).toBe(20)
    expect(endEvent?.data?.tokenUsed).toBe(150)
    expect(endEvent?.data?.retryCount).toBe(2)
  })
})

describe('M1 artifacts 深合并', () => {
  it('嵌套对象递归合并', () => {
    const r = mergeState(
      { artifacts: { meta: { author: 'a', version: 1 } } },
      { artifacts: { meta: { version: 2, note: 'x' } } },
    )
    expect(r.success).toBe(true)
    expect(r.state?.artifacts).toEqual({ meta: { author: 'a', version: 2, note: 'x' } })
  })
})

describe('S6 条件边 maxIter 缺省全局上限', () => {
  it('条件边形成环时被全局 maxIterations 熔断', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx, 5, 8) // maxIterations=5
    g.addNode('a', async () => ({ retry_count: 1 }))
    g.addNode('b', async () => ({ retry_count: 1 }))
    // a→b, b→a 条件环（maxIter 未传 → 默认全局 5）
    g.addConditionalEdge('a', async () => 'b')
    g.addConditionalEdge('b', async () => 'a')
    const r = await g.run({ messages: [], retry_count: 0 }, { checkpoint: async () => {}, ...RO })
    expect(r.success).toBe(false)
    expect(r.error?.message).toContain('迭代次数超过上限')
  })

  it('条件边返回 END 正常终止', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx, 5, 8)
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addConditionalEdge('a', async () => END)
    const r = await g.run({ messages: [], retry_count: 0 }, { checkpoint: async () => {}, ...RO })
    expect(r.success).toBe(true)
  })
})
