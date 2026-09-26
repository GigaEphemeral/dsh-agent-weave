/**
 * ui修复2：effectiveRole 合并 + canvas-model cond/loop/override 单测。
 *
 * 覆盖方案 §3.3 / §七验收：
 * - effectiveRole：能力/工具只能减不能加；produces 三态（undefined 继承 / [] 清空 / [...] 覆盖）
 * - layoutNodes：cond/loop 边不参与分层（seq 才分层）
 * - buildGraphSpec：边带 when/maxIter；节点带 override
 */
import { describe, expect, it } from 'vitest'
import { effectiveRole, type NodeOverrideInput } from '../../src/l4-visual/host/effective-role'
import { buildGraphSpec, layoutNodes, type EditorEdge, type EditorNode } from '../../src/client/dashboard/canvas-model'
import type { RoleDefinition } from '../../src/shared/types'

const baseRole: RoleDefinition = {
  schema_version: '1.0',
  id: 'R6-developer',
  name: '开发者',
  system_prompt_ref: 'R6/SKILL.md',
  traits: [],
  capabilities: ['read', 'analyze', 'write-code'],
  tools: ['read', 'grep', 'write'],
  model: { provider: 'acme', model: 'm1' },
  memory_scope: 'private',
  lifecycle: 'on-demand',
  max_concurrent_children: 1,
  capability: { allow_delegation: false, max_depth: 1, allowed_children: [], allow_shell: true, allow_write: true },
  quality_gate: [],
  token_budget: 2000,
  handoff: { upstream: [], downstream: [], edge_type: 'seq' },
}

describe('effectiveRole（ui修复2 §3.3）', () => {
  it('无 override → 完全继承角色', () => {
    const eff = effectiveRole(baseRole, {})
    expect(eff.capabilities).toEqual(baseRole.capabilities)
    expect(eff.tools).toEqual(baseRole.tools)
  })

  it('能力/工具只能减不能加：交集过滤', () => {
    const eff = effectiveRole(baseRole, {
      capabilities: ['read', 'spawn'],           // spawn 角色没有 → 被过滤
      tools: ['grep', 'pwsh'],                   // pwsh 角色没有 → 被过滤
    })
    expect(eff.capabilities).toEqual(['read'])
    expect(eff.tools).toEqual(['grep'])
  })

  it('produces 三态：undefined 继承 / [] 清空 / [...] 覆盖', () => {
    // 继承
    const inherit = effectiveRole(baseRole, {})
    expect(inherit.produces).toBeUndefined()

    // 显式清空
    const cleared = effectiveRole(baseRole, { produces: [] })
    expect(cleared.produces).toEqual([])

    // 覆盖
    const overridden = effectiveRole(baseRole, { produces: [{ kind: 'code', name: 'main.py' }] })
    expect(overridden.produces).toEqual([{ kind: 'code', name: 'main.py' }])
  })

  it('inputGate 覆盖 role.input.requires', () => {
    const eff = effectiveRole(baseRole, { inputGate: ['node-a'] })
    expect(eff.input?.requires).toEqual(['node-a'])
    expect(eff.input?.consumes).toEqual([])
  })
})

describe('layoutNodes / buildGraphSpec（ui修复2 §P0）', () => {
  const nodes: EditorNode[] = [
    { id: 'a', roleRef: 'R1', roleName: 'A', x: 0, y: 0 },
    { id: 'b', roleRef: 'R2', roleName: 'B', x: 0, y: 0 },
  ]

  it('seq 边分层；cond/loop 边不参与分层（保持原位置）', () => {
    const seqEdges: EditorEdge[] = [{ id: 'e1', from: 'a', to: 'b', type: 'seq' }]
    const laid = layoutNodes(nodes, seqEdges)
    expect(laid.find((n) => n.id === 'b')?.x).toBeGreaterThan(laid.find((n) => n.id === 'a')?.x ?? 0)

    // 只有 cond/loop 边 → 不重排（保持 x=0）
    const condEdges: EditorEdge[] = [{ id: 'e2', from: 'a', to: 'b', type: 'loop', maxIter: 3 }]
    const laidCond = layoutNodes(nodes, condEdges)
    expect(laidCond.every((n) => n.x === 0)).toBe(true)
  })

  it('buildGraphSpec：边带 when/maxIter，节点带 override', () => {
    const edges: EditorEdge[] = [
      { id: 'e1', from: 'a', to: 'b', type: 'cond', when: 'x > 1' },
      { id: 'e2', from: 'b', to: 'a', type: 'loop', maxIter: 3 },
    ]
    const nodeWithOverride: EditorNode = { ...nodes[0]!, override: { capabilities: ['read'], tools: [] } }
    const spec = buildGraphSpec([nodeWithOverride, nodes[1]!], edges)
    expect(spec.edges[0]).toMatchObject({ from: 'a', to: 'b', type: 'cond', when: 'x > 1' })
    expect(spec.edges[1]).toMatchObject({ type: 'loop', maxIter: 3 })
    expect(spec.nodes[0]?.override).toEqual({ capabilities: ['read'], tools: [] })
  })
})

// 类型复用（避免未使用告警）
void (null as unknown as NodeOverrideInput)
