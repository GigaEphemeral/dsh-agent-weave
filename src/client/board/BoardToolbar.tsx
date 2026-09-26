/**
 * 看板工具栏（MVP-5B UI 重构）：状态标题 + 按 phase 的上下文按钮。
 */
import { useState } from 'react'
import type { CurrentTask, TaskPhase } from '../state/board-state.js'
import { setActiveTab, setCurrentTask, clearTask } from '../state/board-state.js'

const TITLES: Record<TaskPhase, string> = {
  idle: '未启动任务',
  editing: '编辑工作流',
  running: '运行中',
  paused: '已暂停',
  awaiting: '等待用户确认',
  completed: '已完成',
  failed: '执行失败',
  stopped: '已终止',
}

export function BoardToolbar({ task }: { task: CurrentTask }) {
  const [loading, setLoading] = useState<string | null>(null)
  const phase = task.phase

  const call = async (action: string, fn: () => Promise<void>): Promise<void> => {
    setLoading(action)
    try { await fn() } finally { setLoading(null) }
  }

  const handleNew = () => {
    clearTask()
    setActiveTab('canvas')
    // 提示主 agent：用户想新建任务（走正常 weave_propose_task 流程）
    window.dispatchEvent(new CustomEvent('weave:new-task'))
  }

  const handleStart = () => call('start', async () => {
    if (!task.taskId) return
    const r = await fetch(`/api/weave/tasks/${task.taskId}/start`, { method: 'POST' })
    const d = await r.json() as { ok?: boolean; error?: string; graphId?: string }
    if (!d.ok) { window.alert(d.error ?? '启动失败'); return }
    setCurrentTask({ phase: 'running', graphId: d.graphId ?? null })
  })

  const handlePause = () => call('pause', async () => {
    if (!task.graphId) return
    await fetch(`/api/weave/graph/${task.graphId}/pause`, { method: 'POST' })
    setCurrentTask({ phase: 'paused' })
  })

  const handleResume = () => call('resume', async () => {
    if (!task.graphId) return
    await fetch(`/api/weave/graph/${task.graphId}/resume`, { method: 'POST' })
    setCurrentTask({ phase: 'running' })
  })

  const handleStop = () => call('stop', async () => {
    if (!task.graphId) return
    await fetch(`/api/weave/graph/${task.graphId}/stop`, { method: 'POST' })
    setCurrentTask({ phase: 'stopped' })
  })

  const handleCancel = () => call('cancel', async () => {
    if (!task.taskId) return
    await fetch(`/api/weave/tasks/${task.taskId}/cancel`, { method: 'POST' })
    clearTask()
  })

  const handleSaveGraph = () => call('save', async () => {
    window.dispatchEvent(new CustomEvent('weave:save-graph'))
  })

  const buttons: Array<{ id: string; label: string; kind?: 'primary' | 'danger'; onClick: () => void }> = []
  if (phase === 'idle') {
    buttons.push({ id: 'new', label: '新建任务', kind: 'primary', onClick: handleNew })
  } else if (phase === 'editing') {
    buttons.push(
      { id: 'cancel', label: '取消', onClick: handleCancel },
      { id: 'save', label: '保存图', onClick: handleSaveGraph },
      { id: 'start', label: '开始工作', kind: 'primary', onClick: handleStart },
    )
  } else if (phase === 'running') {
    buttons.push(
      { id: 'pause', label: '暂停', onClick: handlePause },
      { id: 'stop', label: '终止', kind: 'danger', onClick: handleStop },
    )
  } else if (phase === 'paused') {
    buttons.push(
      { id: 'resume', label: '恢复', kind: 'primary', onClick: handleResume },
      { id: 'stop', label: '终止', kind: 'danger', onClick: handleStop },
    )
  } else if (phase === 'awaiting') {
    buttons.push({ id: 'stop', label: '终止', kind: 'danger', onClick: handleStop })
  } else if (phase === 'completed') {
    buttons.push(
      { id: 'viewArtifacts', label: '查看产物', onClick: () => setActiveTab('artifacts') },
      { id: 'new', label: '新建任务', kind: 'primary', onClick: handleNew },
    )
  } else if (phase === 'failed') {
    buttons.push(
      { id: 'viewLogs', label: '查看日志', onClick: () => setActiveTab('runtime') },
      { id: 'new', label: '新建任务', kind: 'primary', onClick: handleNew },
    )
  } else if (phase === 'stopped') {
    buttons.push({ id: 'new', label: '新建任务', kind: 'primary', onClick: handleNew })
  }

  return (
    <header className="board-toolbar">
      <div className="toolbar-left">
        <span className={`status-dot ${phase}`} />
        <span className="board-title">{TITLES[phase]}</span>
        {task.taskId && <span className="task-chip">{task.taskId}</span>}
      </div>
      <div className="toolbar-right">
        {buttons.map((b) => (
          <button
            key={b.id}
            className={`btn${b.kind ? ' ' + b.kind : ''}`}
            onClick={b.onClick}
            disabled={loading !== null}
          >
            {b.label}
          </button>
        ))}
      </div>
    </header>
  )
}
