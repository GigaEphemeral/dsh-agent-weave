// 扫描隔离 session 日志：统计事件类型（验证 subagent 生命周期事件 = chat 节点证据）
// 多帧 zstd 扫描（复用 token-ledger 的帧解析逻辑）
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'

const zstd = promisify(zstdDecompress)
const ZSTD_MAGIC = 0xFD2FB528
const sessDir = process.argv[2]

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

const wantTypes = new Set([
  'subagent/start',
  'subagent/end',
  'subagent/provider-added',
  'subagent/provider-removed',
  'subagent/run',
  'workflow/start',
  'workflow/agent-start',
  'workflow/agent-end',
  'workflow/end',
  'agent/start',
  'turn/start',
  'turn/end',
  'assistant/attempt',
  'user/message',
])

let totalEvents = 0
const typeCount = new Map()
const interesting = []

for (const dir of readdirSync(sessDir)) {
  const f = join(sessDir, dir, 'session.v3.jsonl.zstd')
  let buf
  try {
    buf = readFileSync(f)
  } catch {
    continue
  }
  let text = ''
  try {
    for (const fr of scanFrames(buf)) {
      text += (await zstd(buf.subarray(fr.start, fr.end))).toString('utf8')
    }
  } catch (e) {
    console.log(`[warn] ${dir}: ${e.message}`)
    continue
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    totalEvents++
    try {
      const ev = JSON.parse(line)
      const type = ev?.type
      if (typeof type === 'string') {
        typeCount.set(type, (typeCount.get(type) ?? 0) + 1)
        if (wantTypes.has(type)) {
          interesting.push({ file: dir.slice(0, 8), type, seq: ev.seq, turn: ev.turn, ts: ev.ts })
        }
      }
    } catch {
      // ignore
    }
  }
}

console.log(`扫描目录: ${sessDir}`)
console.log(`总事件数: ${totalEvents}`)
console.log(`\n=== 事件类型 TOP 25 ===`)
const sorted = [...typeCount.entries()].sort((a, b) => b[1] - a[1])
for (const [type, count] of sorted.slice(0, 25)) {
  console.log(`${String(count).padStart(4)}\t${type}`)
}

console.log(`\n=== 生命周期/节点相关事件 (${interesting.length}) ===`)
if (interesting.length === 0) {
  console.log('（无匹配事件）')
} else {
  for (const e of interesting.slice(0, 40)) {
    console.log(`${e.file}  ${e.type}  seq=${e.seq}  turn=${e.turn}`)
  }
}
