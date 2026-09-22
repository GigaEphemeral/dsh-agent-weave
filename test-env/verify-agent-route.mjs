#!/usr/bin/env node
/**
 * FIX.4 验证脚本：检查子代理 session 实际路由的 provider/model
 * 是否等于角色 YAML 中 model 指定的值（验证 agentRouteDefaults / 包装 provider 生效）。
 *
 * 数据来源（免跑真实链）：
 *   1. roles/*.yaml           → roleId → 期望 { provider, model }
 *   2. 主 session subagent/catalog 事件 → childId + label(含角色名)
 *   3. 子代理 session（childId 目录）request/header 事件 → 实际 { provider, model }
 *
 * 用法：
 *   $env:DSH_HOME = '...\test-env\dsh-home'
 *   node test-env/verify-agent-route.mjs [sessionsDir]
 *
 * 退出码：0 = 全部角色命中期望路由；1 = 存在偏差；2 = 数据不足
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'

const zstd = promisify(zstdDecompress)
const ZSTD_MAGIC = 0xfd2fb528
const __dirname = dirname(fileURLToPath(import.meta.url))

/** 解析多帧 zstd 的帧边界（复用 token-ledger 帧扫描逻辑）。 */
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

/** 递归收集所有含 session.v3.jsonl.zstd 的目录（sessions 下可能有多层）。 */
function collectSessionDirs(root) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) {
        if (readdirSync(p).includes('session.v3.jsonl.zstd')) out.push(p)
        else walk(p)
      }
    }
  }
  walk(root)
  return out
}

/** 读取一个 session 目录的完整文本（zstd 多帧解压）。失败返回 ''。 */
async function readSessionText(dirPath) {
  const f = join(dirPath, 'session.v3.jsonl.zstd')
  let buf
  try { buf = readFileSync(f) } catch { return '' }
  let text = ''
  try {
    for (const fr of scanFrames(buf)) text += (await zstd(buf.subarray(fr.start, fr.end))).toString('utf8')
  } catch { return '' }
  return text
}

/**
 * 解析角色 YAML 的 model 段（多行结构）：
 *   model:
 *     provider: huoshan-186
 *     model: DeepSeek-V4-Flash
 * 取缩进的 provider: / model: 行（顶层 `model:` 无值行会被忽略）。
 */
function parseRoleYamlModel(content) {
  const provider = content.match(/^\s+provider:\s*(\S+)\s*$/m)?.[1]
  const model = content.match(/^\s+model:\s*(\S+)\s*$/m)?.[1]
  return { provider: provider?.trim(), model: model?.trim() }
}

// ── 1. 读取角色 YAML → 期望路由 ─────────────────────────────
const rolesDir = resolve(__dirname, '../roles')
const expected = new Map() // roleId -> { provider, model }
for (const file of readdirSync(rolesDir)) {
  if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
  const content = readFileSync(join(rolesDir, file), 'utf8')
  const id = content.match(/^id:\s*(.+)$/m)?.[1]?.trim()
  const model = parseRoleYamlModel(content)
  if (id && model.provider && model.model) expected.set(id, model)
}

console.log(`📋 已加载 ${expected.size} 个角色定义：`)
for (const [id, m] of expected) console.log(`   ${id}: ${m.provider} / ${m.model}`)

// ── 2. 扫描 sessions ────────────────────────────────────────
const sessDir = process.argv[2]
  ?? (process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'sessions')
    : undefined)
if (!sessDir) {
  console.error('❌ 未设置 sessions 目录（传参或设置 DSH_HOME）')
  process.exit(2)
}
let sessionDirs
try { sessionDirs = collectSessionDirs(sessDir) } catch (e) {
  console.error(`❌ sessions 目录不可读: ${sessDir}: ${e.message}`)
  process.exit(2)
}
if (sessionDirs.length === 0) {
  console.error(`❌ sessions 目录下未找到任何 session.v3.jsonl.zstd: ${sessDir}`)
  process.exit(2)
}

// childId → 实际路由（目录名即 childId，可能有多次运行）
const actualByChild = new Map() // childId -> [{ provider, model, time }]
for (const dir of sessionDirs) {
  const text = await readSessionText(dir)
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (ev?.type === 'request/header') {
        const cfg = ev.data?.header?.config
        if (cfg?.provider && cfg?.model) {
          const childId = dir.split(/[\\/]/).pop()
          const list = actualByChild.get(childId) ?? []
          list.push({ provider: cfg.provider, model: cfg.model, time: ev.time })
          actualByChild.set(childId, list)
        }
      }
    } catch { /* 忽略非 JSON 行 */ }
  }
}

// catalog 事件 → childId + 角色名
const catalog = [] // { childId, roleId, time }
for (const dir of sessionDirs) {
  const text = await readSessionText(dir)
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (ev?.type === 'subagent/catalog') {
        const d = ev.data || {}
        const roleMatch = (d.label || '').match(/（([^）]+)）/)
        if (d.childId && roleMatch) catalog.push({ childId: d.childId, roleId: roleMatch[1], time: ev.time })
      }
    } catch { /* ignore */ }
  }
}

// ── 3. 汇总：roleId → 实际路由集合 ─────────────────────────
const actualByRole = new Map() // roleId -> Set('provider/model')
let linked = 0
for (const c of catalog) {
  const routes = actualByChild.get(c.childId)
  if (!routes?.length) continue
  linked++
  const set = actualByRole.get(c.roleId) ?? new Set()
  for (const r of routes) set.add(`${r.provider}/${r.model}`)
  actualByRole.set(c.roleId, set)
}

console.log(`\n📊 catalog→子代理关联数：${linked}（session 目录数 ${sessionDirs.length}）`)

// ── 4. 对比 ─────────────────────────────────────────────────
let passed = 0
let failed = 0
const failures = []
console.log('\n=== 角色 → 实际路由 vs 期望 ===')
for (const [roleId, exp] of expected) {
  const actuals = actualByRole.get(roleId)
  const joined = actuals ? [...actuals].join(' | ') : '（未找到运行记录）'
  const hit = actuals && actuals.has(`${exp.provider}/${exp.model}`)
  if (hit) {
    passed++
    console.log(`✅ ${roleId}: 期望 ${exp.provider}/${exp.model} → 实际 ${joined}`)
  } else {
    failed++
    failures.push(`${roleId}: 期望 ${exp.provider}/${exp.model}，实际 ${joined}`)
    console.log(`❌ ${roleId}: 期望 ${exp.provider}/${exp.model} → 实际 ${joined}`)
  }
}

console.log('\n═══════════════════════════════════════')
console.log(`📊 检查结果：角色数=${expected.size}  命中=${passed}  未命中=${failed}  关联子代理=${linked}`)
console.log('═══════════════════════════════════════')

if (failed > 0) {
  console.error('\n❌ 验证失败：')
  for (const f of failures) console.error(`   - ${f}`)
  process.exit(1)
}
if (passed === 0) {
  console.warn('⚠️ 无任何角色命中期望路由，请检查 session 数据')
  process.exit(2)
}
console.log('\n✅ FIX.4 验证通过：所有角色子代理的实际 model 与角色 YAML 指定一致')
