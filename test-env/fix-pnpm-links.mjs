// 修复 pnpm 顶层 @deepseek-ai/* 符号链接（指向哈希化 store 目录）
// 现象：pnpm 12 在 Windows 上创建的链接目标（@deepseek-ai+x@ver）与实际 store 目录
// （@deepseek-ai+x@0.1._hash）不一致，导致 Node 解析失败。
import { readdirSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const pnpmDir = join(root, 'node_modules', '.pnpm')
const scopedDir = join(root, 'node_modules', '@deepseek-ai')

let fixed = 0
for (const entry of readdirSync(scopedDir)) {
  const link = join(scopedDir, entry)
  if (!existsSync(join(link, 'package.json'))) {
    // 链接失效：在 .pnpm 中找真实 store 目录
    const candidates = readdirSync(pnpmDir).filter((d) => d.includes(`+${entry}@`))
    let target
    for (const cand of candidates) {
      const probe = join(pnpmDir, cand, 'node_modules', '@deepseek-ai', entry)
      if (existsSync(join(probe, 'package.json'))) {
        target = probe
        break
      }
    }
    if (target) {
      rmSync(link, { recursive: true, force: true })
      symlinkSync(target, link, 'junction')
      console.log(`fixed: ${entry} -> ${target}`)
      fixed++
    } else {
      console.log(`no store candidate for ${entry}`)
    }
  } else {
    console.log(`ok: ${entry}`)
  }
}
console.log(`done, fixed=${fixed}`)
