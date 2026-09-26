/**
 * MVP-5 Phase A：角色库（搜索/排序/描述/推荐）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRole, listRoles, setRolesDir } from '../../src/l4-visual/host/role-library'

const r1 = `schema_version: '1.0'
id: R1-requirement
name: 需求分析师
description: 分析用户需求
order: 10
tags: [需求, 文档]
suggests_next:
  - roleRef: R2-architect
    label: 架构设计
    reason: 需求确认后
system_prompt_ref: R1/SKILL.md
traits: []
capabilities: []
tools: []
model: { provider: huoshan-haowen, model: deepseek-v4-flash }
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 1
capability: { allow_delegation: false, max_depth: 1, allowed_children: [], allow_shell: true, allow_write: true }
quality_gate: []
token_budget: 2000
handoff: { upstream: [], downstream: [R2-architect], edge_type: seq }
`

const r6 = `schema_version: '1.0'
id: R6-developer
name: 开发者
description: TypeScript 实现
order: 40
tags: [开发, TypeScript]
system_prompt_ref: R6/SKILL.md
traits: []
capabilities: []
tools: [read, write]
model: { provider: huoshan-haowen, model: deepseek-v4-flash }
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 1
capability: { allow_delegation: false, max_depth: 1, allowed_children: [], allow_shell: true, allow_write: true }
quality_gate: []
token_budget: 2500
handoff: { upstream: [R4-designer], downstream: [R7-tester], edge_type: seq }
`

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-roles-'))
  writeFileSync(join(dir, 'R1-requirement.yaml'), r1, 'utf8')
  writeFileSync(join(dir, 'R6-developer.yaml'), r6, 'utf8')
  setRolesDir(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('角色库', () => {
  it('列表按 order 排序（R1 在 R6 前）', () => {
    const roles = listRoles()
    expect(roles.map((r) => r.id)).toEqual(['R1-requirement', 'R6-developer'])
  })

  it('按 name 排序', () => {
    const roles = listRoles({ sort: 'name' })
    expect(roles.map((r) => r.id)).toEqual(['R6-developer', 'R1-requirement'])
  })

  it('搜索命中 id/name/description/tags', () => {
    expect(listRoles({ search: '需求' }).map((r) => r.id)).toEqual(['R1-requirement'])
    expect(listRoles({ search: 'typescript' }).map((r) => r.id)).toEqual(['R6-developer'])
    expect(listRoles({ search: '实现' }).map((r) => r.id)).toEqual(['R6-developer'])
    expect(listRoles({ search: '文档' }).map((r) => r.id)).toEqual(['R1-requirement'])
  })

  it('条目携带描述/标签/推荐', () => {
    const r = getRole('R1-requirement')
    expect(r?.description).toBe('分析用户需求')
    expect(r?.tags).toEqual(['需求', '文档'])
    expect(r?.suggests_next?.[0]?.roleRef).toBe('R2-architect')
    expect(r?.tools).toEqual([])
  })
})
