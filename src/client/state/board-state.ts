/**
 * Weave 看板全局状态（MVP-5B UI 重构，唯一真相源）。
 *
 * 所有组件通过 useBoardState() / useCurrentTask() 读取，不直接维护重复状态。
 */
import { useSyncExternalStore } from 'react'

export type TaskPhase =
  | 'idle' | 'editing' | 'running' | 'paused'
  | 'awaiting' | 'completed' | 'failed' | 'stopped'

export interface CurrentTask {
  taskId: string | null
  graphId: string | null
  phase: TaskPhase
  userInput: string
  template: string
}

interface BoardState {
  task: CurrentTask
  activeTab: 'canvas' | 'runtime' | 'artifacts' | 'history'
  selectedNodeId: string | null
}

const initial: BoardState = {
  task: { taskId: null, graphId: null, phase: 'idle', userInput: '', template: '' },
  activeTab: 'canvas',
  selectedNodeId: null,
}

let state: BoardState = initial
const listeners = new Set<() => void>()

function emit(): void { for (const l of listeners) l() }
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// ─── 操作 ──────────────────────────────────────────────

export function setCurrentTask(patch: Partial<CurrentTask>): void {
  state = { ...state, task: { ...state.task, ...patch } }
  emit()
}

export function clearTask(): void {
  state = { ...state, task: initial.task, selectedNodeId: null }
  emit()
}

export function setActiveTab(tab: BoardState['activeTab']): void {
  if (state.activeTab === tab) return
  state = { ...state, activeTab: tab }
  emit()
}

export function setSelectedNode(id: string | null): void {
  state = { ...state, selectedNodeId: id }
  emit()
}

// ─── Hooks ─────────────────────────────────────────────

export function useBoardState(): BoardState {
  return useSyncExternalStore(subscribe, () => state)
}

export function useCurrentTask(): CurrentTask {
  return useSyncExternalStore(subscribe, () => state.task)
}
