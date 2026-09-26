/**
 * 状态驱动的 Tab 自动切换（MVP-5B UI 重构）。
 *
 * 只在关键转换切，不打扰用户手动选择：
 * - editing → running：切到运行
 * - 任何 → idle/editing：切到编排
 * - 首次从非运行态 → running（如恢复）：切到运行
 */
import { useEffect, useRef } from 'react'
import { setActiveTab, useBoardState } from '../state/board-state.js'
import type { TaskPhase } from '../state/board-state.js'

export function useTabRouter(): void {
  const { task, activeTab } = useBoardState()
  const prevPhase = useRef<TaskPhase>(task.phase)

  useEffect(() => {
    const prev = prevPhase.current
    const curr = task.phase
    prevPhase.current = curr

    // editing → running：切到运行
    if (prev === 'editing' && curr === 'running') {
      setActiveTab('runtime')
      return
    }
    // 任何 → idle/editing：切到编排
    if (curr === 'idle' || curr === 'editing') {
      if (activeTab !== 'canvas') setActiveTab('canvas')
      return
    }
    // 首次从 idle/completed/failed/stopped → running（例如恢复）：切到运行
    if ((prev === 'idle' || prev === 'completed' || prev === 'failed' || prev === 'stopped') && curr === 'running') {
      setActiveTab('runtime')
    }
    // 其他转换（running→paused→running）不主动切
  }, [task.phase]) // eslint-disable-line react-hooks/exhaustive-deps
}
