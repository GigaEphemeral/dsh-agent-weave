/**
 * 角色包/流程包加载器（MVP-3 P3.E.1/P3.E.2）。
 *
 * - 角色包：YAML 角色定义（复用 role-schema 解析）+ 版本兼容性
 * - 流程包：YAML 图定义（复用 graph-definition）+ graphSchemaHash 校验
 */
import { readFileSync } from 'node:fs'
import { parseRoleYaml } from './role-schema.js'
import type { RoleDefinition } from '../shared/types.js'
import { computeGraphSchemaHash, parseGraphDefinitionYaml } from '../l2-engine/graph-definition.js'
import { validateGraph } from '../l2-engine/static-validator.js'
import type { GraphDefinitionSpec } from '../l2-engine/types.js'

/** 角色包：角色定义 + 版本。 */
export interface RolePackage {
  role: RoleDefinition
  /** 兼容的 schema 版本列表。 */
  schemaVersions: string[]
}

/** 加载角色包（YAML 文件）。 */
export function loadRolePackage(filePath: string): RolePackage {
  const raw = readFileSync(filePath, 'utf8')
  const role = parseRoleYaml(raw, filePath)
  return { role, schemaVersions: [role.schema_version] }
}

/** 校验角色包版本兼容（当前支持 '1.0'）。 */
export function isRolePackageCompatible(pkg: RolePackage): boolean {
  return pkg.schemaVersions.includes('1.0')
}

/** 流程包：图定义 + schema hash（校验一致性）。 */
export interface WorkflowPackage {
  spec: GraphDefinitionSpec
  schemaHash: string
}

/** 加载流程包（YAML 图），计算 schema hash。 */
export function loadWorkflowPackage(filePath: string): WorkflowPackage {
  const spec = parseGraphDefinitionYaml(readFileSync(filePath, 'utf8'), filePath)
  const schemaHash = computeGraphSchemaHash(spec)
  // 若 YAML 声明了 hash，校验一致性
  if (spec.graphSchemaHash && spec.graphSchemaHash !== 'demo' && spec.graphSchemaHash !== schemaHash) {
    throw new Error(`流程包 schema hash 不一致: 声明 ${spec.graphSchemaHash} ≠ 实际 ${schemaHash}`)
  }
  return { spec, schemaHash }
}

/** 校验流程包（静态验证，需角色集合）。 */
export function validateWorkflowPackage(
  pkg: WorkflowPackage,
  registeredRoles: Set<string>,
): { valid: boolean; errors: Array<{ path: string; message: string }> } {
  return validateGraph(pkg.spec, { registeredRoles })
}
