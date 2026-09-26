/**
 * MVP-5 Phase 0：Output Gate + 图级约束（SOP 顺序/独立验证）+ 错误分类映射。
 */
import { describe, expect, it } from 'vitest'
import { checkOutputGate } from '../../src/l2-engine/output-gate'
import { validateGraph, validateGraphConstraints, canReach } from '../../src/l2-engine/static-validator'
import { classifyError } from '../../src/l2-engine/error-classifier'
import type { GraphDefinitionSpec } from '../../src/l2-engine/types'

function spec(overrides: Partial<GraphDefinitionSpec> = {}): GraphDefinitionSpec {
  return {
    version: '1.0',
    graphVersion: '0.1.0',
    graphSchemaHash: 'abc',
    entryPoint: 'requirement',
    nodes: [
      { id: 'requirement', roleRef: 'R1-requirement', nodeType: 'role' },
      { id: 'architecture', roleRef: 'R2-architect', nodeType: 'role' },
      { id: 'design', roleRef: 'R4-designer', nodeType: 'role' },
      { id: 'develop', roleRef: 'R6-developer', nodeType: 'role' },
      { id: 'test', roleRef: 'R7-tester', nodeType: 'role' },
      { id: 'quality', roleRef: 'R8-quality', nodeType: 'role' },
    ],
    edges: [
      { from: 'requirement', to: 'architecture', type: 'seq' },
      { from: 'architecture', to: 'design', type: 'seq' },
      { from: 'design', to: 'develop', type: 'seq' },
      { from: 'develop', to: 'test', type: 'seq' },
      { from: 'test', to: 'quality', type: 'seq' },
    ],
    checkpoint: { strategy: 'node-level', storage: 'fs' },
    metadata: { source: 'yaml', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' },
    ...overrides,
  }
}

const allRoles = new Set(['R1-requirement', 'R2-architect', 'R4-designer', 'R6-developer', 'R7-tester', 'R8-quality'])

describe('Output Gate（问题 1/3）', () => {
  it('设计评审类角色产出 .md 通过', () => {
    const r = checkOutputGate(
      { only_markdown: true, forbidden_extensions: ['.py', '.ts'] },
      'graph-artifacts/requirement/requirement.md',
      '# 需求文档',
    )
    expect(r.passed).toBe(true)
  })

  it('R1 越界产出 .py → 失败', () => {
    const r = checkOutputGate(
      { only_markdown: true, forbidden_extensions: ['.py', '.ts', '.bat'] },
      'graph-artifacts/requirement/app.py',
      'print(1)',
    )
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.includes('.py'))).toBe(true)
  })

  it('产物正文出现 pip install → 失败（降级特征拦截）', () => {
    const r = checkOutputGate(
      { forbidden_content_patterns: ['pip install'] },
      'a.md',
      '需要运行 pip install fastapi',
    )
    expect(r.passed).toBe(false)
  })

  it('未配置 gate 直接通过', () => {
    expect(checkOutputGate(undefined, 'a.py', 'code').passed).toBe(true)
  })
})

describe('图级约束（问题 3）', () => {
  it('required_phases 按 SOP 顺序通过', () => {
    const s = spec({ constraints: { required_phases: ['requirement', 'architecture', 'design', 'develop', 'test', 'quality'] } })
    const r = validateGraph(s, { registeredRoles: allRoles })
    expect(r.valid).toBe(true)
  })

  it('required_phases 乱序 → 校验失败', () => {
    const s = spec({ constraints: { required_phases: ['develop', 'requirement', 'test'] } })
    const r = validateGraph(s, { registeredRoles: allRoles })
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.message.includes('SOP 顺序违规'))).toBe(true)
  })

  it('required_phases 引用不存在节点 → 校验失败', () => {
    const s = spec({ constraints: { required_phases: ['requirement', 'ghost'] } })
    const errors = validateGraphConstraints(s)
    expect(errors.some((e) => e.message.includes('不存在的节点'))).toBe(true)
  })

  it('独立验证：test/quality 与 develop 重合 → 校验失败', () => {
    const s = spec({ constraints: { independent_verification: { test_node: 'develop', quality_node: 'quality', must_be_independent_from: ['develop'] } } })
    const errors = validateGraphConstraints(s)
    expect(errors.some((e) => e.message.includes('不能与开发节点重合'))).toBe(true)
  })

  it('独立验证：test_node 与 quality_node 相同 → 校验失败', () => {
    const s = spec({ constraints: { independent_verification: { test_node: 'test', quality_node: 'test' } } })
    const errors = validateGraphConstraints(s)
    expect(errors.some((e) => e.message.includes('不同节点'))).toBe(true)
  })

  it('独立验证合法配置通过', () => {
    const s = spec({ constraints: { independent_verification: { test_node: 'test', quality_node: 'quality', must_be_independent_from: ['develop'] } } })
    expect(validateGraph(s, { registeredRoles: allRoles }).valid).toBe(true)
  })

  it('canReach 判断有向路径', () => {
    expect(canReach('requirement', 'quality', [{ from: 'requirement', to: 'architecture', type: 'seq' }, { from: 'architecture', to: 'quality', type: 'seq' }])).toBe(true)
    expect(canReach('quality', 'requirement', [{ from: 'requirement', to: 'architecture', type: 'seq' }, { from: 'architecture', to: 'quality', type: 'seq' }])).toBe(false)
  })
})

describe('错误分类映射（问题 2/1）', () => {
  it('环境门禁 → environment-gate 暂停', () => {
    const c = classifyError(new Error('环境门禁未过（R6-developer）: python --version 退出码 1 — 环境不满足'))
    expect(c.reason).toBe('environment-gate')
    expect(c.needsUserIntervention).toBe(true)
  })

  it('输出门禁 → permission-denied 暂停', () => {
    const c = classifyError(new Error('输出门禁未过（R1-requirement）: 禁止产出 .py 文件'))
    expect(c.reason).toBe('permission-denied')
    expect(c.needsUserIntervention).toBe(true)
  })
})
