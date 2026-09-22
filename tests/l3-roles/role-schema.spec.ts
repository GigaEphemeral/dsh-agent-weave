/**
 * l3-roles/role-schema.ts 单测（P1.1.5 验收）。
 */
import { describe, expect, it } from 'vitest'
import { parseRoleYaml, RoleDefinitionSchema } from '../../src/l3-roles/role-schema'
import { RoleSchemaError } from '../../src/shared/types'

/** 合法的角色 YAML 样例。 */
const validYaml = `
schema_version: '1.0'
id: R6-developer
name: 开发者
system_prompt_ref: R6-ts-developer/SKILL.md
traits:
  - 严谨
  - 高效
capabilities:
  - typescript
  - dsh-plugin
tools:
  - read
  - edit
  - write
  - pwsh
model:
  provider: deepseek
  model: deepseek-v4-pro
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 2
quality_gate:
  - tsc 0 error
token_budget: 2500
handoff:
  upstream:
    - R2-architect
  downstream:
    - R7-tester
  edge_type: seq
`

describe('parseRoleYaml', () => {
  it('解析合法 YAML 并返回 RoleDefinition', () => {
    const role = parseRoleYaml(validYaml, 'roles/R6-developer.yaml')
    expect(role.id).toBe('R6-developer')
    expect(role.model).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' })
    expect(role.memory_scope).toBe('private')
    expect(role.handoff.edge_type).toBe('seq')
  })

  it('拒绝缺少必填字段的 YAML 并携带路径明细', () => {
    const bad = validYaml.replace("model:\n  provider: deepseek", "model:\n  provider: ''")
    try {
      parseRoleYaml(bad, 'roles/bad.yaml')
      expect.unreachable('应当抛出 RoleSchemaError')
    } catch (error) {
      expect(error).toBeInstanceOf(RoleSchemaError)
      const e = error as RoleSchemaError
      expect(e.issues.some((i) => i.path === 'model.provider')).toBe(true)
    }
  })

  it('拒绝非法枚举（memory_scope）', () => {
    const bad = validYaml.replace('memory_scope: private', 'memory_scope: public')
    try {
      parseRoleYaml(bad, 'roles/bad.yaml')
      expect.unreachable('应当抛出 RoleSchemaError')
    } catch (error) {
      expect(error).toBeInstanceOf(RoleSchemaError)
      const e = error as RoleSchemaError
      expect(e.issues.some((i) => i.path === 'memory_scope')).toBe(true)
    }
  })

  it('YAML 语法错误抛 RoleSchemaError', () => {
    try {
      parseRoleYaml('id: [unclosed', 'roles/syntax.yaml')
      expect.unreachable('应当抛出 RoleSchemaError')
    } catch (error) {
      expect(error).toBeInstanceOf(RoleSchemaError)
    }
  })

  it('非对象 YAML（如纯字符串）被拒绝', () => {
    try {
      parseRoleYaml('just a string', 'roles/not-object.yaml')
      expect.unreachable('应当抛出 RoleSchemaError')
    } catch (error) {
      expect(error).toBeInstanceOf(RoleSchemaError)
    }
  })
})

describe('RoleDefinitionSchema 导出', () => {
  it('可被直接引用（单一真相源）', () => {
    expect(RoleDefinitionSchema).toBeDefined()
    expect(RoleDefinitionSchema.shape.schema_version).toBeDefined()
  })
})
