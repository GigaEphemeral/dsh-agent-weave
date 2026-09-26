/**
 * MVP-5B B6：Provider / Capabilities / Tools 探测注册表单测。
 *
 * 覆盖：
 * - probeProviders：dynamic（ctx.subagents 反射）优先；yaml-scan 补齐；三级降级 + warning
 * - listSubagentTools：固定 subagent 白名单（功能问题1 §2：非主 agent 工具表）
 * - listCapabilities：8 个通用枚举（带 label）
 * - 反例（验收 10.4#1/#2）：前端不硬编码 provider id / 具体工具名
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listCapabilities,
  listSubagentTools,
  probeProviders,
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

describe('listSubagentTools / listCapabilities（功能问题1 §2 修复）', () => {
  it('工具白名单：固定 subagent 工具（read/glob/grep/write/edit/pwsh/ask_user_question），非主 agent 工具表', () => {
    const tools = listSubagentTools()
    expect(tools.map((t) => t.id)).toEqual([
      'read', 'glob', 'grep', 'write', 'edit', 'pwsh', 'ask_user_question',
    ])
    // 每项带 label + desc（前端显示"读取文件 read"而非裸 id）
    const read = tools.find((t) => t.id === 'read')
    expect(read?.label).toBe('读取文件')
    expect(read?.desc.length).toBeGreaterThan(0)
    // 不包含主 agent CLI 工具
    expect(tools.some((t) => t.id.startsWith('weave_'))).toBe(false)
  })

  it('capabilities：8 个通用枚举，带 label', () => {
    const caps = listCapabilities()
    expect(caps).toHaveLength(8)
    expect(caps[0]).toMatchObject({ id: 'read', label: '读取' })
    expect(DEFAULT_CAPABILITIES).toHaveLength(8)
  })

  it('probeProviders 非 dynamic 时带 warning（功能问题1 §3）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-prov-warn-'))
    try {
      writeFileSync(join(dir, 'R1-requirement.yaml'), r1Yaml, 'utf8')
      setRolesDir(dir)
      const r = probeProviders(makeCtx({ providers: [], tools: undefined }))
      expect(r.overallSource).toBe('yaml-scan')
      expect(r.warning).toContain('非实时探测')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
