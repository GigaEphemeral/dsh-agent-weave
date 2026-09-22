/**
 * static-validator.ts 单测（MVP-2 T3 Exit Gate：8 用例全绿 + 性能达标）。
 *
 * 覆盖：5 项检查（roleRef 注册/条件字段白名单/入口可达/环检测/自环）
 * + 3 边界（loop 环合法、非 loop 环检测、100 节点性能 < 10ms）。
 */
import { describe, expect, it } from 'vitest'
import { detectCycles, validateGraph } from '../../src/l2-engine/static-validator'
import type { GraphDefinitionSpec } from '../../src/l2-engine/types'

/** 构造合法图定义。 */
function validSpec(overrides: Partial<GraphDefinitionSpec> = {}): GraphDefinitionSpec {
  return {
    version: '1.0',
    graphVersion: '0.1.0',
    graphSchemaHash: 'a1b2c3d4e5f6',
    entryPoint: 'dev',
    maxIterations: 25,
    nodes: [
      { id: 'dev', roleRef: 'R6-developer', nodeType: 'role' },
      { id: 'test', roleRef: 'R7-tester', nodeType: 'role' },
      { id: 'quality', roleRef: 'R8-quality', nodeType: 'role' },
    ],
    edges: [
      { from: 'dev', to: 'test', type: 'seq' },
      { from: 'test', to: 'quality', type: 'seq' },
    ],
    checkpoint: { strategy: 'node-level', storage: 'fs' },
    metadata: { source: 'yaml', createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' },
    ...overrides,
  }
}

const fullRoles = new Set(['R6-developer', 'R7-tester', 'R8-quality'])

describe('T3 静态验证器', () => {
  it('合法图通过全部 5 项检查', () => {
    const result = validateGraph(validSpec(), { registeredRoles: fullRoles })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('roleRef 未注册时拒绝（检查①）', () => {
    const spec = validSpec()
    spec.nodes[0] = { id: 'dev', roleRef: 'R99-unknown', nodeType: 'role' }
    const result = validateGraph(spec, { registeredRoles: fullRoles })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes('角色未注册'))).toBe(true)
    expect(result.errors[0]?.path).toContain('nodes.dev.roleRef')
  })

  it('cond 边引用未知状态字段时拒绝（检查②）', () => {
    const spec = validSpec()
    spec.edges = [
      { from: 'dev', to: 'test', type: 'seq' },
      { from: 'test', to: 'quality', type: 'cond', when: 'state.unknown_field >= 3' },
    ]
    const result = validateGraph(spec, { registeredRoles: fullRoles })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes('未知状态字段: unknown_field'))).toBe(true)
  })

  it('cond 边引用白名单字段时通过（检查②正例）', () => {
    const spec = validSpec()
    spec.edges = [
      { from: 'dev', to: 'test', type: 'seq' },
      { from: 'test', to: 'quality', type: 'cond', when: 'state.retry_count >= 3' },
    ]
    const result = validateGraph(spec, { registeredRoles: fullRoles })
    expect(result.valid).toBe(true)
  })

  it('不可达节点被标记（检查③）', () => {
    const spec = validSpec()
    spec.nodes = [
      { id: 'dev', roleRef: 'R6-developer', nodeType: 'role' },
      { id: 'orphan', roleRef: 'R7-tester', nodeType: 'role' },
    ]
    const result = validateGraph(spec, { registeredRoles: fullRoles })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path === 'nodes.orphan')).toBe(true)
  })

  it('非 loop 环被检测（检查④ Kahn）', () => {
    const spec = validSpec()
    spec.edges = [
      { from: 'dev', to: 'test', type: 'seq' },
      { from: 'test', to: 'quality', type: 'seq' },
      { from: 'quality', to: 'dev', type: 'seq' },
    ]
    const result = validateGraph(spec, { registeredRoles: fullRoles })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes('环'))).toBe(true)
  })

  it('loop 边组成的环合法（边界）', () => {
    const spec = validSpec()
    spec.edges = [
      { from: 'dev', to: 'test', type: 'seq' },
      { from: 'test', to: 'quality', type: 'seq' },
      { from: 'quality', to: 'dev', type: 'loop', maxIter: 3 },
    ]
    const result = validateGraph(spec, { registeredRoles: fullRoles })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('detectCycles 直接验证：非 loop 环返回环内节点', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const edges = [
      { from: 'a', to: 'b', type: 'seq' },
      { from: 'b', to: 'c', type: 'seq' },
      { from: 'c', to: 'a', type: 'seq' },
    ]
    const result = detectCycles(nodes, edges)
    expect(result.hasCycle).toBe(true)
    expect(result.cycleNodes.sort()).toEqual(['a', 'b', 'c'])
  })

  it('100 节点图性能 < 10ms（检查⑧）', () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({
      id: `node${i}`,
      roleRef: 'R6-developer',
      nodeType: 'role' as const,
    }))
    const edges = Array.from({ length: 99 }, (_, i) => ({
      from: `node${i}`,
      to: `node${i + 1}`,
      type: 'seq' as const,
    }))
    const spec = validSpec({
      entryPoint: 'node0',
      nodes,
      edges,
    })
    const start = performance.now()
    const result = validateGraph(spec, { registeredRoles: new Set(['R6-developer']) })
    const elapsed = performance.now() - start
    expect(result.valid).toBe(true)
    expect(elapsed).toBeLessThan(10)
  })
})
