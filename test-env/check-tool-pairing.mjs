// 检查 R2 子代理 session 的 tool/call 与 tool/result 配对（找 hang 的工具）
import { readFileSync } from 'node:fs'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'

const zstd = promisify(zstdDecompress)
const ZSTD_MAGIC = 0xFD2FB528
const file = process.argv[2]

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

const buf = readFileSync(file)
let text = ''
for (const fr of scanFrames(buf)) text += (await zstd(buf.subarray(fr.start, fr.end))).toString('utf8')

const calls = new Map()
console.log('=== 工具调用/结果配对 ===')
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  try {
    const ev = JSON.parse(line)
    if (ev.type === 'tool/call') {
      const callId = ev.data?.callId ?? ev.data?.message?.toolCalls?.[0]?.id
      const name = ev.data?.name ?? ev.data?.message?.toolCalls?.[0]?.name
      calls.set(String(callId), { name, hasResult: false })
      console.log(`call: id=${String(callId).slice(0, 20)} name=${name}`)
    } else if (ev.type === 'tool/result') {
      const callId = ev.data?.message?.toolCallId
      const existing = calls.get(String(callId))
      if (existing) { existing.hasResult = true; console.log(`result: id=${String(callId).slice(0, 20)} OK`) }
      else console.log(`result: id=${String(callId).slice(0, 20)} (UNPAIRED)`)
    }
  } catch { /* ignore */ }
}
console.log('\n=== 未完成工具调用（可能 hang）===')
let hung = 0
for (const [id, info] of calls) {
  if (!info.hasResult) { console.log(`HANG: id=${id.slice(0, 20)} name=${info.name}`); hung++ }
}
console.log(`共 ${calls.size} 个调用，${hung} 个未配对`)
