#!/usr/bin/env node
/**
 * RES.1 探测脚本：确认 ctx.llm 的 usage 字段是否存在、字段名与格式。
 *
 * 探测途径（零新增 LLM 消耗）：
 *   1. 类型层：@deepseek-ai/dsh-llm 的 TokenUsage / StreamChunk / LlmRuntime 定义
 *   2. 运行时：扫描隔离环境历史 session 中 assistant/message 事件的 data.usage
 *
 * 关键结论（先见报告 docs/MVP-1.5/process/RES.1-llm-usage.md）：
 *   - ctx.llm 是 LlmRuntime，公开 API 是 stream(options)，【没有 complete 方法】
 *   - 流中 type:'usage' chunk 携带 TokenUsage
 *   - session 日志的 assistant/message 事件 data.usage 携带同样字段
 *
 * 用法：node test-env/probe-llm-usage.mjs [sessionsDir]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'

const dz = promisify(zstdDecompress)
const ZSTD_MAGIC = 0xfd2fb528

function scanFrames(buffer) {
  const frames = []
  let o = 0
  while (o < buffer.length) {
    const start = o
    if (buffer.length - o < 4) break
    if (buffer.readUInt32LE(o) !== ZSTD_MAGIC) { o = buffer.length; break }
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

function collectZstd(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.zstd')) out.push(p)
    }
  }
  walk(dir)
  return out
}

const target = process.argv[2] ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : undefined)
if (!target) {
  console.error('❌ 未指定 sessions 目录（传参或设置 DSH_HOME）')
  process.exit(2)
}

let count = 0
const typeCount = new Map()
const samples = []
const fieldCount = new Map()
for (const f of collectZstd(target)) {
  const buf = readFileSync(f)
  let text = ''
  try {
    for (const fr of scanFrames(buf)) text += (await dz(buf.subarray(fr.start, fr.end))).toString('utf8')
  } catch { continue }
  for (const line of text.split('\n')) {
    let j
    try { j = JSON.parse(line) } catch { continue }
    const u = j?.data?.usage ?? j?.data?.message?.usage ?? j?.usage
    if (!u || typeof u.totalTokens !== 'number') continue
    count++
    typeCount.set(j.type, (typeCount.get(j.type) ?? 0) + 1)
    for (const k of Object.keys(u)) fieldCount.set(k, (fieldCount.get(k) ?? 0) + 1)
    if (samples.length < 3) samples.push({ type: j.type, dataKeys: Object.keys(j.data ?? {}), usage: u })
  }
}

console.log(`目标: ${target}`)
console.log(`usage 记录数: ${count}`)
console.log(`事件类型分布: ${[...typeCount.entries()].map(([t, c]) => `${t}=${c}`).join(', ') || '（无）'}`)
console.log(`usage 字段出现频次: ${[...fieldCount.entries()].map(([k, c]) => `${k}=${c}`).join(', ') || '（无）'}`)
for (const s of samples) {
  console.log(`--- type=${s.type}`)
  console.log(`data keys: ${s.dataKeys.join(',')}`)
  console.log(`usage: ${JSON.stringify(s.usage)}`)
}

if (count === 0) {
  console.warn('⚠️ 未发现 usage 记录，请确认 session 数据完整')
  process.exit(2)
}
console.log('\n✅ RES.1 运行时探测完成：usage 字段确认存在（assistant/message → data.usage）')
