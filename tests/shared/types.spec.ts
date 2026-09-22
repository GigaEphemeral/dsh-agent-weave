/**
 * shared/types.ts 与 RoleDefinitionSchema 单测（P1.1.3 验收）。
 */
import { describe, expect, it } from 'vitest'
import { RoleDefinitionSchema, RoleSchemaError, RoleLoadError } from '../../src/shared/types'

/** 合法的完整角色 YAML（校验通过的基准样例）。 */
const validRole = {
  schema_version: '1.0',
  id: 'R6-developer',
  name: '开发者',
  system_prompt_ref: 'R6-ts-developer/SKILL.md',
  traits: ['严谨', '高效'],
  capabilities: ['typescript', 'dsh-plugin'],
  tools: ['read', 'edit', 'write', 'pwsh'],
  model: { provider: 'deepseek', model: 'deepseek-v4-pro' },
  memory_scope: 'private',
  lifecycle: 'on-demand',
  max_concurrent_children: 2,
  quality_gate: ['tsc 0 error', '产物无 .ts 残留'],
  token_budget: 2500,
  handoff: { upstream: ['R2-architect'], downstream: ['R7-tester'], edge_type: 'seq' },
}

describe('RoleDefinitionSchema', () => {
  it('通过合法角色定义', () => {
    const result = RoleDefinitionSchema.safeParse(validRole)
    expect(result.success).toBe(true)
  })

  it('拒绝非法 schema_version（必须为 "1.0"）', () => {
    const result = RoleDefinitionSchema.safeParse({ ...validRole, schema_version: '2.0' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue?.path.join('.')).toBe('schema_version')
    }
  })

  it('拒绝缺失 model.provider / model.model', () => {
    const result = RoleDefinitionSchema.safeParse({ ...validRole, model: { provider: '' } })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'model.provider')).toBe(true)
    }
  })

  it('拒绝非正数 max_concurrent_children / token_budget', () => {
    const result = RoleDefinitionSchema.safeParse({ ...validRole, max_concurrent_children: 0 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path.join('.')).toBe('max_concurrent_children')
    }
  })

  it('拒绝非法 memory_scope / lifecycle / edge_type 枚举', () => {
    const result = RoleDefinitionSchema.safeParse({ ...validRole, memory_scope: 'public' })
    expect(result.success).toBe(false)
  })

  it('observers 可选且按 ObserverConfigSchema 校验', () => {
    const withObserver = {
      ...validRole,
      observers: [
        {
          id: 'obs-1',
          role_ref: 'R7-tester',
          observe_nodes: ['R6-developer'],
          observation_mode: 'file-watch',
          intervention_mode: 'flag-only',
          criteria: ['tsc 0 error'],
          token_budget: 500,
        },
      ],
    }
    expect(RoleDefinitionSchema.safeParse(withObserver).success).toBe(true)
    const badObserver = {
      ...validRole,
      observers: [{ id: 'obs-1', role_ref: 'R7-tester', token_budget: -1 }],
    }
    expect(RoleDefinitionSchema.safeParse(badObserver).success).toBe(false)
  })
})

describe('错误类型', () => {
  it('RoleLoadError 名称与消息', () => {
    const err = new RoleLoadError('skill 文件不存在: /x')
    expect(err.name).toBe('RoleLoadError')
    expect(err.message).toContain('skill 文件不存在')
  })

  it('RoleSchemaError 携带 issues 明细', () => {
    const err = new RoleSchemaError('角色校验失败', [{ path: 'model.provider', message: 'String must contain at least 1 character(s)' }])
    expect(err.name).toBe('RoleSchemaError')
    expect(err.issues[0]?.path).toBe('model.provider')
  })
})
