/**
 * l3-roles/role-loader.ts 单测（P1.1.6 验收，D-001 修正版）。
 *
 * 验证：
 * - R6 YAML → RoleProfile：字段完整映射（compileRoleProfile）
 * - model 传完整 { provider, model } 对象
 * - toolFilter 映射正确
 * - inheritsParentContext=false（private）
 * - compileRoleToProvider → SubagentProvider：name/capabilities/start 委托注入
 * - 路径逃逸防护生效
 * - skill 文件缺失/读取失败抛 RoleLoadError
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertInsideSkillsDir,
  compileRoleDirectory,
  compileRoleProfile,
  compileRoleProfileDirectory,
  compileRoleToProvider,
  describeRoleProfile,
  loadRoleDefinitions,
  resolveSystemPromptPath,
  scanRoleFiles,
} from '../../src/l3-roles/role-loader'
import { RoleLoadError, type RoleDefinition } from '../../src/shared/types'
import type { ResolvedSubagentStartRequest, SubagentRun } from '@deepseek-ai/dsh-subagent'

/** 构造临时 skill 目录，返回清理函数。 */
function tempSkillsDir(): { dir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'weave-skill-'))
  mkdirSync(join(base, 'R6-ts-developer'))
  writeFileSync(
    join(base, 'R6-ts-developer', 'SKILL.md'),
    '# Developer\n你是 TypeScript 开发者。\n遵守产物四铁律。\n',
    'utf8',
  )
  return {
    dir: base,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

const validRole: RoleDefinition = {
  schema_version: '1.0',
  id: 'R6-developer',
  name: '开发者',
  system_prompt_ref: 'R6-ts-developer/SKILL.md',
  traits: ['严谨'],
  capabilities: ['typescript'],
  tools: ['read', 'edit', 'write'],
  model: { provider: 'deepseek', model: 'deepseek-v4-pro' },
  memory_scope: 'private',
  lifecycle: 'on-demand',
  max_concurrent_children: 2,
  quality_gate: ['tsc 0 error'],
  token_budget: 2500,
  handoff: { upstream: ['R2-architect'], downstream: ['R7-tester'], edge_type: 'seq' },
}

/** 假 delegate：记录收到的请求并返回假 run。 */
function fakeDelegate() {
  const received: ResolvedSubagentStartRequest[] = []
  const run: SubagentRun = {
    id: 'child-1' as unknown as SubagentRun['id'],
    localAgent: undefined,
    result: Promise.resolve({
      output: [],
      stopReason: 'completed',
    }),
    dispose: vi.fn(async () => {}),
  }
  const start = vi.fn(async (request: ResolvedSubagentStartRequest) => {
    received.push(request)
    return run
  })
  return { start, received, run }
}

describe('compileRoleProfile 字段映射', () => {
  it('R6 YAML → RoleProfile：字段完整映射', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const profile = compileRoleProfile(validRole, { skillsDir: dir })
      expect(profile.name).toBe('R6-developer')
      expect(profile.persona).toContain('TypeScript 开发者')
      expect(profile.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' })
      expect(profile.toolFilter).toEqual(['read', 'edit', 'write'])
      expect(profile.inheritsParentContext).toBe(false)
      expect(profile.depthLimit).toBe(2)
      expect(profile.metadata.token_budget).toBe(2500)
      expect(profile.metadata.handoff.edge_type).toBe('seq')
    } finally {
      cleanup()
    }
  })

  it('shared → inheritsParentContext=true', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const profile = compileRoleProfile({ ...validRole, memory_scope: 'shared' }, { skillsDir: dir })
      expect(profile.inheritsParentContext).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('绝对路径 system_prompt_ref 可用', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const absRef = join(dir, 'R6-ts-developer', 'SKILL.md')
      const profile = compileRoleProfile({ ...validRole, system_prompt_ref: absRef }, { skillsDir: dir })
      expect(profile.persona).toContain('TypeScript 开发者')
    } finally {
      cleanup()
    }
  })
})

describe('compileRoleToProvider 包装器', () => {
  it('返回 SubagentProvider：name/capabilities/agentRouteDefaults 正确', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const delegate = fakeDelegate()
      const provider = compileRoleToProvider(validRole, { skillsDir: dir }, delegate)
      expect(provider.name).toBe('R6-developer')
      expect(provider.inheritsParentContext).toBe(false)
      expect(provider.capabilities).toEqual({
        agentOptions: true,
        outputSchema: false,
        depthLimit: true,
        toolFilter: true,
        persona: true,
      })
      expect(provider.agentRouteDefaults).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' })
    } finally {
      cleanup()
    }
  })

  it('start() 注入 persona/toolFilter/agentOptions 后委托 delegate', async () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const delegate = fakeDelegate()
      const provider = compileRoleToProvider(validRole, { skillsDir: dir }, delegate)
      const request = {
        prompt: [{ type: 'text' as const, text: '写代码' }],
        parent: {} as never,
        signal: new AbortController().signal,
        descriptor: {} as never,
      }
      await provider.start(request as ResolvedSubagentStartRequest)

      expect(delegate.start).toHaveBeenCalledTimes(1)
      const injected = delegate.received[0]
      expect(injected?.persona).toContain('TypeScript 开发者')
      expect(injected?.toolFilter).toEqual({ allow: ['read', 'edit', 'write'] })
      expect(injected?.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' })
      expect(injected?.maxDepth).toBe(2)
    } finally {
      cleanup()
    }
  })
})

describe('路径逃逸防护', () => {
  it('拒绝逃逸 skillsDir 的相对路径', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const escaping = { ...validRole, system_prompt_ref: '../../secret.txt' }
      expect(() => compileRoleProfile(escaping, { skillsDir: dir })).toThrow(RoleLoadError)
      expect(() => compileRoleProfile(escaping, { skillsDir: dir })).toThrow(/不允许逃逸/)
    } finally {
      cleanup()
    }
  })

  it('assertInsideSkillsDir 直接校验', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      expect(() => assertInsideSkillsDir(dir, join(dir, '..', 'x.md'), 'R6')).toThrow(RoleLoadError)
      const ok = assertInsideSkillsDir(dir, join(dir, 'R6-ts-developer', 'SKILL.md'), 'R6')
      expect(ok).toBe(join(dir, 'R6-ts-developer', 'SKILL.md'))
    } finally {
      cleanup()
    }
  })
})

describe('skill 文件错误处理', () => {
  it('skill 文件不存在抛 RoleLoadError', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      expect(() =>
        compileRoleProfile({ ...validRole, system_prompt_ref: 'missing/SKILL.md' }, { skillsDir: dir }),
      ).toThrow(/skill 文件不存在/)
    } finally {
      cleanup()
    }
  })
})

describe('目录扫描与批量编译', () => {
  it('scanRoleFiles 只收 YAML 且排序', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      mkdirSync(join(dir, 'roles'))
      writeFileSync(join(dir, 'roles', 'b.yaml'), 'id: b\n', 'utf8')
      writeFileSync(join(dir, 'roles', 'a.yml'), 'id: a\n', 'utf8')
      writeFileSync(join(dir, 'roles', 'c.txt'), 'ignored\n', 'utf8')
      const files = scanRoleFiles(join(dir, 'roles'))
      expect(files.map((f) => f.replace(/\\/g, '/').split('/').pop())).toEqual(['a.yml', 'b.yaml'])
    } finally {
      cleanup()
    }
  })

  it('loadRoleDefinitions 读取并校验全部角色', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const rolesDir = join(dir, 'roles')
      mkdirSync(rolesDir)
      writeFileSync(
        join(rolesDir, 'r6.yaml'),
        `schema_version: '1.0'
id: R6-developer
name: 开发者
system_prompt_ref: R6-ts-developer/SKILL.md
traits: []
capabilities: []
tools: [read]
model: { provider: deepseek, model: deepseek-v4-pro }
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 2
quality_gate: []
token_budget: 2500
handoff: { upstream: [], downstream: [], edge_type: seq }
`,
        'utf8',
      )
      const roles = loadRoleDefinitions(rolesDir)
      expect(roles).toHaveLength(1)
      expect(roles[0]?.id).toBe('R6-developer')
    } finally {
      cleanup()
    }
  })

  it('compileRoleDirectory 批量编译为 provider', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const rolesDir = join(dir, 'roles')
      mkdirSync(rolesDir)
      writeFileSync(
        join(rolesDir, 'r6.yaml'),
        `schema_version: '1.0'
id: R6-developer
name: 开发者
system_prompt_ref: R6-ts-developer/SKILL.md
traits: []
capabilities: []
tools: [read]
model: { provider: deepseek, model: deepseek-v4-pro }
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 2
quality_gate: []
token_budget: 2500
handoff: { upstream: [], downstream: [], edge_type: seq }
`,
        'utf8',
      )
      const delegate = fakeDelegate()
      const providers = compileRoleDirectory(rolesDir, { skillsDir: dir }, delegate)
      expect(providers).toHaveLength(1)
      expect(providers[0]?.name).toBe('R6-developer')
      expect(providers[0]?.capabilities.persona).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('compileRoleProfileDirectory 批量编译为 profile', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const rolesDir = join(dir, 'roles')
      mkdirSync(rolesDir)
      writeFileSync(
        join(rolesDir, 'r6.yaml'),
        `schema_version: '1.0'
id: R6-developer
name: 开发者
system_prompt_ref: R6-ts-developer/SKILL.md
traits: []
capabilities: []
tools: [read]
model: { provider: deepseek, model: deepseek-v4-pro }
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 2
quality_gate: []
token_budget: 2500
handoff: { upstream: [], downstream: [], edge_type: seq }
`,
        'utf8',
      )
      const profiles = compileRoleProfileDirectory(rolesDir, { skillsDir: dir })
      expect(profiles).toHaveLength(1)
      expect(profiles[0]?.name).toBe('R6-developer')
      expect(profiles[0]?.persona).toContain('TypeScript 开发者')
    } finally {
      cleanup()
    }
  })
})

describe('describeRoleProfile 脱敏', () => {
  it('只暴露长度/指纹/工具数，不含 persona 全文', () => {
    const { dir, cleanup } = tempSkillsDir()
    try {
      const profile = compileRoleProfile(validRole, { skillsDir: dir })
      const data = describeRoleProfile(profile)
      expect(typeof data.persona_len).toBe('number')
      expect(String(data.persona_fp)).toMatch(/^fp:/)
      expect(JSON.stringify(data)).not.toContain('TypeScript 开发者')
    } finally {
      cleanup()
    }
  })
})

describe('resolveSystemPromptPath', () => {
  it('相对路径基于 skillsDir 解析，绝对路径直接使用', () => {
    expect(resolveSystemPromptPath('C:/skills', 'a/SKILL.md').replace(/\\/g, '/')).toBe('C:/skills/a/SKILL.md')
    expect(resolveSystemPromptPath('C:/skills', 'C:/abs/SKILL.md').replace(/\\/g, '/')).toBe('C:/abs/SKILL.md')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
