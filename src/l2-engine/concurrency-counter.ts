/**
 * 全局并发闸（MVP-2 T8，RES.5 §四引擎层全局并发计数）。
 *
 * 官方 dsh-subagent 无内置并发闸（RES.5 实测），MVP-2 引擎层自建：
 * - createConcurrencyCounter：基础计数（超限 acquire 返回 false）
 * - createQueueingCounter：增强版，超限时入队等待（FIFO）
 *
 * 关键约束（RES.4 检查清单）：
 * - ctx.effect() 注册清理（插件卸载/热重载时归零）
 * - release() 成对调用（引擎在 try/finally 中保证）
 */
import type { Context } from '@deepseek-ai/cordis'

export interface ConcurrencyCounter {
  /** 尝试获取一个并发位；未超限返回 true，超限返回 false。 */
  acquire(): Promise<boolean>
  /** 释放一个并发位。 */
  release(): void
  /** 当前活跃数。 */
  getActive(): number
  /** 并发上限。 */
  getLimit(): number
}

/** 基础并发计数器：超限拒绝（不等待）。 */
export function createConcurrencyCounter(ctx: Context, limit: number): ConcurrencyCounter {
  let active = 0

  // RES.4 检查清单第 1/6 项：effect 清理
  ctx.effect(() => {
    return () => {
      active = 0
    }
  })

  return {
    async acquire(): Promise<boolean> {
      if (active >= limit) {
        ctx.logger.warn('concurrency', '并发计数超限，拒绝激活', { active, limit })
        return false
      }
      active++
      return true
    },
    release(): void {
      if (active > 0) active--
    },
    getActive(): number {
      return active
    },
    getLimit(): number {
      return limit
    },
  }
}

/** 带等待队列的并发闸（RES.5 §四增强，可选）。 */
export interface QueueingConcurrencyCounter extends ConcurrencyCounter {
  /** 等待队列长度。 */
  getQueueLength(): number
}

/** 排队版并发闸：超限时入队等待，release 时唤醒队首（FIFO）。 */
export function createQueueingCounter(ctx: Context, limit: number): QueueingConcurrencyCounter {
  let active = 0
  const queue: Array<() => void> = []

  ctx.effect(() => {
    return () => {
      active = 0
      queue.length = 0
    }
  })

  return {
    async acquire(): Promise<boolean> {
      if (active < limit) {
        active++
        return true
      }
      // 排队等待：release 会唤醒
      return new Promise<boolean>((resolve) => {
        queue.push(() => {
          active++
          resolve(true)
        })
      })
    },
    release(): void {
      if (active > 0) active--
      const next = queue.shift()
      if (next !== undefined) {
        // 把刚释放的并发位移交给队首
        next()
      }
    },
    getActive(): number {
      return active
    },
    getLimit(): number {
      return limit
    },
    getQueueLength(): number {
      return queue.length
    },
  }
}
