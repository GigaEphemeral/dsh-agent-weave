/**
 * 右侧滑出编辑面板（MVP-5 Phase I，Client 侧；MVP-5B B6：决策 #7/#9）。
 *
 * 监听 window 'weave:task-proposed'（由看板全局 SSE 派发/或主 agent 工具返回后触发），
 * 在右侧滑出编辑面板：画布编辑 → 保存/开始工作。
 *
 * MVP-5B B6 变更：
 * - 决策 #7：面板打开时给 body 加 weave-panel-open 类，主区被挤压（margin-right），主 agent 仍可见
 * - 决策 #9：进入面板即 PATCH status=drafting（状态机语义对齐）
 */
import { useEffect, useState } from 'react'
import { CanvasEditor } from './CanvasEditor'
import type { TaskDraftView } from './WeaveTaskPanel'
import type { ClientGraphSpec } from '../types'

export function WeaveEditPanel() {
  const [task, setTask] = useState<TaskDraftView | null>(null)
  const [draftSpec, setDraftSpec] = useState<ClientGraphSpec | null>(null)

  // 决策 #7：主区挤压（body.weave-panel-open → main margin-right 720px）
  useEffect(() => {
    if (!task) return
    document.body.classList.add('weave-panel-open')
    return () => document.body.classList.remove('weave-panel-open')
  }, [task])

  // 决策 #9：进入面板即 drafting（B6）
  const patchDrafting = async (taskId: string): Promise<void> => {
    try {
      await fetch(`/api/weave/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'drafting' }),
      })
    } catch {
      // 状态更新失败不阻塞编辑
    }
  }

  const openTask = (d: TaskDraftView): void => {
    setTask(d)
    setDraftSpec(d.graph as ClientGraphSpec)
    void patchDrafting(d.taskId)
  }

  useEffect(() => {
    // 已有活跃任务（如页面刷新/历史 propose）→ 直接打开
    void fetch('/api/weave/tasks')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        const active = (list as TaskDraftView[]).find((t) => t.status === 'proposing' || t.status === 'drafting')
        if (active) openTask(active)
      })
      .catch(() => {})

    function onTaskProposed(e: Event): void {
      const detail = (e as CustomEvent<{ taskId: string }>).detail
      if (detail?.taskId) {
        void fetch(`/api/weave/tasks/${detail.taskId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d) openTask(d as TaskDraftView)
          })
          .catch(() => {})
      }
    }
    window.addEventListener('weave:task-proposed', onTaskProposed)
    return () => window.removeEventListener('weave:task-proposed', onTaskProposed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div className="weave-edit-panel" style={{
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
