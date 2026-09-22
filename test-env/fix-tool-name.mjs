// 批量替换工具名 weave:run-chain → weave_run_chain（UTF-8 无 BOM）
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const files = [
  'test-env/README.md',
  'docs/MVP-1/验证报告-单链闭环.md',
  'docs/MVP-1/process/实现逻辑总览.md',
  'docs/MVP-1/process/自测逻辑说明.md',
  'docs/MVP-1/process/隔离环境启动手册.md',
  'docs/MVP-1/process/验证操作指南.md',
]

const FROM = 'weave:run-chain'
const TO = 'weave_run_chain'

for (const rel of files) {
  const p = `D:/dsharness/agentDev/softwareEngnieering/3pluginCode/${rel}`
  if (!existsSync(p)) {
    console.log(`skip (missing): ${rel}`)
    continue
  }
  const before = readFileSync(p, 'utf8')
  const count = before.split(FROM).length - 1
  if (count === 0) {
    console.log(`no change: ${rel}`)
    continue
  }
  writeFileSync(p, before.split(FROM).join(TO), 'utf8')
  console.log(`updated: ${rel} (${count} 处)`)
}
