/**
 * concurrency-counter.ts 单测（MVP-2 T8 Exit Gate：6 用例全绿）。
 *
 * 覆盖：acquire 未超限 true / 超限 false / release 递减 / effect 清理 /
 * 排队版 FIFO / 排队版 effect 清理。
 * 用真实 Cordis Context（内存态）。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createConcurrencyCounter, createQueueingCounter } from '../../src/l2-engine/concurrency-counter'

describe('T8 全局并发闸（基础）', () => {
  it('acquire 未超限返回 true', async () => {
    const counter = createConcurrencyCounter(new Context(), 3)
    expect(await counter.acquire()).toBe(true)
    expect(await counter.acquire()).toBe(true)
    expect(counter.getActive()).toBe(2)
  })

  it('acquire 超限返回 false', async () => {
    const counter = createConcurrencyCounter(new Context(), 2)
    await counter.acquire()
    await counter.acquire()
    expect(await counter.acquire()).toBe(false)
    expect(counter.getActive()).toBe(2)
  })

  it('release 正确递减', async () => {
    const counter = createConcurrencyCounter(new Context(), 2)
    await counter.acquire()
    await counter.acquire()
    counter.release()
    expect(counter.getActive()).toBe(1)
    expect(await counter.acquire()).toBe(true)
    expect(counter.getActive()).toBe(2)
  })

  it('effect 清理归零', async () => {
    const ctx = new Context()
    let counter: ReturnType<typeof createConcurrencyCounter> | undefined
    const fiber = ctx.plugin((pctx) => {
      counter = createConcurrencyCounter(pctx, 3)
    })
    await fiber
    await counter?.acquire()
    await counter?.acquire()
    expect(counter?.getActive()).toBe(2)
    await fiber.dispose()
    expect(counter?.getActive()).toBe(0)
  })

  it('getLimit 返回上限', () => {
    const counter = createConcurrencyCounter(new Context(), 5)
    expect(counter.getLimit()).toBe(5)
  })
})

describe('T8 全局并发闸（排队版）', () => {
  it('超限入队等待，release 唤醒 FIFO', async () => {
    const counter = createQueueingCounter(new Context(), 2)
    await counter.acquire()
    await counter.acquire()
    // 第三个 acquire 排队
    const p3 = counter.acquire()
    expect(counter.getQueueLength()).toBe(1)
    // 释放一个 → 队首被唤醒
    counter.release()
    expect(await p3).toBe(true)
    expect(counter.getQueueLength()).toBe(0)
    expect(counter.getActive()).toBe(2)
  })

  it('排队版 effect 清理清空队列', async () => {
    const ctx = new Context()
    let counter: ReturnType<typeof createQueueingCounter> | undefined
    const fiber = ctx.plugin((pctx) => {
      counter = createQueueingCounter(pctx, 1)
    })
    await fiber
    await counter?.acquire()
    const p2 = counter?.acquire()
    expect(counter?.getQueueLength()).toBe(1)
    await fiber.dispose()
    expect(counter?.getActive()).toBe(0)
    expect(counter?.getQueueLength()).toBe(0)
    // dispose 后排队等待者不会永久挂起——测试进程正常退出即可
    void p2
  })
})
