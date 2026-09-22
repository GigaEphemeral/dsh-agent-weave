// 分析 chain.log 的执行时间线（用于测试记录）
import { readFileSync } from 'node:fs'

const logPath = 'D:/dsharness/agentDev/softwareEngnieering/productions/chain.log'
const lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim())

// 定位最后一次「链开始」
let startIdx = -1
lines.forEach((l, i) => {
  try {
    if (JSON.parse(l).msg === '链开始') startIdx = i
  } catch { /* ignore */ }
})
const run = lines.slice(startIdx)

console.log(`日志总行数: ${lines.length}｜本次运行: ${run.length} 行`)
console.log('')
console.log('=== 关键事件时间线 ===')

let heartbeatCount = 0
for (const l of run) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  if (e.msg.includes('心跳')) { heartbeatCount++; continue }
  const t = (e.time || '').slice(11, 19)
  let extra = ''
  if (e.msg.includes('阶段完成')) {
    extra = ` | stop=${e.stop_reason} 耗时=${e.elapsed_s}s 输出=${e.output_len}字符${e.fence_stripped ? ' (剥离代码块)' : ''}`
  } else if (e.msg.includes('阶段开始')) {
    extra = ` | (${e.step}/${e.total_steps}) ${e.role_id} prompt=${e.prompt_len}字`
  } else if (e.msg === '链结束' || e.msg === '链已中止') {
    extra = ` | 完成=${e.completed_steps}/${e.total_steps} 总耗时=${e.total_elapsed_s}s stopped=${e.stopped}`
  }
  console.log(`${t}  ${e.msg}${extra}`)
}
console.log('')
console.log(`心跳条数: ${heartbeatCount}（证明执行期间持续有活动）`)
