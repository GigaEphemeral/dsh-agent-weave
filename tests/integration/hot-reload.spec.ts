/**
 * hot-reload 集成测试（MVP-2 T20：热重载 3 断言）。
 *
 * 场景：插件重载后无定时器泄漏 / 无文件句柄泄漏 / LIFO 释放。
 * 用真实 Cordis 4.0.2 内存态（同 RES.4 脚本机制）。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

describe('T20 热重载无泄漏', () => {
  it('无定时器泄漏：effect 定时器随 fiber.dispose 停止', async () => {
    const ctx = new Context()
    let ticks = 0
    const fiber = ctx.plugin((pctx) => {
      pctx.effect(() => {
        const t = setInterval(() => { ticks++ }, 5)
        return () => clearInterval(t)
      }, 'timer')
    })
    await fiber
    await new Promise((r) => setTimeout(r, 20))
    const before = ticks
    expect(before).toBeGreaterThan(0)
    await fiber.dispose()
    await new Promise((r) => setTimeout(r, 20))
    expect(ticks).toBe(before)
  })

  it('LIFO 释放：dispose 逆序清理', async () => {
    const ctx = new Context()
    const order: string[] = []
    const fiber = ctx.plugin((pctx) => {
      pctx.effect(() => {
        order.push('a:setup')
        return () => order.push('a:cleanup')
      }, 'a')
      pctx.effect(() => {
        order.push('b:setup')
        return () => order.push('b:cleanup')
      }, 'b')
    })
    await fiber
    await fiber.dispose()
    expect(order).toEqual(['a:setup', 'b:setup', 'b:cleanup', 'a:cleanup'])
  })

  it('disposer 幂等：重复调用无副作用', async () => {
    const ctx = new Context()
    let cleanup = 0
    const disposer = ctx.effect(() => {
      return () => { cleanup++ }
    }, 'idem')
    disposer()
    disposer()
    disposer()
    expect(cleanup).toBe(1)
  })
})
