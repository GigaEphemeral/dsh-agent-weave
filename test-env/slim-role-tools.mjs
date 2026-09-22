// 精简角色工具集：只保留必要工具，去掉 pwsh/glob/grep/write/edit
// 目的：杜绝角色"探索环境"（R6 曾反复跑 pwsh 检查 node/npm/tsc，5+ 步无产出）
// 依据：最小权限声明原则 + 适配慢速本地模型（避免多轮工具往返）
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const roleDir = 'D:/dsharness/agentDev/softwareEngnieering/3pluginCode/roles'

// 角色 → 精简后的工具集
const TOOLS = {
  'R1-requirement': [],          // 链首，无上游可读
  'R2-architect': ['read'],      // 读上游 PRD
  'R4-designer': ['read'],       // 读上游架构
  'R6-developer': ['read'],      // 读上游设计（产物由编排器落盘，不需 write）
  'R7-tester': ['read'],         // 读上游实现
  'R8-quality': ['read'],        // 读上游测试报告
}

for (const [role, tools] of Object.entries(TOOLS)) {
  const p = `${roleDir}/${role}.yaml`
  if (!existsSync(p)) {
    console.log(`skip (missing): ${role}`)
    continue
  }
  const before = readFileSync(p, 'utf8')
  const block = tools.length === 0
    ? 'tools: []'
    : `tools:\n${tools.map((t) => `  - ${t}`).join('\n')}`
  // 替换 tools: 块（到下一个顶格键为止）；兼容 CRLF
  const after = before.replace(/tools:\r?\n(?:[ \t]+-[^\n]*\r?\n)+/, `${block}\n`)
  if (after === before) {
    console.log(`no change: ${role}（未匹配 tools 块）`)
    continue
  }
  writeFileSync(p, after, 'utf8')
  console.log(`updated: ${role} → [${tools.join(', ')}]`)
}
