/**
 * MVP-5 Phase C：画布纯模型（布局 + DSL 导出）单测。
 */
import { describe, expect, it } from 'vitest'
import { buildGraphSpec, layoutNodes, type EditorNode } from '../../src/client/dashboard/canvas-model'

const nodes: EditorNode[] = [
  { id: 'requirement', roleRef: 'R1-requirement', roleName: '需求分析师', x: 0, y: 0 },
  { id: 'develop', roleRef: 'R6-developer', roleName: '开发者', x: 0, y: 0 },
  { id: 'test', roleRef: 'R7-tester', roleName: '测试员', x: 0, y: 0 },
]
const edges = [
  { from: 'requirement', to: 'develop' },
  { from: 'develop', to: 'test' },
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

  it('空画布导出空图（entryPoint 为空串）', () => {
    const spec = buildGraphSpec([], [])
    expect(spec.entryPoint).toBe('')
    expect(spec.nodes).toEqual([])
  })
})
