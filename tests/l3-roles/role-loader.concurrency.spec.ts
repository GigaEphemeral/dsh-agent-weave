/**
 * FIX.5 max_concurrent_children 映射验证。
 *
 * 真实契约（D-001 + role-loader.ts）：
 * - compileRoleProfile：depthLimit (number) ← role.max_concurrent_children
 * - compileRoleToProvider：capabilities.depthLimit 是布尔能力标志（true），
 *   数字映射发生在 start() 注入请求的 maxDepth ← profile.depthLimit
 *
 * 本测试验证两条链路：
 *   A. RoleProfile.depthLimit === role.max_concurrent_children（3 个用例）
 *   B. start() 注入的 maxDepth === role.max_concurrent_children（3 个用例）
 * 并补边界：max_concurrent_children 为 0 时 profile 不含 depthLimit、start 不注入 maxDepth。
 *
 * 注：任务草案曾断言 provider.capabilities.depthLimit 等于数字值，与真实契约不符
 * （capabilities.depthLimit 是布尔能力标志），此处按真实契约修正。
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
  const base = mkdtempSync(join(tmpdir(), 'weave-fix5-'))
  mkdirSync(join(base, 'R6-ts-developer'))
  writeFileSync(join(base, 'R6-ts-developer', 'SKILL.md'), '# Developer\n你是测试角色。\n', 'utf8')
  return { dir: base, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

/** 基础角色定义（max_concurrent_children 由各用例覆盖）。 */
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

describe('FIX.5 max_concurrent_children → depthLimit / maxDepth 映射', () => {
  it('depthLimit (number) 应等于 max_concurrent_children=8', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const profile = compileRoleProfile(baseRole({ max_concurrent_children: 8 }), { skillsDir: dir })
      expect(profile.depthLimit).toBe(8)
    } finally {
      cleanup()
    }
  })

  it('depthLimit 应等于 max_concurrent_children=1', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const profile = compileRoleProfile(baseRole({ max_concurrent_children: 1 }), { skillsDir: dir })
      expect(profile.depthLimit).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('depthLimit 应等于 max_concurrent_children=100', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const profile = compileRoleProfile(baseRole({ max_concurrent_children: 100 }), { skillsDir: dir })
      expect(profile.depthLimit).toBe(100)
    } finally {
      cleanup()
    }
  })

  it('capabilities.depthLimit 是布尔能力标志（true），数字经 start() 的 maxDepth 注入', async () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const delegate = fakeDelegate()
      const provider = compileRoleToProvider(
        baseRole({ max_concurrent_children: 8 }),
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
      expect(delegate.received[0]?.maxDepth).toBe(8)
    } finally {
      cleanup()
    }
  })

  it('start() 注入 maxDepth 等于 max_concurrent_children=1', async () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const delegate = fakeDelegate()
      const provider = compileRoleToProvider(
        baseRole({ max_concurrent_children: 1 }),
        { skillsDir: dir },
        delegate,
      )
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

  it('start() 注入 maxDepth 等于 max_concurrent_children=100', async () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const delegate = fakeDelegate()
      const provider = compileRoleToProvider(
        baseRole({ max_concurrent_children: 100 }),
        { skillsDir: dir },
        delegate,
      )
      await provider.start({
        prompt: [{ type: 'text' as const, text: '执行' }],
        parent: {} as never,
        signal: new AbortController().signal,
        descriptor: {} as never,
      } as ResolvedSubagentStartRequest)
      expect(delegate.received[0]?.maxDepth).toBe(100)
    } finally {
      cleanup()
    }
  })

  it('边界：max_concurrent_children=0 时 profile 不含 depthLimit、start 不注入 maxDepth', async () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const role = baseRole({ max_concurrent_children: 0 })
      const profile = compileRoleProfile(role, { skillsDir: dir })
      expect(profile.depthLimit).toBeUndefined()

      const delegate = fakeDelegate()
      const provider = compileRoleToProvider(role, { skillsDir: dir }, delegate)
      await provider.start({
        prompt: [{ type: 'text' as const, text: '执行' }],
        parent: {} as never,
        signal: new AbortController().signal,
        descriptor: {} as never,
      } as ResolvedSubagentStartRequest)
      expect(delegate.received[0]?.maxDepth).toBeUndefined()
    } finally {
      cleanup()
    }
  })
})
