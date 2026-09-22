// 修正 PowerShell 5.1 兼容性：
// 1) 脚本加 UTF-8 BOM（5.1 才能正确读中文）
// 2) Get-Content 指定 -Encoding UTF8（日志为 UTF-8 无 BOM）
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const dir = 'D:/dsharness/agentDev/softwareEngnieering/3pluginCode/test-env'
const files = ['watch-chain.ps1', 'stop-chain.ps1', 'resume-chain.ps1']

for (const f of files) {
  const p = `${dir}/${f}`
  if (!existsSync(p)) { console.log(`skip: ${f}`); continue }
  let text = readFileSync(p, 'utf8')
  // 去掉已有 BOM
  text = text.replace(/^\uFEFF/, '')
  // Get-Content 加 -Encoding UTF8（仅 watch 脚本需要）
  text = text.replace(/Get-Content \$log -Wait -Tail 40/, 'Get-Content $log -Encoding UTF8 -Wait -Tail 40')
  // 写回并加 BOM
  writeFileSync(p, '\uFEFF' + text, 'utf8')
  console.log(`fixed: ${f} (BOM added${f === 'watch-chain.ps1' ? ' + Encoding UTF8' : ''})`)
}
