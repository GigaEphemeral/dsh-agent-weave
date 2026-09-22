/**
 * 共享错误类型（MVP-1 P1.1.2）。
 *
 * 角色加载链的错误在此定义；Schema 校验错误复用 shared/types.ts 的
 * RoleSchemaError。后续 MVP 的错误（图 DSL / 消息总线）追加到本文件。
 */
import { RoleLoadError, RoleSchemaError } from './types.js'

export { RoleLoadError, RoleSchemaError }
