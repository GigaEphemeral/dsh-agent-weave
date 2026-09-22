// 精确统计本次测试运行（18:17-18:41）的 token 消耗
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'

const zstd = promisify(zstdDecompress)
const ZSTD_MAGIC = 0xFD2FB528
const ws = 'D:/dsharness/agentDev/softwareEngnieering/3pluginCode/test-env/dsh-home/sessions/--D-dsharness-agentDev-softwareEngnieering-~6D4B~8BD5~5DE5~4F5C~533A--'

function scanFrames(buffer) {
  const frames = []
  let o = 0
  while (o < buffer.length) {
    const start = o
    if (buffer.length - o < 4) break
    if (buffer.readUInt32LE(o) !== ZSTD_MAGIC) throw new Error(`bad magic @${o}`)
    o += 4
    if (o === buffer.length) break
    const d = buffer.readUInt8(o); o += 1
    const csf = d >>> 6
    const ss = (d & 0x20) !== 0
    const chk = (d & 0x04) !== 0
    const df = d & 0x03
    const db = df === 3 ? 4 : df
    const csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf
    const rh = (ss ? 0 : 1) + db + csb
    if (buffer.length - o < rh) break
    o += rh
    for (;;) {
      if (buffer.length - o < 3) { o = buffer.length; break }
      const bh = buffer.readUIntLE(o, 3); o += 3
      const last = (bh & 1) !== 0
      const bt = (bh >>> 1) & 3
      const bs = bh >>> 3
      const pb = bt === 1 ? 1 : bs
      if (buffer.length - o < pb) { o = buffer.length; break }
      o += pb
      if (last) break
    }
    if (chk) o += 4
    frames.push({ start, end: o })
  }
  return frames
}

const FROM = new Date('2026-09-22T18:15:00+08:00').getTime()
const TO = new Date('2026-09-22T18:45:00+08:00').getTime()

const rows = []
let sumIn = 0, sumOut = 0, sumCache = 0, sumReq = 0

for (const dir of readdirSync(ws)) {
  const f = join(ws, dir, 'session.v3.jsonl.zstd')
  let buf
  try { buf = readFileSync(f) } catch { continue }
  const mt = statSync(f).mtimeMs
  if (mt < FROM || mt > TO) continue

  let text = ''
  try {
    for (const fr of scanFrames(buf)) text += (await zstd(buf.subarray(fr.start, fr.end))).toString('utf8')
  } catch { continue }

  let role = 'MAIN'
  let req = 0, tin = 0, tout = 0, tcache = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'subagent/descriptor' && ev.data?.provider) role = ev.data.provider
      const u = ev.data?.usage ?? ev.usage
      if (u && (ev.type === 'assistant/message' || ev.type === 'assistant/attempt')) {
        req++
        tin += u.inputTokens ?? 0
        tout += u.outputTokens ?? 0
        tcache += u.cacheReadTokens ?? 0
      }
    } catch { /* ignore */ }
  }
  rows.push({ session: dir.slice(0, 10), role, req, tin, tout, tcache })
  sumReq += req; sumIn += tin; sumOut += tout; sumCache += tcache
}

console.log('=== 本次测试 token 消耗（18:15-18:45）===')
console.log('角色'.padEnd(16) + '请求'.padEnd(6) + '输入'.padEnd(10) + '输出'.padEnd(10) + '缓存读'.padEnd(10))
for (const r of rows.sort((a, b) => b.tout - a.tout)) {
  console.log(String(r.role).padEnd(16) + String(r.req).padEnd(6) + String(r.tin).padEnd(10) + String(r.tout).padEnd(10) + String(r.tcache).padEnd(10))
}
console.log('-'.repeat(52))
console.log('合计'.padEnd(16) + String(sumReq).padEnd(6) + String(sumIn).padEnd(10) + String(sumOut).padEnd(10) + String(sumCache).padEnd(10))
console.log('')
console.log(`非缓存输入 + 输出 = ${sumIn + sumOut} tokens`)
console.log(`缓存命中率 = ${(sumCache / (sumIn + sumCache) * 100).toFixed(1)}%`)
