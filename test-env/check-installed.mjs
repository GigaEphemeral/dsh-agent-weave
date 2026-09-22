// 检查隔离 profile 中安装后的 dsh-agent-weave 结构
import { readFileSync, existsSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'

const prof = 'D:/dsharness/agentDev/softwareEngnieering/3pluginCode/test-env/dsh-home/profiles/weave-test'
const pkgDir = join(prof, 'node_modules/dsh-agent-weave')
console.log('exists:', existsSync(pkgDir))
console.log('isSymbolicLink:', statSync(pkgDir, { throwIfNoEntry: false })?.isSymbolicLink?.() ?? false)
try { console.log('readlink:', readlinkSync(pkgDir)) } catch { /* not a link */ }
const manifestPath = join(pkgDir, 'package.json')
console.log('manifest exists:', existsSync(manifestPath))
if (existsSync(manifestPath)) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
  console.log('dsh:', JSON.stringify(m.dsh))
  console.log('cordis.patch.yml exists:', existsSync(join(pkgDir, 'cordis.patch.yml')))
  console.log('lib/index.js exists:', existsSync(join(pkgDir, 'lib/index.js')))
}
