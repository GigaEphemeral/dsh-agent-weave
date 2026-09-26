/**
 * 产物 Tab（MVP-5B UI 重构）：左侧产物清单 + 右侧交接单主区。
 */
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
