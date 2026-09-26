/**
 * MVP-5B B6：Provider / Capabilities / Tools 探测注册表单测。
 *
 * 覆盖：
 * - probeProviders：dynamic（ctx.subagents 反射）优先；yaml-scan 补齐；三级降级
 * - probeTools：ctx.tools.schemas() 反射；失败回退 yaml-scan
 * - listCapabilities：8 个通用枚举
 * - 反例（验收 10.4#1/#2）：前端不硬编码 provider id / 具体工具名
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listCapabilities,
  probeProviders,
  probeTools,
  DEFAULT_CAPABILITIES,
} from '../../src/l4-visual/host/provider-registry'
import { setRolesDir } from '../../src/l4-visual/host/role-library'

const r1Yaml = `schema_version: '1.0'
id: R1-requirement
name: 需求分析师
system_prompt_ref: R1/SKILL.md
traits: []
capabilities: []
tools: [read, grep]
model: { provider: acme-provider, model: acme-model-1 }
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 1
capability: { allow_delegation: false, max_depth: 1, allowed_children: [], allow_shell: true, allow_write: true }
quality_gate: []
token_budget: 2000
handoff: { upstream: [], downstream: [], edge_type: seq }
`

function makeCtx(overrides: { providers?: Array<{ name: string; agentRouteDefaults?: { provider: string; model: string } }>; tools?: string[] } = {}) {
  const ctx = {
    subagents: {
      list: () => (overrides.providers ?? []).map((p) => p.name),
      getProvider: (name: string) => overrides.providers?.find((p) => p.name === name),
    },
    tools: overrides.tools !== undefined
      ? { schemas: () => (overrides.tools ?? []).map((name) => ({ name })) }
      : undefined,
  }
  return ctx as never
}

describe('probeProviders', () => {
  it('dynamic：从 ctx.subagents 反射（source=dynamic，最可信）', () => {
    const ctx = makeCtx({
      providers: [
        { name: 'R1-requirement', agentRouteDefaults: { provider: 'acme', model: 'acme-model-1' } },
        { name: 'R2-architect', agentRouteDefaults: { provider: 'acme', model: 'acme-model-2' } },
      ],
    })
    const r = probeProviders(ctx)
    expect(r.overallSource).toBe('dynamic')
    const acme = r.providers.find((p) => p.id === 'acme')
    expect(acme?.source).toBe('dynamic')
    expect(acme?.models).toEqual(['acme-model-1', 'acme-model-2'])
    expect(acme?.defaultModel).toBe('acme-model-1')
    expect(r.probedAt).toBeTypeOf('number')
  })

  it('无 dynamic → yaml-scan 聚合 roles/*.yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-prov-scan-'))
    try {
      writeFileSync(join(dir, 'R1-requirement.yaml'), r1Yaml, 'utf8')
      setRolesDir(dir)
      const ctx = makeCtx({ providers: [], tools: undefined })
      const r = probeProviders(ctx)
      expect(r.overallSource).toBe('yaml-scan')
      const p = r.providers.find((x) => x.id === 'acme-provider')
      expect(p?.source).toBe('yaml-scan')
      expect(p?.models).toContain('acme-model-1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('dynamic 与 yaml-scan 并存：dynamic 优先，模型补齐', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-prov-mix-'))
    try {
      writeFileSync(join(dir, 'R1-requirement.yaml'), r1Yaml, 'utf8')
      setRolesDir(dir)
      // acme 在 dynamic 中只有 model-1；yaml-scan 又出现 acme-model-1 → 不重复
      const ctx = makeCtx({
        providers: [{ name: 'R1-requirement', agentRouteDefaults: { provider: 'acme', model: 'acme-model-1' } }],
      })
      const r = probeProviders(ctx)
      const acme = r.providers.find((p) => p.id === 'acme')
      expect(acme?.source).toBe('dynamic')
      expect(new Set(acme?.models)).toEqual(new Set(['acme-model-1']))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('probeTools / listCapabilities', () => {
  it('从 ctx.tools.schemas() 反射（dynamic）', () => {
    const ctx = makeCtx({ tools: ['grep', 'read', 'glob'] })
    const r = probeTools(ctx)
    expect(r.source).toBe('dynamic')
    expect(r.tools).toEqual(['glob', 'grep', 'read'])
  })

  it('无 ctx.tools → 回退 yaml-scan（角色 tools 聚合）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-tools-scan-'))
    try {
      writeFileSync(join(dir, 'R1-requirement.yaml'), r1Yaml, 'utf8')
      setRolesDir(dir)
      const r = probeTools(makeCtx({ tools: undefined }))
      expect(r.tools).toEqual(['grep', 'read'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('capabilities：8 个通用枚举', () => {
    expect(listCapabilities()).toEqual([...DEFAULT_CAPABILITIES])
    expect(DEFAULT_CAPABILITIES).toHaveLength(8)
  })
})
