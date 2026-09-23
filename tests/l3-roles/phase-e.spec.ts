/**
 * MVP-3 Phase E 验证：角色包/流程包加载 + 重启复用。
 * 零 LLM。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadWorkflowPackage, validateWorkflowPackage, isRolePackageCompatible } from '../../src/l3-roles/workflow-package'
import { createRestartManager } from '../../src/l2-engine/restart'

const validYaml = `version: '1.0'
graphVersion: '0.1.0'
graphSchemaHash: 'x'
entryPoint: dev
nodes:
  - { id: dev, nodeType: condition }
edges:
  - { from: dev, to: dev, type: loop, maxIter: 2 }
checkpoint: { strategy: node-level, storage: fs }
metadata: { source: yaml, createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' }
`

describe('P3.E.1/P3.E.2 角色/流程包', () => {
  it('流程包加载 + hash 计算 + 静态验证', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-pkg-'))
    const file = join(dir, 'flow.yaml')
    writeFileSync(file, validYaml, 'utf8')
    try {
      const pkg = loadWorkflowPackage(file)
      expect(pkg.schemaHash).toMatch(/^[0-9a-f]{12}$/)
      const v = validateWorkflowPackage(pkg, new Set())
      expect(v.valid).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('流程包 hash 不一致抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-pkg-'))
    const file = join(dir, 'bad.yaml')
    writeFileSync(file, validYaml.replace("graphSchemaHash: ''", "graphSchemaHash: 'wrong'"), 'utf8')
    try {
      expect(() => loadWorkflowPackage(file)).toThrow(/不一致/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('角色包兼容性判断', () => {
    expect(isRolePackageCompatible({ role: { schema_version: '1.0' } as never, schemaVersions: ['1.0'] })).toBe(true)
    expect(isRolePackageCompatible({ role: { schema_version: '2.0' } as never, schemaVersions: ['2.0'] })).toBe(false)
  })
})

describe('P3.E.3 重启与目标复用', () => {
  it('后台任务注册/状态 + 目标复用', async () => {
    const mgr = createRestartManager({ get: () => undefined })
    const id = await mgr.startJob('test', async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(mgr.jobStatus(id)).toBe('running')
    await new Promise((r) => setTimeout(r, 30))
    expect(mgr.jobStatus(id)).toBe('done')

    const g1 = await mgr.ensureGoal('make-etf', '做 ETF 工具')
    const g2 = await mgr.ensureGoal('make-etf', '做 ETF 工具')
    expect(g1.reused).toBe(false)
    expect(g2.reused).toBe(true)
    expect(g2.id).toBe(g1.id)
    await mgr.completeGoal(g1.id)
    const g3 = await mgr.ensureGoal('make-etf', '做 ETF 工具')
    expect(g3.reused).toBe(false)
  })
})
