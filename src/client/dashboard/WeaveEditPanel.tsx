/**
 * 右侧滑出编辑面板（MVP-5 Phase I，Client 侧）。
 *
 * 监听 window 'weave:task-proposed'（由看板全局 SSE 派发/或主 agent 工具返回后触发），
 * 在右侧滑出编辑面板：画布编辑 → 保存/开始工作。
 * 依赖宿主 Slots 的“自动激活”探测（PR-5.6）前，先作为看板内抽屉可用。
 */
import { useEffect, useState } from 'react'
import { CanvasEditor } from './CanvasEditor'
import type { TaskDraftView } from './WeaveTaskPanel'
import type { ClientGraphSpec } from '../types'
// (no-op) 保留类型导入

export function WeaveEditPanel() {
  const [task, setTask] = useState<TaskDraftView | null>(null)
  const [draftSpec, setDraftSpec] = useState<ClientGraphSpec | null>(null)

  useEffect(() => {
    // 已有活跃任务（如页面刷新/历史 propose）→ 直接打开
    void fetch('/api/weave/tasks')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        const active = (list as TaskDraftView[]).find((t) => t.status === 'proposing' || t.status === 'drafting')
        if (active) {
          setTask(active)
          setDraftSpec(active.graph)
        }
      })
      .catch(() => {})

    function onTaskProposed(e: Event): void {
      const detail = (e as CustomEvent<{ taskId: string }>).detail
      if (detail?.taskId) {
        void fetch(`/api/weave/tasks/${detail.taskId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d) {
              setTask(d as TaskDraftView)
              setDraftSpec(d.graph as ClientGraphSpec)
            }
          })
          .catch(() => {})
      }
    }
    window.addEventListener('weave:task-proposed', onTaskProposed)
    return () => window.removeEventListener('weave:task-proposed', onTaskProposed)
  }, [])

  if (!task) return null

  const close = (): void => setTask(null)

  const saveGraph = async (): Promise<void> => {
    if (!draftSpec) return
    await fetch('/api/weave/graphs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.taskId, spec: draftSpec, meta: { name: task.userInput } }),
    })
  }

  const start = async (): Promise<void> => {
    if (!draftSpec) return
    await fetch(`/api/weave/tasks/${task.taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: draftSpec, status: 'drafting' }),
    })
    const r = await fetch(`/api/weave/tasks/${task.taskId}/start`, { method: 'POST' })
    const d = (await r.json()) as { ok?: boolean; error?: string }
    if (!d.ok) {
      // eslint-disable-next-line no-console
      console.warn('start failed:', d.error)
      return
    }
    close()
  }

  const cancel = async (): Promise<void> => {
    await fetch(`/api/weave/tasks/${task.taskId}/cancel`, { method: 'POST' })
    close()
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      width: 720,
      maxWidth: '92vw',
      background: '#fff',
      borderLeft: '1px solid #e2e8f0',
      boxShadow: '-8px 0 24px rgba(0,0,0,.12)',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
      padding: 12,
      gap: 8,
    }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>编辑工作流：{task.template}</h3>
        <button onClick={close} style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer' }}>×</button>
      </header>
      <div style={{ color: '#64748b', fontSize: 12 }}>{task.userInput}</div>
      <CanvasEditor initialGraph={task.graph} onGraphChange={setDraftSpec} />
      <footer style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={() => void cancel()} style={{ padding: '6px 12px', cursor: 'pointer' }}>取消</button>
        <button onClick={() => void saveGraph()} style={{ padding: '6px 12px', cursor: 'pointer' }}>保存图</button>
        <button onClick={() => void start()} style={{ padding: '6px 16px', cursor: 'pointer', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6 }}>开始工作</button>
      </footer>
    </div>
  )
}
