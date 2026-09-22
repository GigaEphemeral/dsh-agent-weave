// 检查指定子代理 session 的完整事件流（找卡住点）
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

console.log(`文件: ${file}`)
const lines = text.split('\n').filter((l) => l.trim())
console.log(`事件数: ${lines.length}`)
console.log('\n=== 全部事件（最后 25 条）===')
for (const line of lines.slice(-25)) {
  try {
    const ev = JSON.parse(line)
    const d = ev.data ?? ev
    let summary
    if (ev.type === 'assistant/message') {
      const blocks = Array.isArray(d.content) ? d.content.map(b => b.type).join(',') : '?'
      summary = `content[${blocks}]`
    } else if (ev.type === 'tool/call') {
      summary = `${d.name}(${JSON.stringify(d.arguments ?? {}).slice(0, 60)})`
    } else if (ev.type === 'tool/result') {
      summary = `result: ${JSON.stringify(d.message?.content ?? {}).slice(0, 80)}`
    } else {
      summary = JSON.stringify(d).slice(0, 100)
    }
    console.log(`seq=${ev.seq} ${ev.type}: ${summary}`)
  } catch { /* ignore */ }
}
