/**
 * MVP-5B B6：交接单查看器（planB §6.5）。
 *
 * GET /api/weave/graph/:graphId/handoff → { latest, byNode }
 * 展示：产物 / 已确认事实 / 未满足 / 未解决问题；可切换按节点查看原始交接单。
 */
import { useEffect, useState } from 'react'

interface ArtifactRef {
  path: string
  kind: string
  summary: string
  contract?: string
  hash: string
  sizeBytes: number
}

interface VerifiedFact {
  key: string
  value: string
  cmd: string
  source: string
}

interface UnmetReq {
  key: string
  required: string
  suggestion: string
  blocking: string[]
}

interface OpenIssue {
  id: string
  severity: string
  summary: string
  evidence: string
  suggestedOwner: string
  blocking: string[]
}

interface HandoffEnvelope {
  schemaVersion: string
  graphId: string
  nodeId: string
  roleRef: string
  at: number
  artifacts: ArtifactRef[]
  facts: Array<{ key: string; category: string; value: string; confidence: string; summary: string; source: string }>
  environment: { verified: VerifiedFact[]; unmet: UnmetReq[] }
  openIssues: OpenIssue[]
  handoff: { upstream: string[]; downstream: string[]; completed: boolean }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString()
}

export function HandoffViewer({ graphId }: { graphId: string | null }) {
  const [data, setData] = useState<{ latest: HandoffEnvelope | null; byNode: Record<string, HandoffEnvelope> } | null>(null)
  const [selectedNode, setSelectedNode] = useState<string>('')

  useEffect(() => {
    setData(null)
    setSelectedNode('')
    if (!graphId) return
    fetch(`/api/weave/graph/${encodeURIComponent(graphId)}/handoff`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d as { latest: HandoffEnvelope | null; byNode: Record<string, HandoffEnvelope> }))
      .catch(() => setData({ latest: null, byNode: {} }))
  }, [graphId])

  if (!graphId) return <div style={{ color: '#94a3b8', fontSize: 12 }}>（选择图后查看交接单）</div>
  if (!data) return <div style={{ color: '#94a3b8', fontSize: 12 }}>（加载交接单…）</div>

  const env = selectedNode ? data.byNode[selectedNode] : data.latest
  if (!env) return <div style={{ color: '#94a3b8', fontSize: 12 }}>（暂无交接数据）</div>

  return (
    <div className="handoff-viewer" style={{ fontSize: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <strong>交接单</strong>
        <select value={selectedNode} onChange={(e) => setSelectedNode(e.target.value)} style={{ fontSize: 12 }}>
          <option value="">（合并全局）</option>
          {Object.keys(data.byNode).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      <div style={{ color: '#94a3b8', marginBottom: 4 }}>
        {env.roleRef} · {fmtTime(env.at)}
        {env.handoff.upstream.length > 0 && <span> · 上游: {env.handoff.upstream.join(', ')}</span>}
      </div>

      <section style={{ marginBottom: 6 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>产物（{env.artifacts.length}）</div>
        {env.artifacts.length === 0 && <div style={{ color: '#94a3b8' }}>（无）</div>}
        {env.artifacts.map((a) => (
          <div key={a.path} style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '2px 6px', marginBottom: 2 }}>
            <span style={{ color: '#64748b' }}>[{a.kind}]</span> <code>{a.path}</code>
            <span style={{ color: '#94a3b8' }}> · {formatBytes(a.sizeBytes)} · {a.hash.slice(0, 8)}</span>
            {a.summary && <div style={{ color: '#475569' }}>{a.summary}</div>}
            {a.contract && <pre style={{ margin: '2px 0', background: '#f8fafc', borderRadius: 4, padding: 4, fontSize: 11, whiteSpace: 'pre-wrap' }}>{a.contract}</pre>}
          </div>
        ))}
      </section>

      <section style={{ marginBottom: 6 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>已确认事实（{env.environment.verified.length}）</div>
        {env.environment.verified.length === 0 && <div style={{ color: '#94a3b8' }}>（无）</div>}
        {env.environment.verified.map((v) => (
          <div key={v.key} style={{ marginBottom: 2 }}>
            <code>{v.key}</code> = <strong>{v.value}</strong>
            <span style={{ color: '#94a3b8' }}>（来自 {v.source}{v.cmd ? ` · ${v.cmd}` : ''}）</span>
          </div>
        ))}
      </section>

      {env.environment.unmet.length > 0 && (
        <section style={{ marginBottom: 6, border: '1px solid #fde68a', borderRadius: 6, padding: 6, background: '#fffbeb' }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>未满足（{env.environment.unmet.length}）⚠</div>
          {env.environment.unmet.map((u) => (
            <div key={u.key} style={{ marginBottom: 2 }}>
              <code>{u.key}</code> 需 <strong>{u.required}</strong>
              {u.suggestion && <div style={{ color: '#92400e' }}>建议：{u.suggestion}</div>}
              {u.blocking.length > 0 && <div style={{ color: '#b45309' }}>阻塞：{u.blocking.join(', ')}</div>}
            </div>
          ))}
        </section>
      )}

      {env.openIssues.length > 0 && (
        <section>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>未解决问题（{env.openIssues.length}）</div>
          {env.openIssues.map((i) => (
            <div key={i.id} style={{ marginBottom: 2, borderLeft: `3px solid ${i.severity === 'blocker' ? '#ef4444' : i.severity === 'warning' ? '#f59e0b' : '#94a3b8'}`, paddingLeft: 6 }}>
              <span style={{ color: '#64748b' }}>{i.id}</span> <strong>{i.summary}</strong>
              <span style={{ color: '#94a3b8' }}> → {i.suggestedOwner}</span>
              {i.evidence && <pre style={{ margin: 2, background: '#f8fafc', borderRadius: 4, padding: 4, fontSize: 11, whiteSpace: 'pre-wrap' }}>{i.evidence}</pre>}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
