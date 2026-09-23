/**
 * spec-registry 单测（MVP-4 P4.A.4）。
 *
 * 覆盖：注册/读取/覆盖/注销/列表倒序。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { registerGraph, getGraph, unregisterGraph, listGraphs } from '../../src/l4-visual/host/spec-registry'
import type { GraphDefinitionSpec } from '../../src/l2-engine/types'

function makeSpec(id: string): GraphDefinitionSpec {
  return {
    version: '1', graphVersion: '0.1.0', graphSchemaHash: 'h',
    entryPoint: 'a',
    nodes: [{ id: 'a', nodeType: 'role', roleRef: 'R1' }],
    edges: [],
    checkpoint: { strategy: 'node-level', storage: 'fs' },
    metadata: { source: 'yaml', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  } as GraphDefinitionSpec
}

describe('P4.A.4 规格注册表', () => {
  beforeEach(() => {
    // 模块级 registry 跨测试共享，逐例清理
    for (const id of listGraphs()) unregisterGraph(id)
  })

  it('注册后可读取', () => {
    registerGraph('g1', { spec: makeSpec('g1'), roleMap: { a: 'R1' }, artifactsRoot: 'D:/out' })
    const entry = getGraph('g1')
    expect(entry?.roleMap.a).toBe('R1')
    expect(entry?.artifactsRoot).toBe('D:/out')
  })

  it('同 graphId 覆盖旧条目（单图模式）', () => {
    registerGraph('g1', { spec: makeSpec('g1'), roleMap: { a: 'OLD' }, artifactsRoot: 'D:/a' })
    registerGraph('g1', { spec: makeSpec('g1'), roleMap: { a: 'NEW' }, artifactsRoot: 'D:/b' })
    expect(getGraph('g1')?.roleMap.a).toBe('NEW')
  })

  it('注销后不可读；列表倒序', () => {
    registerGraph('ga', { spec: makeSpec('ga'), roleMap: {}, artifactsRoot: 'D:/a' })
    registerGraph('gb', { spec: makeSpec('gb'), roleMap: {}, artifactsRoot: 'D:/b' })
    expect(listGraphs()).toEqual(['gb', 'ga'])
    unregisterGraph('ga')
    expect(getGraph('ga')).toBeUndefined()
    expect(listGraphs()).toEqual(['gb'])
  })
})
