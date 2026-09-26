/**
 * 编排 Tab（MVP-5B UI 重构）：角色库 + 画布。
 * 运行中只读（readonly 透传 CanvasEditor + 顶部黄色横幅）。
 */
import { useEffect, useState } from 'react'
import { RoleLibraryPanel } from '../../dashboard/RoleLibraryPanel.js'
import { CanvasEditor } from '../../dashboard/CanvasEditor.js'
import { saveGraphDraft, getGraphDraft } from '../../dashboard/Persistence.js'
import { useGraphStream } from '../../hooks/useGraphStream.js'
import { useActivityFeed } from '../../hooks/useActivityFeed.js'
import type { CurrentTask } from '../../state/board-state.js'
import type { ClientGraphSpec } from '../../types.js'

export function CanvasPane({ task }: { task: CurrentTask }) {
  const readonly = task.phase !== 'idle' && task.phase !== 'editing'
  const [draft, setDraft] = useState<ClientGraphSpec | null>(null)
  // P4：运行时节点状态 + 活动（CanvasEditor 染色/气泡）
  const { snap } = useGraphStream(task.graphId)
  const activity = useActivityFeed(task.graphId)

  // 加载当前草稿图（taskId 优先；否则从 localStorage 恢复）
  useEffect(() => {
    if (!task.taskId) return
    const load = (): void => {
      const local = getGraphDraft(task.taskId as string)
      if (local?.spec) setDraft(local.spec as ClientGraphSpec)
    }
    fetch(`/api/weave/tasks/${task.taskId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.graph) setDraft(d.graph); else load() })
      .catch(load)
  }, [task.taskId])

  // 响应"保存图"事件（由 BoardToolbar 触发）
  useEffect(() => {
    const onSave = () => {
      if (!draft || !task.taskId) return
      saveGraphDraft(task.taskId, draft, task.userInput)
      void fetch('/api/weave/graphs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: task.taskId, spec: draft, meta: { name: task.userInput } }),
      })
    }
    window.addEventListener('weave:save-graph', onSave)
    return () => window.removeEventListener('weave:save-graph', onSave)
  }, [draft, task.taskId, task.userInput])

  // P5：草稿变化即持久化（防刷新丢失）
  const onGraphChange = (spec: ClientGraphSpec): void => {
    setDraft(spec)
    if (task.taskId) saveGraphDraft(task.taskId, spec, task.userInput)
  }

  return (
    <div className="canvas-pane">
      <aside className="role-sidebar">
        <RoleLibraryPanel readonly={readonly} />
      </aside>
      <div className="canvas-area">
        <CanvasEditor
          initialGraph={draft ?? null}
          onGraphChange={onGraphChange}
          readonly={readonly}
          {...(snap?.nodeStates ? { liveState: snap.nodeStates } : {})}
          liveActivity={activity}
        />
        {readonly && (
          <div className="readonly-banner">
            🔒 图运行中，编辑已锁定（点【终止】后可继续编辑）
          </div>
        )}
      </div>
    </div>
  )
}
