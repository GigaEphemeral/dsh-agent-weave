import { createRequire } from 'node:module'
const require = createRequire('D:/dsharness/agentDev/softwareEngnieering/3pluginCode/')
const pkg = require('@deepseek-ai/dsh-subagent')
const SubagentRuntime = pkg.SubagentRuntime ?? pkg.default
console.log('SubagentRuntime 类型:', typeof SubagentRuntime)
if (typeof SubagentRuntime === 'function') {
  const proto = SubagentRuntime.prototype
  const methods = Object.getOwnPropertyNames(proto)
  console.log('原型方法列表:')
  for (const m of methods) console.log(`  ${m}: ${typeof proto[m]}`)
  console.log('\n关键 API 存在性:')
  for (const m of ['start','startContinuable','sendMessage','followup','reportFrom','interrupt','listChildren','listDescendants','registerProvider','getProvider','prompt']) {
    console.log(`  ${m}: ${typeof proto[m] !== 'undefined' ? '✅' : '❌'}`)
  }
} else {
  console.log('无法获取类，导出键:', Object.keys(pkg).join(', '))
}
