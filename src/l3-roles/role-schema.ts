/**
 * 角色 YAML Schema 与解析（MVP-1 P1.1.5）。
 *
 * 职责：
 * - 导出 RoleDefinitionSchema（单一真相源，定义于 shared/types.ts）
 * - parseRoleYaml：YAML 文本 → 校验 → RoleDefinition
 * - 校验失败抛 RoleSchemaError（携带 Zod issues 明细）
 *
 * 校验时机（开发契约 §3.3）：角色 YAML 在导入时校验。
 */
import { load as yamlLoad } from 'js-yaml'
import {
  RoleDefinitionSchema,
  RoleSchemaError,
  type RoleDefinition,
} from '../shared/types.js'

/** 从 YAML 文本解析并校验角色定义。 */
export function parseRoleYaml(raw: string, source: string): RoleDefinition {
  let data: unknown
  try {
    data = yamlLoad(raw)
  } catch (error) {
    throw new RoleSchemaError(
      `角色 YAML 语法错误: ${source}: ${error instanceof Error ? error.message : String(error)}`,
      [{ path: '$', message: 'YAML 解析失败' }],
    )
  }

  const result = RoleDefinitionSchema.safeParse(data)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '$',
      message: issue.message,
    }))
    throw new RoleSchemaError(
      `角色定义校验失败: ${source}（${issues.length} 处问题）`,
      issues,
    )
  }
  return result.data
}

export { RoleDefinitionSchema }
