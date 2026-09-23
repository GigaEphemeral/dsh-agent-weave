/**
 * 问题二 capability → depthLimit / maxDepth 映射验证。
 *
 * 修正后真实契约（role-loader.ts）：
 * - depthLimit (number) ← role.capability.max_depth（不再用 max_concurrent_children）
 * - compileRoleToProvider：capabilities.depthLimit 是布尔能力标志（true），
 *   数字映射发生在 start() 注入请求的 maxDepth ← profile.depthLimit
 *
 * 语义（DSH resolveChildDepth 实测）：角色自身被 spawn 时深度=1，
 * maxDepth 必须 ≥1 才能启动；capability.max_depth=1 即"允许自身存在、禁止 spawn 下级"。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compileRoleProfile, compileRoleToProvider } from '../../src/l3-roles/role-loader'
import type { RoleDefinition } from '../../src/shared/types'
import type { ResolvedSubagentStartRequest, SubagentRun } from '@deepseek-ai/dsh-subagent'

/** 构造临时 skill 目录，返回清理函数。 */
function tempSkillsDir(): { dir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'weave-cap-'))
  mkdirSync(join(base, 'R6-ts-developer'))
  writeFileSync(join(base, 'R6-ts-developer', 'SKILL.md'), '# Developer\n你是测试角色。\n', 'utf8')
  return { dir: base, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

/** 基础角色定义（capability 由各用例覆盖）。 */
function baseRole(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    schema_version: '1.0',
    id: 'test-role',
    name: '测试角色',
    system_prompt_ref: 'R6-ts-developer/SKILL.md',
    traits: [],
    capabilities: [],
    tools: [],
    model: { provider: 'test-provider', model: 'test-model' },
    memory_scope: 'private',
    lifecycle: 'on-demand',
    max_concurrent_children: 8,
    capability: {
      allow_delegation: false,
      max_depth: 1,
      allowed_children: [],
      allow_shell: true,
      allow_write: true,
    },
    quality_gate: [],
    token_budget: 10000,
    handoff: { upstream: [], downstream: [], edge_type: 'seq' },
    ...overrides,
  }
}

/** 假 delegate：记录收到的请求并返回假 run。 */
function fakeDelegate() {
  const received: ResolvedSubagentStartRequest[] = []
  const run: SubagentRun = {
    id: 'child-1' as unknown as SubagentRun['id'],
    localAgent: undefined,
    result: Promise.resolve({ output: [], stopReason: 'completed' }),
    dispose: vi.fn(async () => {}),
  }
  const start = vi.fn(async (request: ResolvedSubagentStartRequest) => {
    received.push(request)
    return run
  })
  return { start, received, run }
}

describe('问题二 capability → depthLimit / maxDepth 映射', () => {
  it('depthLimit 来自 capability.max_depth（默认 1，允许自身存在禁止委派）', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const profile = compileRoleProfile(baseRole(), { skillsDir: dir })
      expect(profile.depthLimit).toBe(1)
      expect(profile.capability.allow_delegation).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('capability.max_depth=2 → depthLimit=2（允许 spawn 一级下级）', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const profile = compileRoleProfile(
        baseRole({ capability: { ...baseRole().capability!, max_depth: 2 } }),
        { skillsDir: dir },
      )
      expect(profile.depthLimit).toBe(2)
    } finally {
      cleanup()
    }
  })

  it('capabilities.depthLimit 是布尔能力标志（true），数字经 start() 的 maxDepth 注入', async () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const delegate = fakeDelegate()
      const provider = compileRoleToProvider(
        baseRole({ capability: { ...baseRole().capability!, max_depth: 2 } }),
        { skillsDir: dir },
        delegate,
      )
      expect(provider.capabilities.depthLimit).toBe(true)
      await provider.start({
        prompt: [{ type: 'text' as const, text: '执行' }],
        parent: {} as never,
        signal: new AbortController().signal,
        descriptor: {} as never,
      } as ResolvedSubagentStartRequest)
      expect(delegate.received[0]?.maxDepth).toBe(2)
    } finally {
      cleanup()
    }
  })

  it('start() 注入 maxDepth = capability.max_depth（默认 1）', async () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const delegate = fakeDelegate()
      const provider = compileRoleToProvider(baseRole(), { skillsDir: dir }, delegate)
      await provider.start({
        prompt: [{ type: 'text' as const, text: '执行' }],
        parent: {} as never,
        signal: new AbortController().signal,
        descriptor: {} as never,
      } as ResolvedSubagentStartRequest)
      expect(delegate.received[0]?.maxDepth).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('max_concurrent_children 不再影响 depthLimit（语义已修正）', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const profile = compileRoleProfile(baseRole({ max_concurrent_children: 8 }), { skillsDir: dir })
      expect(profile.depthLimit).toBe(1) // 只取决于 capability，与并发数无关
    } finally {
      cleanup()
    }
  })
})
