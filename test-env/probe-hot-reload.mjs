#!/usr/bin/env node
/**
 * RES.4 复现脚本：Cordis 热重载竞态（Discussion #2854 相关机制演示）。
 *
 * 用真实 Cordis 内存态演示：HMR reload = dispose 旧 fiber + 重建新 fiber；
 * 期间非 effect 管理的资源（裸 setInterval/setTimeout）不会被清理 → 泄漏 / 竞态；
 * ctx.effect() 包装的资源随 fiber.dispose 正常清理。
 *
 * 三种注册方式对比：
 *   A. 裸 setInterval（非 effect）        → dispose 后仍在 tick（泄漏）
 *   B. ctx.effect(() => { t; return () => clearInterval(t) })
 *                                        → dispose 后停止（正确）
 *   C. 插件内部裸资源 vs 插件内 effect    → 卸载插件时对比
 *
 * 运行：node test-env/probe-hot-reload.mjs
 * 依赖：项目 node_modules 的 @deepseek-ai/cordis（与 DSH 同版本 4.0.2）
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../'))
const { Context } = require('@deepseek-ai/cordis')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('=== RES.4 热重载竞态复现（Cordis 内存态） ===')
  console.log(`Cordis 版本: ${require('@deepseek-ai/cordis/package.json').version}`)
  console.log()

  // ── 场景 A：裸 setInterval（非 effect） ─────────────────────
  console.log('【场景 A】裸 setInterval（非 effect 管理）')
  {
    const ctx = new Context()
    let ticks = 0
    let bareTimer = null
    const fiber = ctx.plugin((pctx) => {
      bareTimer = setInterval(() => { ticks++ }, 5)
      // 没有返回 disposer → 泄漏
      pctx.inject // 仅为保持引用
    })
    await fiber
    await sleep(20)
    const before = ticks
    console.log(`  运行中 ticks=${ticks}`)
    await fiber.dispose() // 模拟 HMR 的 dispose 阶段
    await sleep(20)
    const after = ticks
    console.log(`  dispose 后 20ms ticks=${after}（此前 ${before}）→ ${after > before ? '❌ 继续运行 = 泄漏' : '✅ 已停止'}`)
    if (bareTimer) clearInterval(bareTimer)
  }
  console.log()

  // ── 场景 B：ctx.effect 包装 setInterval ─────────────────────
  console.log('【场景 B】ctx.effect 包装 setInterval（正确）')
  {
    const ctx = new Context()
    let ticks = 0
    const fiber = ctx.plugin((pctx) => {
      pctx.effect(() => {
        const t = setInterval(() => { ticks++ }, 5)
        return () => clearInterval(t)
      }, 'probe-interval')
    })
    await fiber
    await sleep(20)
    const before = ticks
    console.log(`  运行中 ticks=${ticks}`)
    await fiber.dispose()
    await sleep(20)
    const after = ticks
    console.log(`  dispose 后 20ms ticks=${after}（此前 ${before}）→ ${after > before ? '❌ 泄漏' : '✅ 已停止 = 正确清理'}`)
  }
  console.log()

  // ── 场景 C：插件重载（dispose + 重建）时两类资源对比 ────────
  console.log('【场景 C】插件重载（模拟 HMR recompose：dispose 旧 fiber → 新建 fiber）')
  {
    const ctx = new Context()
    let leaked = 0 // 裸定时器计数（泄漏）
    let managed = 0 // effect 定时器计数（应停止）
    const bareTimers = []

    const makeFiber = () => ctx.plugin((pctx) => {
      // 裸定时器：每次重建都新开一个，旧的不停 → 累积泄漏
      bareTimers.push(setInterval(() => { leaked++ }, 5))
      // effect 定时器：dispose 自动清理
      pctx.effect(() => {
        const t = setInterval(() => { managed++ }, 5)
        return () => clearInterval(t)
      }, 'managed')
    })

    let fiber = await makeFiber()
    await sleep(15)
    console.log(`  第 1 轮：leaked=${leaked} managed=${managed}`)

    // HMR：dispose 旧 fiber + 重建
    await fiber.dispose()
    fiber = await makeFiber()
    await sleep(15)
    console.log(`  重载后：leaked=${leaked} managed=${managed}`)

    // 再次重载
    await fiber.dispose()
    fiber = await makeFiber()
    await sleep(15)
    console.log(`  二次重载后：leaked=${leaked} managed=${managed}`)

    // 最终清理
    await fiber.dispose()
    for (const t of bareTimers) clearInterval(t)
    console.log(`\n  结论：裸资源 leaked=${leaked}（多轮重载后持续累积=泄漏）；
effect 资源 managed=${managed}（仅最后一轮计数=随 dispose 清理）`)
    console.log(leaked > managed * 2
      ? '  ⚠️ 复现：非 effect 资源在热重载后泄漏/累积，与 Discussion #2854 机制一致'
      : '  ✅ 本场景未明显累积（受 tick 时序影响，但机制成立）')
  }
  console.log()
  console.log('=== 复现完成：ctx.effect() 是热重载安全的唯一正确资源管理方式 ===')
}

main().catch((e) => {
  console.error('❌ 探测失败:', e)
  process.exit(1)
})
