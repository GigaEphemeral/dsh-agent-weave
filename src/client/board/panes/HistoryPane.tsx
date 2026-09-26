/**
 * 历史 Tab（MVP-5B UI 重构）：运行历史 + 已保存图 + 检查点恢复点。
 */
import { useEffect, useState } from 'react'
import { RestorePanel } from '../../dashboard/RestorePanel.js'
import { listGraphDrafts, removeGraphDraft, type PersistedGraph } from '../../dashboard/Persistence.js'
import { setCurrentTask, setActiveTab } from '../../state/board-state.js'
import type { RunHistoryEntry } from '../../types.js'

export function HistoryPane() {
  const [runs, setRuns] = useState<RunHistoryEntry[]>([])
  const [saved, setSaved] = useState<Array<{ id: string; updatedAt: string; name?: string }>>([])
  const [drafts, setDrafts] = useState<PersistedGraph[]>([])
  const [selectedGraph, setSelectedGraph] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    fetch('/api/weave/graphs').then((r) => (r.ok ? r.json() : [])).then(setRuns).catch(() => {})
    fetch('/api/weave/graphs/saved').then((r) => (r.ok ? r.json() : [])).then(setSaved).catch(() => {})
  }, [])

  // P5：本地图草稿（刷新后恢复入口）
  useEffect(() => {
    setDrafts(listGraphDrafts())
  }, [tick])

  const viewRun = (graphId: string) => {
    setCurrentTask({ graphId, phase: 'completed' })  // 简化为只读历史
    setActiveTab('runtime')
  }

  // P5：从本地草稿恢复编辑
  const resumeDraft = (d: PersistedGraph) => {
    setCurrentTask({ taskId: d.id, phase: 'editing', userInput: d.name ?? '' })
    setActiveTab('canvas')
  }

  return (
    <div className="history-pane">
      <section>
        <h3 className="section-title">本地图草稿 <span className="count">{drafts.length}</span></h3>
        {drafts.length === 0 && <div className="pane-empty">（暂无本地草稿）</div>}
        {drafts.map((d) => (
          <div key={d.id} className="history-item">
            <span className="gid">{d.id}</span>
            {d.name && <span className="when">{d.name}</span>}
            <span className="when">{new Date(d.savedAt).toLocaleString('zh-CN')}</span>
            <button className="btn small" onClick={() => resumeDraft(d)}>继续编辑</button>
            <button className="btn small" onClick={() => { removeGraphDraft(d.id); setTick((t) => t + 1) }}>删除</button>
          </div>
        ))}
      </section>

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
