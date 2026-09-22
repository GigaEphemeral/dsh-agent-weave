// 验证：编译 roles/ 目录下全部角色（P1.2.1 前置）
// 注意：引用编译产物 lib/（源码为 TS，需先 pnpm build:host）
import { compileRoleDirectory, describeRoleProfile } from '../lib/l3-roles/role-loader.js'
import { logger } from '../lib/shared/logger.js'

const rolesDir = new URL('../roles/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
const skillsDir = new URL('../skills/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')

try {
  const profiles = compileRoleDirectory(rolesDir, { skillsDir })
  logger.info('verify', '角色编译完成', { count: profiles.length })
  for (const p of profiles) {
    logger.info('verify', `角色 ${p.name}`, describeRoleProfile(p))
  }
  const ids = profiles.map((p) => p.name).join(', ')
  console.log(`\n编译成功: ${profiles.length} 个角色 -> ${ids}`)
} catch (error) {
  logger.error('verify', '角色编译失败', error instanceof Error ? error : new Error(String(error)))
  process.exitCode = 1
}
