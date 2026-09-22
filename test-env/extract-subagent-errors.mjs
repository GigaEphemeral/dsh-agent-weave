// 提取子代理 session 的 assistant 相关事件（诊断 stop_reason=error）
import { readFileSync, readdirSync, statSync } from 'node:fs'
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

const dirs = readdirSync(sessDir).filter((d) => !d.startsWith('session-'))
// 只看最新的一批（按修改时间排序取前 6 个）
const withMtime = dirs.map((d) => {
  const f = join(sessDir, d, 'session.v3.jsonl.zstd')
  try {
    const st = statSync(f)
    return { d, mtime: st.mtimeMs }
  } catch { return { d, mtime: 0 } }
})
withMtime.sort((a, b) => b.mtime - a.mtime)

for (const { d: dir } of withMtime.slice(0, 6)) {
  const f = join(sessDir, dir, 'session.v3.jsonl.zstd')
  let buf
  try { buf = readFileSync(f) } catch { continue }
  let text = ''
  try {
    for (const fr of scanFrames(buf)) text += (await zstd(buf.subarray(fr.start, fr.end))).toString('utf8')
  } catch { continue }
  console.log(`\n========== 子代理 ${dir.slice(0, 8)} ==========`)
  const lines = text.split('\n').filter((l) => l.trim())
  for (const line of lines) {
    try {
      const ev = JSON.parse(line)
      const t = ev.type
      if (['assistant/attempt', 'assistant/message', 'turn/end', 'subagent/descriptor', 'request/context'].includes(t)) {
        const d = ev.data ?? ev
        const s = JSON.stringify(d)
        console.log(`  ${t}: ${s.slice(0, 500)}`)
      }
    } catch { /* ignore */ }
  }
}
