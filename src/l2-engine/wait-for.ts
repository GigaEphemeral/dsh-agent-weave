/**
 * 等待唤醒机制（MVP-3 P3.B.2）。
 *
 * A 挂起等待 B 的消息；B 完成后 wakeUp 唤醒 A。
 * 不用轮询——基于 Promise resolve 的等待队列 + 可选超时。
 */
export interface WaitFor<T = MessageDelivery> {
  /** 挂起等待匹配消息，返回 Promise；超时/中止则 reject。 */
  wait(predicate: (m: MessageDelivery) => boolean, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<MessageDelivery>
  /** 唤醒所有匹配的等待者（返回唤醒数）。 */
  wakeUp(msg: MessageDelivery): number
  /** 当前等待者数量。 */
  pendingCount(): number
}

/** 消息投递（等待匹配的最小形态）。 */
export interface MessageDelivery {
  id: string
  correlation_id: string
  from: string
  to: string
  type: string
  payload: { summary: string; artifact_ref?: string }
}

interface PendingWait<T> {
  predicate: (m: T) => boolean
  resolve: (m: T) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout | null
}

/** 创建等待唤醒器。 */
export function createWaitFor<T = MessageDelivery>(): WaitFor<T> {
  const pending: Array<PendingWait<T>> = []

  return {
    wait(predicate, opts) {
      return new Promise<T>((resolve, reject) => {
        const entry: PendingWait<T> = { predicate, resolve, reject, timer: null }
        // 超时
        if (opts?.timeoutMs) {
          entry.timer = setTimeout(() => {
            const i = pending.indexOf(entry)
            if (i >= 0) pending.splice(i, 1)
            reject(new Error(`等待消息超时（${opts.timeoutMs}ms）`))
          }, opts.timeoutMs)
        }
        // 外部中止
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            const i = pending.indexOf(entry)
            if (i >= 0) pending.splice(i, 1)
            if (entry.timer) clearTimeout(entry.timer)
            reject(new Error('等待被中止'))
          })
        }
        pending.push(entry)
      })
    },
    wakeUp(msg) {
      let woken = 0
      for (let i = pending.length - 1; i >= 0; i--) {
        const entry = pending[i]
        if (entry === undefined) continue
        if (entry.predicate(msg as T)) {
          if (entry.timer) clearTimeout(entry.timer)
          pending.splice(i, 1)
          entry.resolve(msg as T)
          woken++
        }
      }
      return woken
    },
    pendingCount() {
      return pending.length
    },
  }
}
