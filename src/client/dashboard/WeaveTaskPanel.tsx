/**
 * 任务草稿面板（MVP-5 Phase I：提议/编辑/开始/取消）。
 *
 * 自动刷新任务列表；收到 window 'weave:task-proposed' 自定义事件时立即刷新。
 * 开始/取消调用 REST；start 需要草稿携带 parentAgent（由主 agent 提议时写入）。
 */
import { useEffect, useState } from 'react'
import type { ClientGraphSpec } from '../types'

export interface TaskDraftView {
  taskId: string
  template: string
  status: string
  userInput: string
  graph: ClientGraphSpec
  error?: string
}

async function fetchTasks(): Promise<TaskDraftView[]> {
  try {
    const r = await fetch('/api/weave/tasks')
    if (!r.ok) return []
    const d = (await r.json()) as TaskDraftView[]
    return Array.isArray(d) ? d : []
  } catch {
    return []
  }
}

export function WeaveTaskPanel() {
  const [tasks, setTasks] = useState<TaskDraftView[]>([])

  const refresh = (): void => {
    void fetchTasks().then(setTasks)
  }

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 5000)
    const onProposed = (): void => refresh()
    window.addEventListener('weave:task-proposed', onProposed)
    return () => {
      clearInterval(timer)
      window.removeEventListener('weave:task-proposed', onProposed)
    }
  }, [])

  const action = (taskId: string, act: 'start' | 'cancel'): void => {
    void fetch(`/api/weave/tasks/${taskId}/${act}`, { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        if (!d?.ok) {
          // eslint-disable-next-line no-console
          console.warn('weave task action failed:', d?.error ?? 'unknown')
        }
        refresh()
      })
      .catch(() => refresh())
  }

  if (tasks.length === 0) {
    return <div className="weave-task-panel"><h3>任务草稿</h3><div style={{ color: '#888', fontSize: 12 }}>（暂无任务；主 agent 调用 weave_propose_task 后出现）</div></div>
  }

  return (
    <div className="weave-task-panel">
      <h3>任务草稿（{tasks.length}）</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
        {tasks.map((t) => (
          <div key={t.taskId} style={{ border: '1px solid #eee', borderRadius: 6, padding: 6, fontSize: 12 }}>
            <div><strong>[{t.status}]</strong> {t.template} <span style={{ color: '#888' }}>{t.taskId}</span></div>
            <div style={{ color: '#555' }}>{t.userInput}</div>
            <div style={{ color: '#888' }}>{t.graph.nodes.map((n) => n.id).join(' → ')}</div>
            {t.error && <div style={{ color: '#c00' }}>{t.error}</div>}
            {t.status === 'proposing' || t.status === 'drafting' ? (
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button onClick={() => action(t.taskId, 'start')}>开始工作</button>
                <button onClick={() => action(t.taskId, 'cancel')}>取消</button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}
