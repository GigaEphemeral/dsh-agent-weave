/**
 * 内存化图控制（MVP-4 问题四修复 3）。
 *
 * 相比 PAUSE/STOP 文件轮询（chain-runner），内存状态响应更快、无文件 IO。
 * 引擎节点边界检查 isPaused/isStopped；REST /pause|resume|stop 调用。
 */
export interface GraphControl {
  pause(): void
  resume(): void
  stop(): void
  isPaused(): boolean
  isStopped(): boolean
  /** 暂停时阻塞，resume/stop 后 resolve。 */
  waitForResume(): Promise<void>
}

const controls = new Map<string, GraphControl>()

export function getGraphControl(graphId: string): GraphControl {
  let ctrl = controls.get(graphId)
  if (!ctrl) {
    const state = { paused: false, stopped: false }
    const waiters: Array<() => void> = []
    ctrl = {
      pause: () => { state.paused = true },
      resume: () => {
        state.paused = false
        for (const w of waiters) w()
        waiters.length = 0
      },
      stop: () => {
        state.stopped = true
        state.paused = false
        for (const w of waiters) w()
        waiters.length = 0
      },
      isPaused: () => state.paused,
      isStopped: () => state.stopped,
      waitForResume: () => new Promise((resolve) => {
        if (!state.paused) resolve()
        else waiters.push(resolve)
      }),
    }
    controls.set(graphId, ctrl)
  }
  return ctrl
}

export function clearGraphControl(graphId: string): void {
  controls.delete(graphId)
}

/** 控制动作类型。 */
export type ControlAction = 'pause' | 'resume' | 'stop'

/** 控制事件订阅者（graphId → 回调集合）。 */
const listeners = new Map<string, Set<(action: ControlAction) => void>>()

/**
 * 订阅图控制事件（功能问题2 P1-8：暂停/终止通知运行中子代理，触发 interrupt）。
 * 返回取消订阅函数。
 */
export function subscribeControl(graphId: string, cb: (action: ControlAction) => void): () => void {
  const set = listeners.get(graphId) ?? new Set()
  set.add(cb)
  listeners.set(graphId, set)
  return () => {
    set.delete(cb)
    if (set.size === 0) listeners.delete(graphId)
  }
}

/** 控制当前活跃图（routes 用；功能问题2 P1-8：通知订阅者）。 */
export function controlActiveGraph(action: ControlAction, graphId: string): boolean {
  const ctrl = getGraphControl(graphId)
  if (action === 'pause') ctrl.pause()
  else if (action === 'resume') ctrl.resume()
  else ctrl.stop()
  // ★ 通知订阅者（暂停/终止 → 中止运行中子代理）
  const set = listeners.get(graphId)
  if (set) for (const cb of set) cb(action)
  return true
}
