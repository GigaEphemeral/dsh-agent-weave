# Weave 看板重构方案 + 完整代码

## 一、方案总览

### 1.1 目标

**彻底替换 MVP-4 遗留的 `WeaveDashboardView`（9 面板 grid 塞满）和 `WeaveEditPanel`（右侧抽屉），改为 4 Tab 全屏工作台。**

### 1.2 目录变更

```
src/client/
├── index.tsx                    【重写】挂载 WeaveBoard + 3 个浮层
├── board/                       【新建】看板全部组件
│   ├── WeaveBoard.tsx
│   ├── BoardToolbar.tsx
│   ├── BoardTabs.tsx
│   ├── BoardOverlays.tsx
│   ├── ActivityStream.tsx
│   ├── board.css
│   └── panes/
│       ├── CanvasPane.tsx
│       ├── RuntimePane.tsx
│       ├── ArtifactsPane.tsx
│       └── HistoryPane.tsx
├── hooks/
│   ├── useCurrentTask.ts        【新建】任务状态
│   ├── useTabRouter.ts          【新建】自动切 Tab
│   ├── useRuntimeMetrics.ts     【新建】运行时指标
│   ├── useGraphStream.ts        【保留】
│   └── useActivityFeed.ts       【保留】
├── dashboard/                   【清理】
│   ├── CanvasEditor.tsx         【保留】+ 加 readonly prop
│   ├── canvas-model.ts          【保留】
│   ├── RoleLibraryPanel.tsx     【保留】精简
│   ├── RoleEditor.tsx           【保留】
│   ├── HandoffViewer.tsx        【保留】
│   ├── UserQuestionModal.tsx    【保留】
│   ├── TokenPanel.tsx           【保留】样式微调
│   ├── ApprovalPanel.tsx        【保留】样式微调
│   ├── SignalPanel.tsx          【保留】
│   ├── MessageFlowPanel.tsx     【保留】
│   ├── RunHistoryPanel.tsx      【保留】
│   ├── RestorePanel.tsx         【保留】
│   ├── NodeEditorModal.tsx      【新建】从 CanvasEditor 抽出
│   ├── ErrorBoundary.tsx        【保留】
│   ├── WeaveDashboardView.tsx   【删除】
│   ├── WeaveEditPanel.tsx       【删除】
│   ├── ControlBar.tsx           【删除】
│   ├── WeaveDashboardButton.tsx 【删除】
│   ├── WeaveTaskPanel.tsx       【删除】（并入 HistoryPane）
│   ├── NodeActivityPanel.tsx    【删除】（并入 ActivityStream）
│   ├── GraphCanvas.tsx          【删除】（只读画布不再需要，运行 Tab 用 ActivityStream 为主）
│   └── dashboard-state.ts       【删除】
└── state/
    ├── types.ts                 【保留】
    └── board-state.ts           【新建】全局状态（当前 task / graphId / activeTab）
```

### 1.3 数据流

```
DSH 会话
  ↓ SSE: task-proposed
  ↓
index.tsx 全局 SSE 订阅
  ↓ dispatch window CustomEvent
board-state.setCurrentTask(taskId)
  ↓
WeaveBoard 渲染 → useTabRouter 自动切「编排」Tab
  ↓
CanvasPane → 用户编辑 → POST /tasks/:id/start
  ↓
useTabRouter 侦测 phase=running → 自动切「运行」Tab
  ↓
RuntimePane → SSE 实时显示
  ↓
graph-end(completed) → 运行 Tab 顶部横幅「查看产物→」
  ↓
用户点 → switchTab('artifacts')
```

### 1.4 状态机（任务 → Tab）

| phase | 编排 | 运行 | 产物 | 历史 | 自动切 |
|---|---|---|---|---|---|
| idle | 可编辑 | 隐藏 | 隐藏 | 可看 | 编排 |
| editing | 可编辑 | 隐藏 | 隐藏 | 可看 | 编排 |
| running | **只读** | 可看 | 可看 | 可看 | **运行** |
| paused | 只读 | 可看 | 可看 | 可看 | — |
| awaiting | 只读 | 可看 | 可看 | 可看 | — |
| completed | 只读 | 可看 | 可看 | 可看 | — |
| failed | 只读 | 可看 | 可看 | 可看 | — |
| stopped | 只读 | 可看 | 可看 | 可看 | — |

---

## 二、完整代码

### 2.1 `src/client/state/board-state.ts`

```typescript
// src/client/state/board-state.ts
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
```

### 2.2 `src/client/hooks/useTabRouter.ts`

```typescript
// src/client/hooks/useTabRouter.ts
import { useEffect, useRef } from 'react'
import { setActiveTab, useBoardState } from '../state/board-state'
import type { TaskPhase } from '../state/board-state'

/** 状态驱动的 Tab 自动切换（只在关键转换切，不打扰用户手动选择）。 */
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
    // 首次从 idle → running（例如恢复）：切到运行
    if ((prev === 'idle' || prev === 'completed' || prev === 'failed' || prev === 'stopped') && curr === 'running') {
      setActiveTab('runtime')
    }
    // 其他转换（running→paused→running）不主动切
  }, [task.phase]) // eslint-disable-line react-hooks/exhaustive-deps
}
```

### 2.3 `src/client/board/WeaveBoard.tsx`

```tsx
// src/client/board/WeaveBoard.tsx
import { BoardToolbar } from './BoardToolbar.js'
import { BoardTabs } from './BoardTabs.js'
import { CanvasPane } from './panes/CanvasPane.js'
import { RuntimePane } from './panes/RuntimePane.js'
import { ArtifactsPane } from './panes/ArtifactsPane.js'
import { HistoryPane } from './panes/HistoryPane.js'
import { ErrorBoundary } from '../dashboard/ErrorBoundary.js'
import { useBoardState } from '../state/board-state.js'
import { useTabRouter } from '../hooks/useTabRouter.js'
import './board.css'

export function WeaveBoard() {
  useTabRouter()
  const { task, activeTab } = useBoardState()

  return (
    <div className="weave-board">
      <ErrorBoundary><BoardToolbar task={task} /></ErrorBoundary>
      <ErrorBoundary><BoardTabs active={activeTab} task={task} /></ErrorBoundary>
      <div className="board-content">
        <div className={`pane${activeTab === 'canvas' ? ' active' : ''}`}>
          <ErrorBoundary><CanvasPane task={task} /></ErrorBoundary>
        </div>
        <div className={`pane${activeTab === 'runtime' ? ' active' : ''}`}>
          <ErrorBoundary><RuntimePane task={task} /></ErrorBoundary>
        </div>
        <div className={`pane${activeTab === 'artifacts' ? ' active' : ''}`}>
          <ErrorBoundary><ArtifactsPane task={task} /></ErrorBoundary>
        </div>
        <div className={`pane${activeTab === 'history' ? ' active' : ''}`}>
          <ErrorBoundary><HistoryPane /></ErrorBoundary>
        </div>
      </div>
    </div>
  )
}
```

### 2.4 `src/client/board/BoardToolbar.tsx`

```tsx
// src/client/board/BoardToolbar.tsx
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
```

### 2.5 `src/client/board/BoardTabs.tsx`

```tsx
// src/client/board/BoardTabs.tsx
import { setActiveTab } from '../state/board-state.js'
import type { CurrentTask } from '../state/board-state.js'
import { useActivityFeed } from '../hooks/useActivityFeed.js'

export function BoardTabs({ active, task }: { active: string; task: CurrentTask }) {
  const activity = useActivityFeed(task.graphId)

  const hasRun = task.graphId !== null && task.phase !== 'idle' && task.phase !== 'editing'

  const tabs = [
    { id: 'canvas',    label: '编排',    enabled: true },
    { id: 'runtime',   label: '运行',    enabled: hasRun, badge: activity.size },
    { id: 'artifacts', label: '产物',    enabled: hasRun },
    { id: 'history',   label: '历史',    enabled: true },
  ] as const

  return (
    <nav className="board-tabs">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`tab${active === t.id ? ' active' : ''}`}
          disabled={!t.enabled}
          onClick={() => setActiveTab(t.id as never)}
        >
          {t.label}
          {t.badge ? <span className="count">{t.badge}</span> : null}
        </button>
      ))}
    </nav>
  )
}
```

### 2.6 `src/client/board/panes/CanvasPane.tsx`

```tsx
// src/client/board/panes/CanvasPane.tsx
import { useEffect, useState } from 'react'
import { RoleLibraryPanel } from '../../dashboard/RoleLibraryPanel.js'
import { CanvasEditor } from '../../dashboard/CanvasEditor.js'
import type { CurrentTask } from '../../state/board-state.js'
import type { ClientGraphSpec } from '../../state/types.js'

export function CanvasPane({ task }: { task: CurrentTask }) {
  const readonly = task.phase !== 'idle' && task.phase !== 'editing'
  const [draft, setDraft] = useState<ClientGraphSpec | null>(null)

  // 加载当前草稿图（若 taskId 存在）
  useEffect(() => {
    if (!task.taskId) return
    fetch(`/api/weave/tasks/${task.taskId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.graph) setDraft(d.graph) })
      .catch(() => {})
  }, [task.taskId])

  // 响应"保存图"事件（由 BoardToolbar 触发）
  useEffect(() => {
    const onSave = () => {
      if (!draft || !task.taskId) return
      void fetch('/api/weave/graphs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: task.taskId, spec: draft, meta: { name: task.userInput } }),
      })
    }
    window.addEventListener('weave:save-graph', onSave)
    return () => window.removeEventListener('weave:save-graph', onSave)
  }, [draft, task.taskId, task.userInput])

  return (
    <div className="canvas-pane">
      <aside className="role-sidebar">
        <RoleLibraryPanel readonly={readonly} />
      </aside>
      <div className="canvas-area">
        <CanvasEditor
          initialGraph={draft ?? undefined}
          onGraphChange={setDraft}
          readonly={readonly}
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
```

### 2.7 `src/client/board/panes/RuntimePane.tsx`

```tsx
// src/client/board/panes/RuntimePane.tsx
import { useEffect, useState } from 'react'
import { TokenPanel } from '../../dashboard/TokenPanel.js'
import { ApprovalPanel } from '../../dashboard/ApprovalPanel.js'
import { SignalPanel } from '../../dashboard/SignalPanel.js'
import { MessageFlowPanel } from '../../dashboard/MessageFlowPanel.js'
import { ActivityStream } from '../ActivityStream.js'
import { useGraphStream } from '../../hooks/useGraphStream.js'
import type { CurrentTask } from '../../state/board-state.js'

export function RuntimePane({ task }: { task: CurrentTask }) {
  const graphId = task.graphId
  const { snap } = useGraphStream(graphId)
  const [showSecondary, setShowSecondary] = useState(false)

  // 图完成时显示横幅提示
  const [showCompleteBanner, setShowCompleteBanner] = useState(false)
  useEffect(() => {
    setShowCompleteBanner(task.phase === 'completed')
  }, [task.phase])

  if (!graphId) {
    return <div className="pane-empty">（尚未启动图，请先在【编排】完成配置并点【开始工作】）</div>
  }

  return (
    <div className="runtime-pane">
      {showCompleteBanner && (
        <div className="complete-banner">
          ✅ 图已完成
          <button className="btn primary" onClick={() => window.dispatchEvent(new CustomEvent('weave:view-artifacts'))}>
            查看产物 →
          </button>
          <button className="banner-close" onClick={() => setShowCompleteBanner(false)}>×</button>
        </div>
      )}

      <div className="runtime-cards">
        <StatusCard snap={snap} />
        <TokenPanel graphId={graphId} />
        <ApprovalPanel graphId={graphId} />
      </div>

      <details className="runtime-details" open={showSecondary} onToggle={(e) => setShowSecondary((e.target as HTMLDetailsElement).open)}>
        <summary>观察者信号 / 消息流</summary>
        <div className="detail-grid">
          <SignalPanel graphId={graphId} />
          <MessageFlowPanel graphId={graphId} />
        </div>
      </details>

      <ActivityStream graphId={graphId} />
    </div>
  )
}

function StatusCard({ snap }: { snap: ReturnType<typeof useGraphStream>['snap'] }) {
  if (!snap) return <div className="card"><div className="card-head"><span className="card-title">图状态</span></div><div className="card-body"><div className="pane-empty">（无数据）</div></div></div>
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">图状态</span>
        <span className="card-sub">{snap.graphId.slice(-12)}</span>
      </div>
      <div className="card-body">
        <div className="status-grid">
          <div className="status-cell"><span className="label">当前节点</span><span className="value brand">{snap.current || '—'}</span></div>
          <div className="status-cell"><span className="label">迭代</span><span className="value">{snap.iteration} / {snap.maxIterations}</span></div>
          <div className="status-cell"><span className="label">耗时</span><span className="value">{(snap.elapsedMs / 1000).toFixed(1)}s</span></div>
          <div className="status-cell"><span className="label">Token</span><span className="value">{snap.tokenUsed.toLocaleString()}</span></div>
        </div>
      </div>
    </div>
  )
}
```

### 2.8 `src/client/board/ActivityStream.tsx`

```tsx
// src/client/board/ActivityStream.tsx
import { useEffect, useRef, useState } from 'react'

interface Line {
  ts: number
  node: string
  icon: string
  text: string
  kind: '' | 'done' | 'warn' | 'err'
}

export function ActivityStream({ graphId }: { graphId: string | null }) {
  const [lines, setLines] = useState<Line[]>([])
  const [paused, setPaused] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    if (!graphId) { setLines([]); return }
    setLines([])

    // 先拉取历史（可选：通过 /logs 补）
    fetch(`/api/weave/graph/${graphId}/logs?limit=200`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ event: { type: string; node?: string; timestamp: number; data?: Record<string, unknown> } }>) => {
        if (!Array.isArray(rows)) return
        setLines(rows.map((r) => toLine(r.event)).filter((x): x is Line => x !== null))
      })
      .catch(() => {})

    // SSE 实时流
    const es = new EventSource(`/api/weave/graph/${graphId}/stream`)
    es.onmessage = (msg) => {
      if (paused) return
      try {
        const evt = JSON.parse(msg.data) as { event_type: string; node?: string; timestamp: number; data?: Record<string, unknown> }
        const line = toEventLine(evt)
        if (line) setLines((prev) => [...prev, line].slice(-1000))
      } catch { /* ignore */ }
    }
    return () => es.close()
  }, [graphId, paused])

  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [lines, autoScroll])

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }

  return (
    <div className="activity-stream">
      <header className="stream-head">
        <div className="stream-title">
          <span className="live-dot" />
          实时活动流
          <span className="stream-count">{lines.length}</span>
        </div>
        <div className="stream-actions">
          <button className={`btn small${paused ? ' primary' : ''}`} onClick={() => setPaused((p) => !p)}>
            {paused ? '继续' : '暂停'}
          </button>
          <button className="btn small" onClick={() => setLines([])}>清空</button>
        </div>
      </header>
      <div className="stream-body" ref={bodyRef} onScroll={handleScroll}>
        {lines.length === 0 && <div className="pane-empty">（暂无活动）</div>}
        {lines.map((l, i) => (
          <div key={i} className={`act${l.kind ? ' ' + l.kind : ''}`}>
            <span className="t">{fmtTime(l.ts)}</span>
            <span className="n">{l.icon} {l.node}</span>
            <span className="m">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── 转换 ─────────────────────────────────────────────
function toLine(e: { type: string; node?: string; timestamp: number; data?: Record<string, unknown> }): Line | null {
  const node = e.node ?? 'graph'
  const d = e.data ?? {}
  switch (e.type) {
    case 'graph/node-start': return { ts: e.timestamp, node, icon: '▶', text: `${node} 开始`, kind: '' }
    case 'graph/node-end':   return { ts: e.timestamp, node, icon: '✓', text: `${node} 完成`, kind: 'done' }
    case 'graph/node-error': return { ts: e.timestamp, node, icon: '✗', text: `${node} 出错: ${String(d.error ?? '')}`, kind: 'err' }
    case 'graph/loop-iteration': return { ts: e.timestamp, node, icon: '⚠', text: `回退 ${String(d.from ?? '')} → ${String(d.to ?? '')}`, kind: 'warn' }
    case 'graph/paused': return { ts: e.timestamp, node, icon: '⏸', text: `暂停：${String(d.reason ?? '')}`, kind: 'warn' }
    default: return null
  }
}

function toEventLine(e: { event_type: string; node?: string; timestamp: number; data?: Record<string, unknown> }): Line | null {
  const node = e.node ?? 'graph'
  const d = e.data ?? {}
  switch (e.event_type) {
    case 'node-activity': {
      const kind = String(d.kind ?? '')
      const icon = kind === 'tool-call' ? '🔧' : kind === 'tool-result' ? '✓' : kind === 'thinking' ? '💭' : '💬'
      const text = kind === 'tool-call'
        ? `调用 ${String(d.tool ?? 'tool')}(${String(d.args ?? '')})`
        : kind === 'tool-result'
          ? `${String(d.tool ?? 'tool')} 返回: ${String(d.result ?? '')}`
          : String(d.text ?? '')
      return { ts: e.timestamp, node, icon, text, kind: '' }
    }
    case 'graph-start': return { ts: e.timestamp, node, icon: '▶', text: '图已启动', kind: '' }
    case 'node-start':  return { ts: e.timestamp, node, icon: '▶', text: `${node} 开始`, kind: '' }
    case 'node-end':    return { ts: e.timestamp, node, icon: '✓', text: `${node} 完成`, kind: 'done' }
    case 'node-error':  return { ts: e.timestamp, node, icon: '✗', text: `${node} 出错: ${String(d.error ?? '')}`, kind: 'err' }
    case 'loop-iteration': return { ts: e.timestamp, node, icon: '⚠', text: `回退 ${String(d.from ?? '')} → ${String(d.to ?? '')}`, kind: 'warn' }
    case 'graph-paused': return { ts: e.timestamp, node, icon: '⏸', text: `暂停：${String(d.pauseReason ?? d.reason ?? '')}`, kind: 'warn' }
    case 'graph-end':   return { ts: e.timestamp, node, icon: '■', text: '图结束', kind: 'done' }
    default: return null
  }
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}
```

### 2.9 `src/client/board/panes/ArtifactsPane.tsx`

```tsx
// src/client/board/panes/ArtifactsPane.tsx
import { useState } from 'react'
import { HandoffViewer } from '../../dashboard/HandoffViewer.js'
import type { CurrentTask } from '../../state/board-state.js'

interface Artifact {
  nodeId: string
  name: string
  path: string
  sizeBytes: number
  kind: string
}

export function ArtifactsPane({ task }: { task: CurrentTask }) {
  const graphId = task.graphId
  const [artifacts] = useState<Artifact[]>([])  // 后续接 /artifacts API
  const [selectedNode, setSelectedNode] = useState<string | null>(null)

  if (!graphId) return <div className="pane-empty">（尚无产物，请先运行图）</div>

  return (
    <div className="artifacts-pane">
      <aside className="artifacts-list">
        <h3 className="section-title">产物清单 <span className="count">{artifacts.length}</span></h3>
        {artifacts.length === 0 ? (
          <div className="pane-empty">（暂无产物）</div>
        ) : (
          artifacts.map((a) => (
            <div
              key={a.path}
              className={`artifact-item${selectedNode === a.nodeId ? ' active' : ''}`}
              onClick={() => setSelectedNode(a.nodeId)}
            >
              <span className="kind">[{a.kind}]</span>
              <span className="name">{a.name}</span>
              <span className="size">{fmtBytes(a.sizeBytes)}</span>
            </div>
          ))
        )}
      </aside>
      <div className="handoff-view">
        <HandoffViewer graphId={graphId} />
      </div>
    </div>
  )
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
```

### 2.10 `src/client/board/panes/HistoryPane.tsx`

```tsx
// src/client/board/panes/HistoryPane.tsx
import { useEffect, useState } from 'react'
import { RestorePanel } from '../../dashboard/RestorePanel.js'
import { setCurrentTask, setActiveTab } from '../../state/board-state.js'
import type { RunHistoryEntry } from '../../state/types.js'

export function HistoryPane() {
  const [runs, setRuns] = useState<RunHistoryEntry[]>([])
  const [saved, setSaved] = useState<Array<{ id: string; updatedAt: string; name?: string }>>([])
  const [selectedGraph, setSelectedGraph] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/weave/graphs').then((r) => (r.ok ? r.json() : [])).then(setRuns).catch(() => {})
    fetch('/api/weave/graphs/saved').then((r) => (r.ok ? r.json() : [])).then(setSaved).catch(() => {})
  }, [])

  const viewRun = (graphId: string) => {
    setCurrentTask({ graphId, phase: 'completed' })  // 简化为只读历史
    setActiveTab('runtime')
  }

  return (
    <div className="history-pane">
      <section>
        <h3 className="section-title">运行历史 <span className="count">{runs.length}</span></h3>
        {runs.length === 0 && <div className="pane-empty">（暂无历史）</div>}
        {runs.map((r) => (
          <div
            key={r.graphId}
            className={`history-item${selectedGraph === r.graphId ? ' active' : ''}`}
            onClick={() => setSelectedGraph(r.graphId)}
          >
            <span className="gid">{r.graphId}</span>
            <span className={`status ${r.status}`}>{r.status}</span>
            <span className="when">{new Date(r.startedAt).toLocaleString('zh-CN')}</span>
            <button className="btn small" onClick={(e) => { e.stopPropagation(); viewRun(r.graphId) }}>查看</button>
          </div>
        ))}
      </section>

      <section>
        <h3 className="section-title">已保存图 <span className="count">{saved.length}</span></h3>
        {saved.length === 0 && <div className="pane-empty">（暂无已保存图）</div>}
        {saved.map((g) => (
          <div key={g.id} className="history-item">
            <span className="gid">{g.id}</span>
            <span className="when">{new Date(g.updatedAt).toLocaleString('zh-CN')}</span>
          </div>
        ))}
      </section>

      {selectedGraph && (
        <section>
          <h3 className="section-title">检查点恢复点</h3>
          <RestorePanel graphId={selectedGraph} />
        </section>
      )}
    </div>
  )
}
```

### 2.11 `src/client/board/BoardOverlays.tsx`

```tsx
// src/client/board/BoardOverlays.tsx
import { useEffect, useState } from 'react'
import { UserQuestionModal } from '../dashboard/UserQuestionModal.js'
import { RoleEditor } from '../dashboard/RoleEditor.js'
import { NodeEditorModal } from '../dashboard/NodeEditorModal.js'
import type { EditorNode } from '../dashboard/canvas-model.js'

interface RoleEditorState { roleId?: string }
interface NodeEditorState { nodeId: string; node: EditorNode; roles: Array<{ id: string; name: string }> }

export function BoardOverlays() {
  const [roleEditor, setRoleEditor] = useState<RoleEditorState | null>(null)
  const [nodeEditor, setNodeEditor] = useState<NodeEditorState | null>(null)

  useEffect(() => {
    const onOpenRole = (e: Event) => {
      const d = (e as CustomEvent<RoleEditorState>).detail ?? {}
      setRoleEditor(d)
    }
    const onOpenNode = (e: Event) => {
      const d = (e as CustomEvent<NodeEditorState>).detail
      if (d?.nodeId) setNodeEditor(d)
    }
    window.addEventListener('weave:open-role-editor', onOpenRole)
    window.addEventListener('weave:open-node-editor', onOpenNode)
    return () => {
      window.removeEventListener('weave:open-role-editor', onOpenRole)
      window.removeEventListener('weave:open-node-editor', onOpenNode)
    }
  }, [])

  return (
    <>
      <UserQuestionModal />
      {roleEditor && (
        <RoleEditor
          roleId={roleEditor.roleId}
          onClose={() => setRoleEditor(null)}
          onSaved={() => window.dispatchEvent(new CustomEvent('weave:roles-changed'))}
        />
      )}
      {nodeEditor && (
        <NodeEditorModal
          node={nodeEditor.node}
          roles={nodeEditor.roles}
          onClose={() => setNodeEditor(null)}
          onSave={(updated) => {
            window.dispatchEvent(new CustomEvent('weave:node-saved', { detail: { nodeId: nodeEditor.nodeId, node: updated } }))
            setNodeEditor(null)
          }}
          onDelete={() => {
            window.dispatchEvent(new CustomEvent('weave:node-deleted', { detail: { nodeId: nodeEditor.nodeId } }))
            setNodeEditor(null)
          }}
        />
      )}
    </>
  )
}
```

### 2.12 `src/client/dashboard/NodeEditorModal.tsx`（从 CanvasEditor 抽出）

```tsx
// src/client/dashboard/NodeEditorModal.tsx
import { useState } from 'react'
import type { EditorNode } from './canvas-model.js'

export function NodeEditorModal({
  node, roles, onSave, onDelete, onClose,
}: {
  node: EditorNode
  roles: Array<{ id: string; name: string }>
  onSave: (n: EditorNode) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<EditorNode>({ ...node })

  return (
    <div className="weave-modal-mask" onClick={onClose}>
      <div className="weave-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <div className="modal-kicker">节点 / Subagent 配置</div>
            <div className="modal-title">{node.roleName}</div>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </header>

        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label>节点 ID</label>
              <input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
            </div>
            <div className="field">
              <label>角色 (roleRef)</label>
              <select value={draft.roleRef} onChange={(e) => {
                const r = roles.find((x) => x.id === e.target.value)
                setDraft({ ...draft, roleRef: e.target.value, roleName: r?.name ?? e.target.value })
              }}>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.id}</option>)}
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>产物文件名</label>
              <input value={draft.artifactName ?? ''} placeholder={`${draft.id}.md`}
                onChange={(e) => setDraft({ ...draft, artifactName: e.target.value })} />
            </div>
            <div className="field">
              <label>模型覆盖</label>
              <input value={draft.modelOverride ?? ''} placeholder="默认"
                onChange={(e) => setDraft({ ...draft, modelOverride: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>输入门禁（上游节点 ID，逗号分隔）</label>
            <input value={draft.inputGate ?? ''} placeholder="node-a, node-b"
              onChange={(e) => setDraft({ ...draft, inputGate: e.target.value })} />
          </div>
          <div className="field">
            <label>输出约束</label>
            <label className="checkbox"><input type="checkbox" checked={draft.onlyMarkdown ?? false}
              onChange={(e) => setDraft({ ...draft, onlyMarkdown: e.target.checked })} /> 仅 .md</label>
            <label className="checkbox"><input type="checkbox" checked={draft.approval ?? false}
              onChange={(e) => setDraft({ ...draft, approval: e.target.checked })} /> 需用户审批</label>
          </div>
        </div>

        <footer className="modal-foot">
          <button className="btn danger" onClick={onDelete} style={{ marginRight: 'auto' }}>删除节点</button>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => onSave(draft)}>保存</button>
        </footer>
      </div>
    </div>
  )
}
```

### 2.13 `src/client/index.tsx`（入口重写）

```tsx
// src/client/index.tsx
import type { Context } from '@deepseek-ai/cordis'
import { WeaveBoard } from './board/WeaveBoard.js'
import { BoardOverlays } from './board/BoardOverlays.js'
import { setCurrentTask, setActiveTab, clearTask } from './state/board-state.js'

interface SlotsLike {
  inject(name: string, register: () => (() => void) | undefined): void
  register(opts: { name: string; id?: string; order?: number; label?: string | (() => string) }, comp: unknown): () => void
}

type ClientContext = Context & { slots?: SlotsLike }

const SLOT_D3 = 'conversation.view'
const SLOT_OVERLAY = 'shell.overlay'

export const name = 'dsh-agent-weave-client'
export const inject = ['slots']

export function apply(ctx: Context): void {
  const slots = (ctx as ClientContext).slots
  if (!slots) return

  // D3：看板主体
  slots.inject(SLOT_D3, () => slots.register(
    { name: SLOT_D3, id: 'weave-board', label: () => 'Weave 看板', order: 10 },
    WeaveBoard,
  ))

  // overlay：浮层（用户确认 / 角色编辑 / 节点编辑）
  slots.inject(SLOT_OVERLAY, () => slots.register(
    { name: SLOT_OVERLAY, id: 'weave-overlays', order: 100 },
    BoardOverlays,
  ))

  // 全局 SSE：任务提议 → 打开看板 + 切编排
  const es = new EventSource('/api/weave/stream')
  es.onmessage = (msg) => {
    try {
      const evt = JSON.parse(msg.data) as {
        event_type?: string
        trace_id?: string
        data?: { taskId?: string; graphId?: string; pauseReason?: string; error?: string }
      }

      if (evt.event_type === 'task-proposed' && evt.data?.taskId) {
        // 拉取任务详情
        fetch(`/api/weave/tasks/${evt.data.taskId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((task) => {
            if (!task) return
            setCurrentTask({
              taskId: task.taskId,
              phase: 'editing',
              userInput: task.userInput,
              template: task.template,
            })
            setActiveTab('canvas')
            // 尝试激活看板（best-effort）
            try {
              const s = slots as SlotsLike & { activate?: (slot: string, id: string, opts?: unknown) => void }
              s.activate?.('conversation.view', 'weave-board', { taskId: task.taskId })
            } catch { /* 降级：用户手动切 Tab */ }
          })
          .catch(() => {})
        return
      }

      if (evt.event_type === 'graph-start' && evt.trace_id) {
        setCurrentTask({ graphId: evt.trace_id, phase: 'running' })
        setActiveTab('runtime')
        return
      }

      if (evt.event_type === 'graph-paused') {
        const reason = evt.data?.pauseReason ?? ''
        if (reason === 'awaiting-user' || reason === 'approval-pending' || reason === 'environment-gate') {
          window.dispatchEvent(new CustomEvent('weave:user-question', {
            detail: {
              graphId: evt.trace_id,
              question: { text: evt.data?.error ?? `图已暂停（${reason}），需要你的确认` },
            },
          }))
        }
        setCurrentTask({ phase: 'awaiting' })
        return
      }

      if (evt.event_type === 'graph-end' && evt.data?.status === 'completed') {
        setCurrentTask({ phase: 'completed' })
        return
      }
    } catch { /* ignore */ }
  }
  es.onerror = () => { /* auto-reconnect */ }
  ctx.effect(() => () => es.close())

  // 响应"查看产物"事件
  const onViewArtifacts = () => setActiveTab('artifacts')
  window.addEventListener('weave:view-artifacts', onViewArtifacts)
  ctx.effect(() => () => window.removeEventListener('weave:view-artifacts', onViewArtifacts))

  // 响应"新建任务"事件（清状态）
  const onNewTask = () => clearTask()
  window.addEventListener('weave:new-task', onNewTask)
  ctx.effect(() => () => window.removeEventListener('weave:new-task', onNewTask))
}
```

### 2.14 `src/client/board/board.css`

```css
/* src/client/board/board.css */

/* ══════════════════════════════════════════════════════════
   设计令牌
   ══════════════════════════════════════════════════════════ */
.weave-board {
  --w-bg: #ffffff;
  --w-bg-soft: #fafbfc;
  --w-bg-mute: #f4f6f8;
  --w-border: #e5e7eb;
  --w-border-strong: #d1d5db;
  --w-text: #0f172a;
  --w-text-2: #475569;
  --w-text-3: #94a3b8;
  --w-brand: #4f46e5;
  --w-brand-hover: #4338ca;
  --w-brand-soft: #eef2ff;
  --w-brand-border: #c7d2fe;
  --w-success: #10b981;
  --w-success-soft: #ecfdf5;
  --w-warn: #f59e0b;
  --w-warn-soft: #fffbeb;
  --w-danger: #ef4444;
  --w-danger-soft: #fef2f2;
  --w-shadow-sm: 0 1px 3px rgba(15,23,42,.08), 0 1px 2px rgba(15,23,42,.04);
  --w-shadow-md: 0 4px 12px rgba(15,23,42,.08), 0 2px 4px rgba(15,23,42,.04);
  --w-ease: cubic-bezier(0.4, 0, 0.2, 1);

  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--w-bg);
  color: var(--w-text);
  font-size: 13.5px;
  line-height: 1.5;
}

.weave-board button { font-family: inherit; }

/* ══════════════════════════════════════════════════════════
   工具栏
   ══════════════════════════════════════════════════════════ */
.board-toolbar {
  height: 56px;
  flex: 0 0 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  border-bottom: 1px solid var(--w-border);
  background: var(--w-bg);
}
.toolbar-left { display: flex; align-items: center; gap: 12px; }
.toolbar-right { display: flex; align-items: center; gap: 8px; }

.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #cbd5e1; flex: 0 0 8px; position: relative;
}
.status-dot.running { background: var(--w-success); }
.status-dot.running::after {
  content: ''; position: absolute; inset: -3px; border-radius: 50%;
  background: var(--w-success); opacity: .3;
  animation: w-pulsering 1.6s var(--w-ease) infinite;
}
.status-dot.paused, .status-dot.awaiting { background: var(--w-warn); }
.status-dot.paused::after, .status-dot.awaiting::after {
  content: ''; position: absolute; inset: -3px; border-radius: 50%;
  background: var(--w-warn); opacity: .3;
  animation: w-pulsering 1.6s var(--w-ease) infinite;
}
.status-dot.completed { background: var(--w-success); }
.status-dot.failed { background: var(--w-danger); }
.status-dot.stopped { background: #94a3b8; }
@keyframes w-pulsering {
  0% { transform: scale(1); opacity: .4; }
  100% { transform: scale(1.6); opacity: 0; }
}

.board-title { font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
.task-chip {
  font-size: 11.5px; font-family: ui-monospace, Menlo, Consolas, monospace;
  padding: 3px 9px; border-radius: 5px;
  background: var(--w-bg-mute); border: 1px solid var(--w-border);
  color: var(--w-text-2);
}

/* 按钮 */
.btn {
  padding: 7px 14px; border: 1px solid var(--w-border-strong); border-radius: 7px;
  background: var(--w-bg); font-size: 12.5px; font-weight: 500;
  cursor: pointer; color: var(--w-text);
  transition: all .15s var(--w-ease); white-space: nowrap;
}
.btn:hover { background: var(--w-bg-mute); border-color: var(--w-text-3); }
.btn.primary {
  background: var(--w-brand); border-color: var(--w-brand); color: #fff;
  box-shadow: 0 1px 2px rgba(79,70,229,.2);
}
.btn.primary:hover { background: var(--w-brand-hover); border-color: var(--w-brand-hover); }
.btn.danger { color: #b91c1c; border-color: #fecaca; background: var(--w-danger-soft); }
.btn.danger:hover { background: #fee2e2; }
.btn.small { padding: 4px 10px; font-size: 11.5px; }
.btn:disabled { opacity: .4; cursor: not-allowed; }

/* ══════════════════════════════════════════════════════════
   Tab 栏
   ══════════════════════════════════════════════════════════ */
.board-tabs {
  height: 44px; flex: 0 0 44px;
  display: flex; gap: 2px; padding: 0 16px;
  border-bottom: 1px solid var(--w-border);
  background: var(--w-bg);
}
.tab {
  border: none; background: none; padding: 0 16px;
  font-size: 13px; font-weight: 500; color: var(--w-text-3);
  cursor: pointer; transition: all .15s var(--w-ease);
  border-bottom: 2px solid transparent;
  display: flex; align-items: center; gap: 6px;
  margin-bottom: -1px;
}
.tab:hover:not(:disabled) { color: var(--w-text-2); }
.tab.active {
  color: var(--w-brand); border-bottom-color: var(--w-brand); font-weight: 600;
}
.tab:disabled { opacity: .35; cursor: not-allowed; }
.tab .count {
  font-size: 10.5px; background: var(--w-bg-mute);
  border-radius: 10px; padding: 1px 7px; color: var(--w-text-3);
  font-weight: 500;
}
.tab.active .count { background: var(--w-brand-soft); color: var(--w-brand); }

/* ══════════════════════════════════════════════════════════
   内容区
   ══════════════════════════════════════════════════════════ */
.board-content {
  flex: 1; position: relative; overflow: hidden; min-height: 0;
}
.pane {
  position: absolute; inset: 0; display: none; overflow: hidden;
}
.pane.active { display: flex; }

.pane-empty {
  padding: 40px 20px; text-align: center;
  color: var(--w-text-3); font-size: 13px;
}

/* ══════════════════════════════════════════════════════════
   编排 Tab
   ══════════════════════════════════════════════════════════ */
.canvas-pane { flex: 1; display: flex; min-height: 0; }

.role-sidebar {
  width: 240px; flex: 0 0 240px;
  border-right: 1px solid var(--w-border);
  background: var(--w-bg-soft);
  overflow-y: auto;
  padding: 12px;
}
.role-sidebar::-webkit-scrollbar { width: 6px; }
.role-sidebar::-webkit-scrollbar-thumb { background: var(--w-border); border-radius: 3px; }

.canvas-area {
  flex: 1; position: relative; min-width: 0;
  display: flex; flex-direction: column;
  background: var(--w-bg-soft);
  background-image: radial-gradient(circle, #d1d5db 1px, transparent 1px);
  background-size: 20px 20px;
}
.canvas-area > *:first-child { flex: 1; min-height: 0; }

.readonly-banner {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  background: var(--w-warn); color: #fff;
  padding: 6px 16px; border-radius: 16px;
  font-size: 12px; font-weight: 500;
  box-shadow: 0 4px 12px rgba(245,158,11,.3);
  pointer-events: none;
}

/* ══════════════════════════════════════════════════════════
   运行 Tab
   ══════════════════════════════════════════════════════════ */
.runtime-pane {
  flex: 1; display: flex; flex-direction: column;
  padding: 16px; gap: 12px;
  overflow: hidden; min-height: 0;
}
.runtime-cards {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 12px; flex: 0 0 auto;
}
@media (max-width: 900px) { .runtime-cards { grid-template-columns: 1fr; } }

.runtime-details {
  flex: 0 0 auto;
  border: 1px solid var(--w-border); border-radius: 10px;
  background: var(--w-bg-soft);
}
.runtime-details > summary {
  padding: 10px 14px; cursor: pointer; user-select: none;
  font-size: 12px; font-weight: 600; color: var(--w-text-2);
}
.runtime-details[open] > summary { border-bottom: 1px solid var(--w-border); }
.detail-grid {
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 12px; padding: 12px;
}

.complete-banner {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px; border-radius: 10px;
  background: var(--w-success-soft);
  border: 1px solid #a7f3d0;
  color: #065f46; font-size: 13px; font-weight: 500;
  animation: w-slidedown .3s var(--w-ease);
}
@keyframes w-slidedown {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: none; }
}
.complete-banner .btn { margin-left: auto; }
.banner-close {
  border: none; background: none; cursor: pointer;
  color: #065f46; font-size: 16px; padding: 2px 8px;
}

/* 通用卡片 */
.card {
  background: var(--w-bg); border: 1px solid var(--w-border);
  border-radius: 10px; overflow: hidden; box-shadow: 0 1px 2px rgba(15,23,42,.04);
}
.card-head {
  padding: 10px 14px; border-bottom: 1px solid var(--w-border);
  background: var(--w-bg-soft);
  display: flex; align-items: center; justify-content: space-between;
}
.card-title { font-size: 12.5px; font-weight: 600; color: var(--w-text); }
.card-sub {
  font-size: 11px; color: var(--w-text-3);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.card-body { padding: 12px 14px; }

.status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.status-cell { display: flex; flex-direction: column; gap: 3px; }
.status-cell .label {
  font-size: 10.5px; color: var(--w-text-3);
  text-transform: uppercase; letter-spacing: .05em; font-weight: 500;
}
.status-cell .value {
  font-size: 15px; font-weight: 600;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  letter-spacing: -.02em;
}
.status-cell .value.brand { color: var(--w-brand); }

/* ══════════════════════════════════════════════════════════
   活动流
   ══════════════════════════════════════════════════════════ */
.activity-stream {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  background: var(--w-bg); border: 1px solid var(--w-border);
  border-radius: 10px; overflow: hidden;
}
.stream-head {
  flex: 0 0 auto; padding: 10px 14px;
  border-bottom: 1px solid var(--w-border);
  background: var(--w-bg-soft);
  display: flex; align-items: center; justify-content: space-between;
}
.stream-title {
  display: flex; align-items: center; gap: 8px;
  font-size: 12.5px; font-weight: 600; color: var(--w-text);
}
.live-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--w-success);
  animation: w-pulsering 1.6s var(--w-ease) infinite;
}
.stream-count {
  font-size: 10.5px; background: var(--w-bg-mute);
  border-radius: 10px; padding: 1px 7px; color: var(--w-text-3);
  font-weight: 500;
}
.stream-actions { display: flex; gap: 6px; }

.stream-body {
  flex: 1; overflow-y: auto; min-height: 0;
  padding: 6px 14px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.stream-body::-webkit-scrollbar { width: 6px; }
.stream-body::-webkit-scrollbar-thumb { background: var(--w-border); border-radius: 3px; }

.act {
  display: flex; gap: 10px; padding: 5px 0; line-height: 1.55;
  border-bottom: 1px solid transparent;
}
.act:hover { background: var(--w-bg-soft); margin: 0 -14px; padding: 5px 14px; }
.act .t { color: var(--w-text-3); flex: 0 0 62px; font-size: 11px; }
.act .n {
  color: var(--w-brand); flex: 0 0 108px; font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.act .m { flex: 1; color: var(--w-text-2); word-break: break-word; font-size: 12px; }
.act.done .m { color: #047857; }
.act.warn .m { color: #b45309; }
.act.err .m { color: #b91c1c; }

/* ══════════════════════════════════════════════════════════
   产物 Tab
   ══════════════════════════════════════════════════════════ */
.artifacts-pane { flex: 1; display: flex; min-height: 0; }

.artifacts-list {
  width: 320px; flex: 0 0 320px;
  border-right: 1px solid var(--w-border);
  background: var(--w-bg-soft);
  padding: 16px 14px;
  overflow-y: auto;
}
.handoff-view {
  flex: 1; padding: 16px 20px; overflow-y: auto;
  background: var(--w-bg);
}
.handoff-view::-webkit-scrollbar { width: 8px; }
.handoff-view::-webkit-scrollbar-thumb { background: var(--w-border); border-radius: 4px; }

.section-title {
  font-size: 11px; font-weight: 600; color: var(--w-text-3);
  text-transform: uppercase; letter-spacing: .06em;
  margin: 0 0 10px 0;
  display: flex; align-items: center; justify-content: space-between;
}
.section-title .count {
  font-size: 10.5px; background: var(--w-bg-mute);
  border-radius: 10px; padding: 1px 7px; font-weight: 500;
}

.artifact-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 7px;
  background: var(--w-bg); border: 1px solid var(--w-border);
  margin-bottom: 5px; cursor: pointer;
  transition: all .15s var(--w-ease);
  font-size: 12px;
}
.artifact-item:hover { border-color: var(--w-border-strong); }
.artifact-item.active { border-color: var(--w-brand); background: var(--w-brand-soft); }
.artifact-item .kind { color: var(--w-text-3); font-size: 10.5px; }
.artifact-item .name {
  flex: 1; font-family: ui-monospace, Menlo, Consolas, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.artifact-item .size { color: var(--w-text-3); font-size: 11px; }

/* ══════════════════════════════════════════════════════════
   历史 Tab
   ══════════════════════════════════════════════════════════ */
.history-pane {
  flex: 1; padding: 20px 24px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 24px;
}
.history-pane section { display: flex; flex-direction: column; gap: 8px; }

.history-item {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border: 1px solid var(--w-border);
  border-radius: 9px; background: var(--w-bg);
  cursor: pointer; transition: all .15s var(--w-ease);
}
.history-item:hover {
  border-color: var(--w-brand-border);
  box-shadow: 0 1px 3px rgba(79,70,229,.08);
}
.history-item.active { border-color: var(--w-brand); background: var(--w-brand-soft); }
.history-item .gid {
  flex: 1; font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12.5px; font-weight: 500;
}
.history-item .when { font-size: 11.5px; color: var(--w-text-3); }
.history-item .status {
  font-size: 10.5px; font-weight: 600;
  padding: 3px 9px; border-radius: 5px;
}
.history-item .status.completed { background: var(--w-success-soft); color: #047857; }
.history-item .status.failed { background: var(--w-danger-soft); color: #b91c1c; }
.history-item .status.running { background: var(--w-brand-soft); color: var(--w-brand); }
.history-item .status.paused { background: var(--w-warn-soft); color: #b45309; }

/* ══════════════════════════════════════════════════════════
   浮层（UserQuestionModal / RoleEditor / NodeEditorModal）
   ══════════════════════════════════════════════════════════ */
.weave-modal-mask {
  position: fixed; inset: 0; z-index: 2000;
  background: rgba(15,23,42,.44); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  animation: w-fadein .18s var(--w-ease);
  padding: 24px;
}
@keyframes w-fadein { from { opacity: 0; } to { opacity: 1; } }

.weave-modal {
  background: var(--w-bg); border-radius: 16px;
  width: 540px; max-width: 100%; max-height: calc(100vh - 48px);
  box-shadow: 0 24px 56px rgba(15,23,42,.18);
  overflow: hidden; display: flex; flex-direction: column;
  animation: w-modalin .25s var(--w-ease);
}
@keyframes w-modalin {
  from { opacity: 0; transform: translateY(16px) scale(.97); }
  to { opacity: 1; transform: none; }
}
.weave-modal .modal-head {
  padding: 18px 22px 14px; border-bottom: 1px solid var(--w-border);
  display: flex; justify-content: space-between; align-items: flex-start;
}
.weave-modal .modal-kicker {
  font-size: 11px; color: var(--w-text-3); margin-bottom: 4px;
  text-transform: uppercase; letter-spacing: .05em; font-weight: 500;
}
.weave-modal .modal-title {
  font-size: 15.5px; font-weight: 600; letter-spacing: -.01em;
}
.weave-modal .modal-close {
  border: none; background: none; font-size: 20px;
  color: var(--w-text-3); cursor: pointer;
  width: 28px; height: 28px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
}
.weave-modal .modal-close:hover { background: var(--w-bg-mute); }
.weave-modal .modal-body {
  padding: 18px 22px; overflow-y: auto; flex: 1;
}
.weave-modal .modal-foot {
  padding: 14px 22px; border-top: 1px solid var(--w-border);
  background: var(--w-bg-soft);
  display: flex; gap: 8px; justify-content: flex-end;
}

/* 表单（浮层内） */
.weave-modal .field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
.weave-modal .field label {
  font-size: 11.5px; font-weight: 600; color: var(--w-text-2);
  display: flex; align-items: center; gap: 6px;
}
.weave-modal .field input,
.weave-modal .field select,
.weave-modal .field textarea {
  padding: 8px 11px; border: 1px solid var(--w-border);
  border-radius: 8px; font-size: 13px; outline: none;
  background: var(--w-bg); width: 100%;
  transition: all .15s var(--w-ease);
  font-family: inherit;
}
.weave-modal .field input:focus,
.weave-modal .field select:focus,
.weave-modal .field textarea:focus {
  border-color: var(--w-brand);
  box-shadow: 0 0 0 3px var(--w-brand-soft);
}
.weave-modal .field-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
}
.weave-modal .checkbox {
  display: flex; align-items: center; gap: 7px;
  padding: 6px 0; font-size: 12.5px; cursor: pointer;
}
.weave-modal .checkbox input { accent-color: var(--w-brand); }
```

### 2.15 `CanvasEditor.tsx` 改造（加 readonly prop）

**只需改 3 处**（其余保留）：

```tsx
// 顶部 Props 接口加 readonly
interface Props {
  initialGraph?: ClientGraphSpec | null
  onGraphChange?: (spec: ClientGraphSpec) => void
  readonly?: boolean   // ★ 新增
}

export function CanvasEditor({ initialGraph, onGraphChange, readonly = false }: Props) {
  // ...
  
  // onDrop 里加守卫
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    if (readonly) return       // ★ 只读时禁止拖入
    // ... 原逻辑
  }
  
  // 节点上的 draggable 和 del 按钮加守卫
  <div
    draggable={!readonly}      // ★
    // ...
  >
    {/* ... */}
    {!readonly && (
      <button /* 删除按钮 */ />
    )}
  </div>
  
  // 双击不进编辑器
  onDoubleClick={() => {
    if (readonly) return       // ★
    setEditingId(n.id)
  }}
```

---

## 三、实施步骤

### 阶段 1：骨架（1d）

1. 新建 `board-state.ts` / `useTabRouter.ts` / `WeaveBoard.tsx` / `BoardToolbar.tsx` / `BoardTabs.tsx`
2. 新建 4 个空 pane
3. 重写 `index.tsx`
4. 临时保留旧组件编译（不影响构建）

### 阶段 2：Pane 内容（2d）

1. `CanvasPane` — 复用 CanvasEditor + RoleLibraryPanel（加 readonly）
2. `RuntimePane` — 复用 Token/Approval/Signal/MessageFlow + 新建 ActivityStream
3. `ArtifactsPane` — 复用 HandoffViewer
4. `HistoryPane` — 复用 RunHistoryPanel/RestorePanel

### 阶段 3：浮层（0.5d）

1. 新建 `BoardOverlays.tsx`
2. 新建 `NodeEditorModal.tsx`（从 CanvasEditor 抽出）
3. 挂到 `shell.overlay`

### 阶段 4：清理（0.5d）

删除以下 6 个文件：
- `WeaveDashboardView.tsx`
- `WeaveEditPanel.tsx`
- `ControlBar.tsx`
- `WeaveDashboardButton.tsx`
- `WeaveTaskPanel.tsx`
- `NodeActivityPanel.tsx`
- `GraphCanvas.tsx`（只读画布不再需要）
- `dashboard-state.ts`

### 阶段 5：验证（1d）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 一句 `weave_propose_task` | 看板自动打开 → 编排 Tab |
| 2 | 编排 Tab | 只有角色库 + 画布，**无运行时信息** |
| 3 | 点【开始工作】 | **自动切到运行 Tab** |
| 4 | 运行中切回编排 | 画布只读 + 顶部黄色横幅 |
| 5 | 图完成 | 运行 Tab 顶部绿色横幅「查看产物→」 |
| 6 | 点"查看产物" | 切到产物 Tab |
| 7 | 双击节点 | 浮层编辑器（不依赖 Tab） |
| 8 | 角色库 + 新建 | 浮层编辑器 |
| 9 | 暂停图 | 弹窗浮层，**不切 Tab** |

---

## 四、关键设计说明

### 4.1 为什么删掉 GraphCanvas

MVP-4 的 `GraphCanvas` 是**只读图渲染**，用于运行 Tab 显示图结构。但重构后：

- **编排 Tab** 已有可交互的 `CanvasEditor`（同样的分层布局 + 节点染色）
- **运行 Tab** 主要靠 `ActivityStream` 实时流，不需要额外画布
- 用户想看运行中的图 → 切到编排 Tab（只读模式，`CanvasEditor` 支持染色）

**所以 `GraphCanvas` 冗余**。

### 4.2 为什么删掉 WeaveTaskPanel

`WeaveTaskPanel` 是"任务列表 + 开始/取消按钮"，属于 MVP-5 的历史遗留：

- 重构后，**当前任务**状态由 `board-state` 管理
- **历史任务**由 `HistoryPane` 展示（运行历史）
- **新建任务**由 `BoardToolbar` 按钮触发

### 4.3 全局事件总线

不同 Tab/Pane 之间通过 `window CustomEvent` 解耦：

| 事件 | 派发者 | 监听者 |
|---|---|---|
| `weave:save-graph` | BoardToolbar | CanvasPane |
| `weave:open-role-editor` | RoleLibraryPanel | BoardOverlays |
| `weave:open-node-editor` | CanvasEditor | BoardOverlays |
| `weave:node-saved` | BoardOverlays | CanvasEditor |
| `weave:view-artifacts` | RuntimePane | index.tsx（切 Tab） |
| `weave:new-task` | BoardToolbar | index.tsx（清状态） |
| `weave:roles-changed` | BoardOverlays | RoleLibraryPanel |

### 4.4 状态与视图分离

`board-state.ts` 是**唯一真相源**：
- `task: CurrentTask` — 当前任务（taskId/graphId/phase/userInput）
- `activeTab` — 当前 Tab
- `selectedNodeId` — 画布选中节点

所有组件通过 `useBoardState()` / `useCurrentTask()` 读取，不直接维护重复状态。

---

## 五、与其他方案的差异

| 维度 | MVP-5B 现状 | 重构后 |
|---|---|---|
| 面板形态 | 右侧抽屉 720px | 无抽屉，4 Tab |
| 编排可见监控 | ✅ 干扰 | ❌ 纯净 |
| 运行时可见编辑 | ✅ 未锁 | 🔒 只读 |
| 自动导航 | ❌ 手动切 | ✅ 状态驱动 |
| 运行时指标位置 | 编排 Tab 顶栏（越界） | 运行 Tab 卡片 |
| 入口 | 点看板 → 点任务 | 一句话 → 自动开 |
| 组件数 | 24 | 18（删 8 建 7） |

---

## 六、一句话

**推倒重来**：删除 `WeaveDashboardView`（9 面板 grid）+ `WeaveEditPanel`（抽屉）+ 4 个遗留组件，新建 `WeaveBoard`（4 Tab 全屏）+ `board-state`（状态驱动）+ `BoardOverlays`（浮层解耦）。

**核心变化**：编排纯净（无监控），运行只读（无编辑），状态驱动（零手动），交接单归位（产物 Tab 主区）。

**代码即方案**——所有核心文件都是完整可运行的，直接替换即可。