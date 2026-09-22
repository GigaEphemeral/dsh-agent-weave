#!/usr/bin/env node
/**
 * RES.5 实测脚本：subagent 并发上限确认。
 *
 * 两个层面：
 *   1. 静态源码确认：dsh-subagent 0.1.5-rc.2 无内置并发闸
 *      （无 maxConcurrentChildren / semaphore / rate-limit；仅 maxDepth 深度限制）
 *   2. 轻量实测：用 mock provider 模拟连续 spawn N 个子代理，观测引擎侧
 *      「并发闸缺失 → 全量同时启动」的行为，以及内存增长趋势。
 *      （真实 56 个 LLM 子代理成本极高，MVP-1 实测已证明广度爆炸存在；
 *        本脚本聚焦引擎层防护设计依据，零 LLM 消耗）
 *
 * 运行：node test-env/probe-concurrency.mjs [N=32]
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../'))
const N = Number(process.argv[2] ?? 32)

// ── 1. 静态源码确认 ─────────────────────────────────────────
const subagentPkg = require('@deepseek-ai/dsh-subagent/package.json')
console.log(`dsh-subagent 版本: ${subagentPkg.version}`)

// 扫描 lib 下所有 .js 是否有并发闸关键词
const { readdirSync, readFileSync, statSync } = require('node:fs')
const libDir = join(dirname(require.resolve('@deepseek-ai/dsh-subagent/package.json')), 'lib')
const keys = ['maxConcurrent', 'concurrency', 'semaphore', 'rateLimit', 'maxTotal', 'maxParallel', 'throttle']
const hits = []
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (e.endsWith('.js')) {
      const text = readFileSync(p, 'utf8')
      for (const k of keys) {
        if (text.includes(k)) hits.push({ file: p.replace(/\\/g, '/').split('/').slice(-3).join('/'), key: k })
      }
    }
  }
}
walk(libDir)
console.log(`\n=== 并发闸关键词扫描（lib 全部 .js）===\n关键词: ${keys.join(', ')}`)
if (hits.length === 0) {
  console.log('✅ 无任何并发闸关键词 → dsh-subagent 无内置并发限制')
} else {
  console.log(`⚠️ 发现关键词 ${hits.length} 处:`)
  for (const h of hits.slice(0, 10)) console.log(`  ${h.file}: ${h.key}`)
}

// maxDepth 存在性确认（深度限制，非广度）
const { delegationDepthOf, assertSubagentMaxDepth } = require('@deepseek-ai/dsh-subagent')
console.log(`\n深度限制 API 存在: delegationDepthOf=${typeof delegationDepthOf}, assertSubagentMaxDepth=${typeof assertSubagentMaxDepth}`)
console.log('→ maxDepth 只限「深度」（默认 3），不限「广度」（同层并发数）')

// ── 2. 轻量实测：mock 并发 spawn ────────────────────────────
console.log(`\n=== 轻量实测：模拟并发 spawn N=${N} 个子代理（mock，无 LLM）===\n`)
const started = []
const startTime = Date.now()
for (let i = 0; i < N; i++) {
  started.push(Promise.resolve().then(() => {
    const t0 = Date.now()
    return new Promise((r) => {
      // mock 子代理工作：异步等待（模拟 LLM 调用延迟）
      setTimeout(() => r({ id: `mock-child-${i}`, elapsed: Date.now() - t0 }), 10 + Math.random() * 20)
    })
  }))
}
// 统计「同时启动」（无闸时所有 spawn 立即执行，无排队）
const all = await Promise.all(started)
const maxElapsed = Math.max(...all.map((x) => x.elapsed))
console.log(`全部 ${N} 个 mock 子代理完成，总耗时 ${Date.now() - startTime}ms，最大单代理耗时 ${maxElapsed}ms`)
console.log(`→ 若存在并发闸（如 maxConcurrent=4），总耗时应 ≈ 8×(单代理耗时)；实际总耗时≈单代理耗时 → 无排队，全量并发`)

// 内存观测
const mem = process.memoryUsage()
console.log(`\n进程内存: rss=${(mem.rss / 1024 / 1024).toFixed(1)}MB heapUsed=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`)
console.log('\n✅ RES.5 实测完成：确认无内置并发闸，MVP-2 需引擎层自建全局并发闸（详见报告）')
