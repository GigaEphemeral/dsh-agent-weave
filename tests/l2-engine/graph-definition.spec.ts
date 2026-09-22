/**
 * graph-definition.ts 单测（MVP-2 T2 Exit Gate：10 用例全绿）。
 *
 * 覆盖：合法 YAML 通过 / 6 条 refine（entryPoint 缺失、边引用缺失、ID 重复、
 * cond 缺 when、loop 缺 maxIter、自环非 loop）/ ID 正则 / schema hash 确定性。
 */
import { describe, expect, it } from 'vitest'
import {
  computeGraphSchemaHash,
  GraphValidationError,
  parseGraphDefinition,
  parseGraphDefinitionYaml,
} from '../../src/l2-engine/graph-definition'
import type { GraphDefinitionSpec } from '../../src/l2-engine/types'

/** 构造合法图定义（可覆盖字段）。 */
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
    ],
    edges: [{ from: 'dev', to: 'test', type: 'seq' }],
    checkpoint: { strategy: 'node-level', storage: 'fs' },
    metadata: { source: 'yaml', createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' },
    ...overrides,
  }
}

describe('T2 图 DSL Schema', () => {
  it('合法图定义通过校验', () => {
    const spec = parseGraphDefinition(validSpec())
    expect(spec.entryPoint).toBe('dev')
    expect(spec.nodes).toHaveLength(2)
    expect(spec.edges).toHaveLength(1)
  })

  it('非法 YAML 被拒绝（YAML 语法错误，含路径）', () => {
    expect(() => parseGraphDefinitionYaml('nodes: [unclosed', 'bad.yaml')).toThrow(GraphValidationError)
    try {
      parseGraphDefinitionYaml('nodes: [unclosed', 'bad.yaml')
    } catch (e) {
      const err = e as GraphValidationError
      expect(err.issues[0]?.path).toBe('$')
    }
  })

  it('entryPoint 不存在时拒绝（refine ①）', () => {
    expect(() => parseGraphDefinition(validSpec({ entryPoint: 'ghost' }))).toThrow(GraphValidationError)
    try {
      parseGraphDefinition(validSpec({ entryPoint: 'ghost' }))
    } catch (e) {
      const err = e as GraphValidationError
      expect(err.issues.some((i) => i.message.includes('entryPoint 必须指向已定义的节点'))).toBe(true)
    }
  })

  it('边引用不存在的节点时拒绝（refine ②）', () => {
    const spec = validSpec()
    spec.edges = [{ from: 'dev', to: 'ghost', type: 'seq' }]
    expect(() => parseGraphDefinition(spec)).toThrow(GraphValidationError)
    try {
      parseGraphDefinition(spec)
    } catch (e) {
      const err = e as GraphValidationError
      expect(err.issues.some((i) => i.message.includes('from/to 必须指向已定义的节点'))).toBe(true)
    }
  })

  it('节点 ID 重复时拒绝（refine ③）', () => {
    const spec = validSpec()
    spec.nodes = [
      { id: 'dev', roleRef: 'R6', nodeType: 'role' },
      { id: 'dev', roleRef: 'R7', nodeType: 'role' },
    ]
    expect(() => parseGraphDefinition(spec)).toThrow(GraphValidationError)
    try {
      parseGraphDefinition(spec)
    } catch (e) {
      const err = e as GraphValidationError
      expect(err.issues.some((i) => i.message.includes('节点 ID 必须唯一'))).toBe(true)
    }
  })

  it('cond 边缺 when 时拒绝（refine ④）', () => {
    const spec = validSpec()
    spec.edges = [{ from: 'dev', to: 'test', type: 'cond' }]
    expect(() => parseGraphDefinition(spec)).toThrow(GraphValidationError)
    try {
      parseGraphDefinition(spec)
    } catch (e) {
      const err = e as GraphValidationError
      expect(err.issues.some((i) => i.message.includes('cond 边必须有 when 字段'))).toBe(true)
    }
  })

  it('loop 边缺 maxIter 时拒绝（refine ⑤）', () => {
    const spec = validSpec()
    spec.edges = [{ from: 'test', to: 'dev', type: 'loop' }]
    expect(() => parseGraphDefinition(spec)).toThrow(GraphValidationError)
    try {
      parseGraphDefinition(spec)
    } catch (e) {
      const err = e as GraphValidationError
      expect(err.issues.some((i) => i.message.includes('loop 边必须有 maxIter 字段'))).toBe(true)
    }
  })

  it('自环边只允许 loop 类型（refine ⑥）', () => {
    const spec = validSpec()
    spec.edges = [{ from: 'dev', to: 'dev', type: 'seq' }]
    expect(() => parseGraphDefinition(spec)).toThrow(GraphValidationError)
    try {
      parseGraphDefinition(spec)
    } catch (e) {
      const err = e as GraphValidationError
      expect(err.issues.some((i) => i.message.includes('自环边只允许 loop 类型'))).toBe(true)
    }
  })

  it('loop 自环边合法', () => {
    const spec = validSpec()
    spec.edges = [
      { from: 'dev', to: 'test', type: 'seq' },
      { from: 'test', to: 'dev', type: 'loop', maxIter: 3 },
    ]
    const parsed = parseGraphDefinition(spec)
    expect(parsed.edges[1]?.maxIter).toBe(3)
  })

  it('节点 ID 不匹配正则时拒绝', () => {
    const spec = validSpec()
    spec.nodes = [{ id: 'Dev-1', roleRef: 'R6', nodeType: 'role' }]
    expect(() => parseGraphDefinition(spec)).toThrow(GraphValidationError)
    try {
      parseGraphDefinition(spec)
    } catch (e) {
      const err = e as GraphValidationError
      expect(err.issues.some((i) => i.message.includes('节点 ID 必须匹配'))).toBe(true)
    }
  })

  it('computeGraphSchemaHash 确定性且随内容变化', () => {
    const a = computeGraphSchemaHash(validSpec())
    const b = computeGraphSchemaHash(validSpec())
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)

    const changed = validSpec({ maxIterations: 30 })
    expect(computeGraphSchemaHash(changed)).not.toBe(a)
  })
})
