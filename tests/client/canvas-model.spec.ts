/**
 * MVP-5 Phase C：画布纯模型（布局 + DSL 导出）单测。
 */
import { describe, expect, it } from 'vitest'
import { buildGraphSpec, layoutNodes, type EditorEdge, type EditorNode } from '../../src/client/dashboard/canvas-model'

const nodes: EditorNode[] = [
  { id: 'requirement', roleRef: 'R1-requirement', roleName: '需求分析师', x: 0, y: 0 },
  { id: 'develop', roleRef: 'R6-developer', roleName: '开发者', x: 0, y: 0 },
  { id: 'test', roleRef: 'R7-tester', roleName: '测试员', x: 0, y: 0 },
]
const edges: EditorEdge[] = [
  { id: 'e1', from: 'requirement', to: 'develop', type: 'seq' },
  { id: 'e2', from: 'develop', to: 'test', type: 'seq' },
]

describe('layoutNodes', () => {
  it('按 seq 边分层：requirement 在 x=0，develop 在下一层', () => {
    const laid = layoutNodes(nodes, edges)
    const req = laid.find((n) => n.id === 'requirement')
    const dev = laid.find((n) => n.id === 'develop')
    expect(req?.x).toBe(0)
    expect(dev?.x).toBeGreaterThan(req?.x ?? 0)
  })

  it('孤立节点也获得位置（不崩溃）', () => {
    const laid = layoutNodes([{ id: 'solo', roleRef: 'R6', roleName: 'x', x: 0, y: 0 }], [])
    expect(laid[0]?.x).toBe(0)
  })

  it('ui修复2：cond/loop 边不参与 seq 分层（保持原位置）', () => {
    const condOnly: EditorEdge[] = [{ id: 'c1', from: 'a', to: 'b', type: 'loop', maxIter: 3 }]
    const laid = layoutNodes(nodes, condOnly)
    expect(laid.every((n) => n.x === 0)).toBe(true)
  })
})

describe('buildGraphSpec', () => {
  it('导出 ClientGraphSpec：entryPoint / nodes / seq edges / maxIterations', () => {
    const spec = buildGraphSpec(nodes, edges)
    expect(spec.entryPoint).toBe('requirement')
    expect(spec.nodes).toHaveLength(3)
    expect(spec.nodes[0]).toEqual({ id: 'requirement', roleRef: 'R1-requirement', nodeType: 'role' })
    expect(spec.edges).toEqual([
      { from: 'requirement', to: 'develop', type: 'seq' },
      { from: 'develop', to: 'test', type: 'seq' },
    ])
    expect(spec.maxIterations).toBe(25)
  })

  it('ui修复2：cond/loop 边带 when/maxIter；节点带 override', () => {
    const spec = buildGraphSpec(
      [{ ...nodes[0]!, override: { capabilities: ['read'], tools: [] } }, nodes[1]!, nodes[2]!],
      [{ id: 'c1', from: 'develop', to: 'requirement', type: 'loop', maxIter: 3 }, { id: 'd1', from: 'requirement', to: 'develop', type: 'cond', when: 'x>1' }],
    )
    expect(spec.edges.find((e) => e.type === 'loop')?.maxIter).toBe(3)
    expect(spec.edges.find((e) => e.type === 'cond')?.when).toBe('x>1')
    expect(spec.nodes[0]?.override).toEqual({ capabilities: ['read'], tools: [] })
  })

  it('空画布导出空图（entryPoint 为空串）', () => {
    const spec = buildGraphSpec([], [])
    expect(spec.entryPoint).toBe('')
    expect(spec.nodes).toEqual([])
  })
})
