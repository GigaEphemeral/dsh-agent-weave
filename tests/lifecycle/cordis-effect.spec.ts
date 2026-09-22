/**
 * Cordis 生命周期验证（P1.1.7 验收）。
 *
 * 用真实 Cordis 4.0.2 运行时验证：
 * - ctx.effect() 注册后 disposer 在注销时被调用
 * - 多个 effect 按 LIFO 顺序释放
 * - disposer 幂等（重复调用无副作用）
 * - 插件卸载（fiber.dispose()）触发全部 effect 清理，无资源泄漏
 *
 * 隔离性：仅 new Context() 内存态，不触碰 DSH_HOME / 主环境。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

describe('Cordis 生命周期（P1.1.7）', () => {
  it('ctx.effect() 注册/注销：disposer 被调用', () => {
    const ctx = new Context()
    const cleanup = vi.fn()
    const disposer = ctx.effect(() => {
      const t = setInterval(() => {}, 1000)
      return () => {
        clearInterval(t)
        cleanup()
      }
    }, 'test-interval')
    expect(cleanup).not.toHaveBeenCalled()
    disposer()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('disposer 幂等：重复调用无副作用', () => {
    const ctx = new Context()
    const cleanup = vi.fn()
    const disposer = ctx.effect(() => {
      return () => cleanup()
    }, 'idempotent')
    disposer()
    disposer()
    disposer()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('插件卸载（fiber.dispose）触发全部 effect 清理且 LIFO', async () => {
    const ctx = new Context()
    const order: string[] = []
    const fiber = ctx.plugin((pctx) => {
      pctx.effect(() => {
        order.push('a:setup')
        return () => order.push('a:cleanup')
      }, 'plugin-a')
      pctx.effect(() => {
        order.push('b:setup')
        return () => order.push('b:cleanup')
      }, 'plugin-b')
    })
    await fiber
    expect(order).toEqual(['a:setup', 'b:setup'])

    await fiber.dispose()
    // 卸载时 disposer 逆序（LIFO）：b 先清理，a 后清理
    expect(order).toEqual(['a:setup', 'b:setup', 'b:cleanup', 'a:cleanup'])
  })

  it('真实定时器清理：setInterval 随插件卸载停止', async () => {
    const ctx = new Context()
    let ticks = 0
    const fiber = ctx.plugin((pctx) => {
      pctx.effect(() => {
        const t = setInterval(() => {
          ticks++
        }, 5)
        return () => clearInterval(t)
      }, 'ticker')
    })
    await fiber
    await new Promise((r) => setTimeout(r, 30))
    expect(ticks).toBeGreaterThan(0)
    const before = ticks
    await fiber.dispose()
    await new Promise((r) => setTimeout(r, 30))
    expect(ticks).toBe(before) // 卸载后不再 tick
  })

  it('异步 effect 清理被 await', async () => {
    const ctx = new Context()
    let done = false
    const fiber = ctx.plugin((pctx) => {
      pctx.effect(async () => {
        await Promise.resolve()
        return async () => {
          await Promise.resolve()
          done = true
        }
      }, 'async-effect')
    })
    await fiber
    expect(done).toBe(false)
    await fiber.dispose()
    expect(done).toBe(true)
  })
})
