/**
 * graph-service.ts 单测（MVP-2 T10 Exit Gate：3 用例全绿）。
 *
 * 覆盖：Service 子类 + ctx.graph 可访问 / create() 返回 StateGraph /
 * fromDefinition() 从图定义创建 + 校验失败抛 GraphValidationError。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GraphEngineService } from '../../src/l2-engine/graph-service'
import { GraphValidationError } from '../../src/l2-engine/graph-definition'

async function mounted() {
  const ctx = new Context()
  await ctx.plugin(GraphEngineService, {
    defaultMaxIterations: 25,
    logTrajectory: true,
    maxConcurrentChildren: 8,
  })
  return ctx
}

const validSpec = {
  version: '1.0',
  graphVersion: '0.1.0',
  graphSchemaHash: 'a1b2c3d4e5f6',
  entryPoint: 'dev',
  maxIterations: 25,
  nodes: [
    { id: 'dev', roleRef: 'R6-developer', nodeType: 'role' },
    { id: 'test', roleRef: 'R7-tester', nodeType: 'role' },
  ],
  edges: [{ from: 'dev', to: 'test', type: 'seq' }],
  checkpoint: { strategy: 'node-level', storage: 'fs' },
  metadata: { source: 'yaml', createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' },
}

describe('T10 ctx.graph 服务', () => {
  it('GraphEngineService 是 Service 子类且 ctx.graph 可访问', async () => {
    const ctx = await mounted()
    expect(ctx.graph).toBeInstanceOf(GraphEngineService)
    expect(ctx.graph.name).toBe('graph')
  })

  it('create() 返回 StateGraph 实例且可执行', async () => {
    const ctx = await mounted()
    const graph = ctx.graph.create<{ messages: string[] }>()
    graph.addNode('a', async () => ({ messages: ['a'] }))
    const result = await graph.run({ messages: [] }, { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' })
    expect(result.success).toBe(true)
    expect(result.finalState.messages).toEqual(['a'])
  })

  it('fromDefinition() 从图定义创建 + schemaHash；非法图抛 GraphValidationError', async () => {
    const ctx = await mounted()
    // 从定义创建：用无角色依赖的节点（roleRef 需真实角色注册，属集成场景）
    const graph = ctx.graph.fromDefinition<{ messages: string[] }>({
      ...validSpec,
      nodes: [
        { id: 'dev', nodeType: 'condition' },
        { id: 'test', nodeType: 'approval' },
      ],
      edges: [{ from: 'dev', to: 'test', type: 'seq' }],
    })
    const result = await graph.run({ messages: [] }, { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' })
    expect(result.success).toBe(true)

    const hash = ctx.graph.schemaHash(validSpec)
    expect(hash).toMatch(/^[0-9a-f]{12}$/)

    // 非法图：entryPoint 指向不存在节点
    const bad = { ...validSpec, entryPoint: 'ghost' }
    expect(() => ctx.graph.fromDefinition(bad)).toThrow(GraphValidationError)
  })
})
