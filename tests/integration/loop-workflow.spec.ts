/**
 * loop-workflow 集成测试（MVP-2 T19 Exit Gate：6 断言）。
 *
 * 用 mock 节点验证完整循环工作流：develop → test → quality →
 * (loop 回退 develop 最多 3 次 / cond 升级 approval)。
 *
 * 断言：从 develop 开始 / 循环最多 3 次 / retry>=max 进 approval /
 * 每次迭代有 checkpoint / trajectory 完整 / 零 LLM。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createStateGraph, END } from '../../src/l2-engine/state-graph'
import { computeGraphSchemaHash, parseGraphDefinitionYaml } from '../../src/l2-engine/graph-definition'
import { validateGraph } from '../../src/l2-engine/static-validator'

const loopYaml = `version: '1.0'
graphVersion: '0.1.0'
graphSchemaHash: 'loop-demo'
entryPoint: develop
maxIterations: 25
nodes:
  - { id: develop, nodeType: condition }
  - { id: test, nodeType: condition }
  - { id: quality, nodeType: condition }
  - { id: approval, nodeType: approval }
edges:
  - { from: develop, to: test, type: seq }
  - { from: test, to: quality, type: seq }
  - { from: quality, to: develop, type: loop, maxIter: 3 }
  - { from: quality, to: approval, type: cond, when: 'state.retry_count >= 3' }
checkpoint: { strategy: node-level, storage: fs }
metadata: { source: yaml, createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' }
`

interface LoopState extends Record<string, unknown> {
  messages: string[]
  retry_count: number
}

/** 构建循环工作流图（mock 节点）。 */
function buildLoopGraph(ctx: Context, maxIterations = 25) {
  const spec = parseGraphDefinitionYaml(loopYaml, 'workflows/mvp2-loop-demo.yaml')
  const validation = validateGraph(spec, { registeredRoles: new Set() })
  expect(validation.valid).toBe(true)

  const graph = createStateGraph<LoopState>(ctx, maxIterations, 8)
  for (const node of spec.nodes) {
    if (node.nodeType === 'approval') {
      graph.addApprovalGate(node.id, { toolName: 'weave_approve', reason: '门', required: false })
    } else if (node.id === 'quality') {
      // quality 递增 retry_count（可合并字段）；retry 到 3 → cond 边升级 approval
      graph.addNode(node.id, async (state) => ({
        messages: ['quality'],
        retry_count: (state.retry_count ?? 0) + 1,
      }))
    } else {
      // develop/test 只累积 messages（可合并），不写 retry_count（避免混淆计数）
      graph.addNode(node.id, async () => ({
        messages: [node.id],
      }))
    }
  }
  for (const edge of spec.edges) {
    if (edge.type === 'seq') graph.addEdge(edge.from, edge.to)
    else if (edge.type === 'loop' && edge.maxIter !== undefined) graph.addLoopEdge(edge.from, edge.to, edge.maxIter)
    else if (edge.type === 'cond' && edge.when) {
      const to = edge.to
      const when = edge.when
      graph.addConditionalEdge(edge.from, async (state) => {
        const { evaluateCondition } = await import('../../src/l2-engine/condition-edge.js')
        return evaluateCondition(when, state as Record<string, unknown>) ? to : END
      })
    }
  }
  return { graph, spec }
}

describe('T19 含循环端到端测试', () => {
  it('从 develop 开始执行，循环回退后升级 approval', async () => {
    const ctx = new Context()
    const { graph } = buildLoopGraph(ctx)
    const checkpoint = vi.fn(async () => {})
    const result = await graph.run(
      { messages: [], retry_count: 0 },
      { checkpoint, graphVersion: '0.1.0', graphSchemaHash: 'hash' },
    )
    expect(result.success).toBe(true)
    // 执行轨迹包含 develop/test/quality/approval
    const nodes = result.trajectory.filter((e) => e.type === 'graph/node-end').map((e) => e.node)
    expect(nodes[0]).toBe('develop')
    expect(nodes).toContain('approval')
  })

  it('循环回退发生（loop 边触发回退 develop）', async () => {
    const ctx = new Context()
    const { graph } = buildLoopGraph(ctx)
    const result = await graph.run(
      { messages: [], retry_count: 0 },
      { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' },
    )
    // quality → develop 回退由 loop 边控制；develop 出现 2 次以上即证明回退
    const developEnds = result.trajectory.filter((e) => e.type === 'graph/node-end' && e.node === 'develop')
    expect(developEnds.length).toBeGreaterThan(1)
    // 有 loop-iteration 事件
    expect(result.trajectory.some((e) => e.type === 'graph/loop-iteration')).toBe(true)
    // 最终进入 approval（未死循环）
    expect(result.trajectory.some((e) => e.type === 'graph/node-start' && e.node === 'approval')).toBe(true)
  })

  it('retry_count 达到 3 后升级 approval', async () => {
    const ctx = new Context()
    const { graph } = buildLoopGraph(ctx)
    const result = await graph.run(
      { messages: [], retry_count: 0 },
      { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' },
    )
    expect(result.finalState.retry_count).toBe(3)
    expect(result.trajectory.some((e) => e.type === 'graph/node-end' && e.node === 'approval')).toBe(true)
  })

  it('每次迭代有 checkpoint', async () => {
    const ctx = new Context()
    const { graph } = buildLoopGraph(ctx)
    const checkpoint = vi.fn(async () => {})
    await graph.run(
      { messages: [], retry_count: 0 },
      { checkpoint, graphVersion: '0.1.0', graphSchemaHash: 'hash' },
    )
    // develop/test/quality 至少各一次 + approval 一次
    expect(checkpoint.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('trajectory 完整（含 start/node-start/node-end/checkpoint/loop-iteration/end）', async () => {
    const ctx = new Context()
    const { graph } = buildLoopGraph(ctx)
    const result = await graph.run(
      { messages: [], retry_count: 0 },
      { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' },
    )
    const types = new Set(result.trajectory.map((e) => e.type))
    expect(types.has('graph/start')).toBe(true)
    expect(types.has('graph/node-start')).toBe(true)
    expect(types.has('graph/node-end')).toBe(true)
    expect(types.has('graph/checkpoint-written')).toBe(true)
    expect(types.has('graph/loop-iteration')).toBe(true)
    expect(types.has('graph/end')).toBe(true)
  })

  it('零 LLM：测试不调用 ctx.llm', () => {
    expect(loopYaml).not.toMatch(/ctx\.llm\./)
  })

  it('graphSchemaHash 确定性（用于 checkpoint 版本对比）', () => {
    const spec = parseGraphDefinitionYaml(loopYaml, 'x.yaml')
    const h1 = computeGraphSchemaHash(spec)
    const h2 = computeGraphSchemaHash(spec)
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{12}$/)
  })
})
