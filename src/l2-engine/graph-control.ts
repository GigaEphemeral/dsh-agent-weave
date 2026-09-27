import { PauseError } from './subagent-waiter.js'

/**
 * 内存化图控制（MVP-4 问题四修复 3 + Bugs-V1 §9：AbortController 贯通）。
 *
 * 相比 PAUSE/STOP 文件轮询（chain-runner），内存状态响应更快、无文件 IO。
 * pause/stop 触发 AbortController.abort（打断当前 subagent，经 graphSignal 传递）；
 * reason 分流：pause→PauseError（可恢复），stop→Error（终止）。
 */
export interface GraphControl {
  pause(): void
  resume(): void
  stop(): void
  isPaused(): boolean
  isStopped(): boolean
  /** 图级控制信号（pause/stop 时 abort；resume 后重置）。 */
  getSignal(): AbortSignal
  /** 暂停时阻塞，resume/stop 后 resolve。 */
  waitForResume(): Promise<void>
}

interface ControlState {
  paused: boolean
  stopped: boolean
  controller: AbortController
  waiters: Array<() => void>
}

const controls = new Map<string, GraphControl>()

export function getGraphControl(graphId: string): GraphControl {
  let ctrl = controls.get(graphId)
  if (!ctrl) {
    const state: ControlState = { paused: false, stopped: false, controller: new AbortController(), waiters: [] }
    ctrl = {
      pause: () => {
        if (state.paused || state.stopped) return
        state.paused = true
        // ★ Bugs-V1 §9：pause → PauseError（可恢复；触发 interrupt）
        state.controller.abort(new PauseError('user-pause'))
      },
      resume: () => {
        if (state.stopped) return
        state.paused = false
        state.controller = new AbortController() // 重置信号
        for (const w of state.waiters) w()
        state.waiters.length = 0
      },
      stop: () => {
        if (state.stopped) return
        state.stopped = true
        state.paused = false
        // ★ Bugs-V1 §9：stop → 普通 Error（终止；触发 interrupt）
        state.controller.abort(new Error('user-stop'))
        for (const w of state.waiters) w()
        state.waiters.length = 0
      },
      isPaused: () => state.paused,
      isStopped: () => state.stopped,
      getSignal: () => state.controller.signal,
      waitForResume: () => new Promise((r) => {
        if (!state.paused) r()
        else state.waiters.push(r)
      }),
    }
    controls.set(graphId, ctrl)
  }
  return ctrl
}

export function clearGraphControl(graphId: string): void {
  controls.delete(graphId)
}

/** 控制当前活跃图（routes 用）。 */
export function controlActiveGraph(action: 'pause' | 'resume' | 'stop', graphId: string): boolean {
  const ctrl = getGraphControl(graphId)
  if (action === 'pause') ctrl.pause()
  else if (action === 'resume') ctrl.resume()
  else ctrl.stop()
  return true
}
