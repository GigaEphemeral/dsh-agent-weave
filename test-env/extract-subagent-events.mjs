// 提取 subagent 相关事件的详细内容（验证 chat 节点标识）
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

const types = ['subagent/descriptor', 'subagent/catalog', 'tool/call', 'tool/result']

for (const dir of readdirSync(sessDir)) {
  const f = join(sessDir, dir, 'session.v3.jsonl.zstd')
  let buf
  try {
    buf = readFileSync(f)
  } catch { continue }
  let text = ''
  try {
    for (const fr of scanFrames(buf)) text += (await zstd(buf.subarray(fr.start, fr.end))).toString('utf8')
  } catch { continue }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (types.includes(ev?.type)) {
        console.log(`=== ${dir.slice(0, 8)} ${ev.type} seq=${ev.seq} ===`)
        console.log(JSON.stringify(ev.data ?? ev).slice(0, 400))
        console.log()
      }
    } catch { /* ignore */ }
  }
}
