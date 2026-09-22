/**
 * cli/graph-commands.ts 单测（MVP-2 T4 Exit Gate：3 用例）。
 *
 * 覆盖纯函数：loadGraphSpec（YAML 解析）、formatValidation（通过/失败输出）、
 * renderAsciiGraph（ASCII 结构含 loop/cond 标注）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { formatValidation, loadGraphSpec, renderAsciiGraph } from '../../src/cli/graph-commands'
import { validateGraph } from '../../src/l2-engine/static-validator'

const loopYaml = `version: '1.0'
graphVersion: '0.1.0'
graphSchemaHash: 'a1b2c3d4e5f6'
entryPoint: develop
maxIterations: 25
nodes:
  - { id: develop, roleRef: R6-developer, nodeType: role }
  - { id: test, roleRef: R7-tester, nodeType: role }
  - { id: quality, roleRef: R8-quality, nodeType: role }
  - { id: approval, nodeType: approval }
edges:
  - { from: develop, to: test, type: seq }
  - { from: test, to: quality, type: seq }
  - { from: quality, to: develop, type: loop, maxIter: 3 }
  - { from: quality, to: approval, type: cond, when: 'state.retry_count >= 3' }
checkpoint: { strategy: node-level, storage: fs }
metadata: { source: yaml, createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' }
`

describe('T4 CLI 图命令', () => {
  it('loadGraphSpec 解析合法 YAML 图', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-cli-'))
    const file = join(dir, 'flow.yaml')
    writeFileSync(file, loopYaml, 'utf8')
    try {
      const spec = loadGraphSpec(file)
      expect(spec.entryPoint).toBe('develop')
      expect(spec.nodes).toHaveLength(4)
      expect(spec.edges).toHaveLength(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('formatValidation 输出通过/失败两种形态', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-cli-'))
    const file = join(dir, 'flow.yaml')
    writeFileSync(file, loopYaml, 'utf8')
    try {
      const spec = loadGraphSpec(file)
      const ok = validateGraph(spec, { registeredRoles: new Set(['R6-developer', 'R7-tester', 'R8-quality']) })
      const passText = formatValidation(file, spec, ok)
      expect(passText).toContain('✅ 图校验通过')
      expect(passText).toContain('graphSchemaHash')

      // 失败形态：缺角色注册
      const bad = validateGraph(spec, { registeredRoles: new Set() })
      const failText = formatValidation(file, spec, bad)
      expect(failText).toContain('❌ 图校验失败')
      expect(failText).toContain('角色未注册')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('renderAsciiGraph 输出含主链、loop/cond 标注与节点详情', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-cli-'))
    const file = join(dir, 'flow.yaml')
    writeFileSync(file, loopYaml, 'utf8')
    try {
      const spec = loadGraphSpec(file)
      const text = renderAsciiGraph(spec)
      expect(text).toContain('[develop]──→[test]──→[quality]')
      expect(text).toContain('loop (maxIter=3)')
      expect(text).toContain('when: state.retry_count >= 3')
      expect(text).toContain('· approval (approval)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
