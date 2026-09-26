/**
 * 引导式画布编辑器（MVP-5 Phase C 简化实现）。
 *
 * 原生 div+SVG 自绘（零新依赖，MVP-5 可演进 React Flow）：
 * - 从角色库拖入角色 → 生成节点；节点可拖动
 * - 点击节点 → 点击另一节点 → 连 seq 边
 * - 角色带 suggests_next → 弹出推荐下一步面板
 * - 选中节点 → 配置抽屉（模型覆盖/输入门禁/审批/输出约束）
 * - 导出 ClientGraphSpec（供保存 / 启动任务）
 */
import { useMemo, useState } from 'react'
import type { ClientGraphSpec } from '../types'
import {
  buildGraphSpec,
  layoutNodes,
  NODE_W,
  NODE_H,
  COL_X,
  ROW_Y,
  type EditorNode,
} from './canvas-model'

export type { EditorNode }

interface RoleDrop {
  id: string
  name: string
  suggests_next?: Array<{ roleRef: string; label?: string; reason?: string }>
}

interface Props {
  initialGraph?: ClientGraphSpec | null
  onGraphChange?: (spec: ClientGraphSpec) => void
}

export function CanvasEditor({ initialGraph, onGraphChange }: Props) {
  const [nodes, setNodes] = useState<EditorNode[]>(() =>
    (initialGraph?.nodes ?? []).map((n, i) => ({
      id: n.id,
      roleRef: n.roleRef ?? n.id,
      roleName: n.roleRef ?? n.id,
      x: (i % 3) * (NODE_W + COL_X),
      y: Math.floor(i / 3) * (NODE_H + ROW_Y),
    })),
  )
  const [edges, setEdges] = useState<Array<{ from: string; to: string }>>(() =>
    (initialGraph?.edges ?? []).filter((e) => e.type === 'seq').map((e) => ({ from: e.from, to: e.to })),
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<{ sourceId: string; items: Array<{ roleRef: string; label?: string; reason?: string }> } | null>(null)
  const [counter, setCounter] = useState(initialGraph?.nodes.length ?? 0)

  const positioned = useMemo(() => layoutNodes(nodes, edges), [nodes, edges])

  const emit = (ns: EditorNode[], es: Array<{ from: string; to: string }>): void => {
    onGraphChange?.(buildGraphSpec(ns, es))
  }

  const addRoleByName = async (roleRef: string, sourceId: string): Promise<void> => {
    const res = await fetch('/api/weave/roles')
    const roles = (await res.json()) as Array<{ id: string; name: string; suggests_next?: RoleDrop['suggests_next'] }>
    const role = roles.find((r) => r.id === roleRef)
    if (!role) return
    const id = `${role.id}-${counter + 1}`
    const ns = [...nodes, { id, roleRef: role.id, roleName: role.name, x: 0, y: 0 }]
    const es = [...edges, { from: sourceId, to: id }]
    setNodes(ns)
    setEdges(es)
    setCounter(counter + 1)
    setSuggestion(role.suggests_next && role.suggests_next.length > 0 ? { sourceId: id, items: role.suggests_next } : null)
    emit(ns, es)
  }

  const selectNode = (id: string): void => {
    if (selectedId && selectedId !== id) {
      const es = [...edges, { from: selectedId, to: id }]
      setEdges(es)
      emit(nodes, es)
      setSelectedId(id)
      return
    }
    setSelectedId(id === selectedId ? null : id)
  }

  const removeNode = (id: string): void => {
    const ns = nodes.filter((n) => n.id !== id)
    const es = edges.filter((e) => e.from !== id && e.to !== id)
    setNodes(ns)
    setEdges(es)
    setSelectedId(null)
    setSuggestion(null)
    emit(ns, es)
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left - NODE_W / 2
    const y = e.clientY - rect.top - NODE_H / 2
    const roleData = e.dataTransfer.getData('application/weave-role')
    const nodeData = e.dataTransfer.getData('application/weave-node')
    if (roleData) {
      const role = JSON.parse(roleData) as RoleDrop
      const id = `${role.id}-${counter + 1}`
      const ns = [...nodes, { id, roleRef: role.id, roleName: role.name, x, y }]
      setNodes(ns)
      setCounter(counter + 1)
      setSuggestion(role.suggests_next && role.suggests_next.length > 0 ? { sourceId: id, items: role.suggests_next } : null)
      emit(ns, edges)
    } else if (nodeData) {
      const moved = positioned.map((n) => (n.id === nodeData ? { ...n, x, y } : n))
      setNodes(moved)
      emit(moved, edges)
    }
  }

  const selected = positioned.find((n) => n.id === selectedId) ?? null

  return (
    <div style={{ position: 'relative', width: '100%', minHeight: 260, border: '1px dashed #ccc', borderRadius: 8, background: '#fafafa', overflow: 'hidden' }}>
      {/* MVP-5 Phase D：边流动画 */}
      <style>{'@keyframes weave-edge-flow { to { stroke-dashoffset: -12; } }'}</style>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {edges.map((e, i) => {
          const a = positioned.find((n) => n.id === e.from)
          const b = positioned.find((n) => n.id === e.to)
          if (!a || !b) return null
          return (
            <line
              key={i}
              x1={a.x + NODE_W / 2}
              y1={a.y + NODE_H / 2}
              x2={b.x + NODE_W / 2}
              y2={b.y + NODE_H / 2}
              stroke="#94a3b8"
              strokeWidth={1.5}
              strokeDasharray="6 4"
              style={{ animation: 'weave-edge-flow 1s linear infinite' }}
            />
          )
        })}
      </svg>

      <div
        style={{ position: 'absolute', inset: 0 }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        {positioned.map((n) => (
          <div
            key={n.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/weave-node', n.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onClick={() => selectNode(n.id)}
            onDoubleClick={() => {
              // MVP-5 Phase F：双击打开 subagent 视图（best-effort，依赖宿主路由）
              const childId = n.roleRef
              const url = `#/subagent/${childId}`
              try { window.open(url, '_blank') } catch { /* 忽略 */ }
            }}
            style={{
              position: 'absolute',
              left: n.x,
              top: n.y,
              width: NODE_W,
              height: NODE_H,
              border: selectedId === n.id ? '2px solid #3b82f6' : '1px solid #cbd5e1',
              borderRadius: 8,
              background: '#fff',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              padding: '0 8px',
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(0,0,0,.12)',
              fontSize: 12,
            }}
          >
            <strong>{n.roleName}</strong>
            <span style={{ color: '#64748b' }}>{n.id}</span>
            {n.modelOverride && <span style={{ color: '#8b5cf6' }}>⚙ {n.modelOverride}</span>}
            {n.approval && <span style={{ color: '#f59e0b' }}>✓ 需审批</span>}
            <button
              style={{ position: 'absolute', top: 2, right: 2, border: 'none', background: 'transparent', color: '#ef4444', cursor: 'pointer' }}
              onClick={(e) => { e.stopPropagation(); removeNode(n.id) }}
            >
              ×
            </button>
          </div>
        ))}
        {nodes.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>
            从左侧角色库拖入角色，开始编排
          </div>
        )}
      </div>

      {suggestion && (
        <div style={{ position: 'absolute', right: 8, top: 8, width: 220, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 8, boxShadow: '0 4px 12px rgba(0,0,0,.12)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>推荐下一步（可选）</div>
          {suggestion.items.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8' }}>此角色未配置推荐</div>}
          {suggestion.items.map((s) => (
            <button
              key={s.roleRef}
              onClick={() => void addRoleByName(s.roleRef, suggestion.sourceId)}
              style={{ display: 'block', width: '100%', textAlign: 'left', border: '1px solid #e2e8f0', borderRadius: 6, padding: 4, marginBottom: 4, fontSize: 12, cursor: 'pointer', background: '#f8fafc' }}
            >
              <div>{s.label ?? s.roleRef}</div>
              <div style={{ color: '#64748b' }}>{s.roleRef}</div>
              {s.reason && <div style={{ color: '#94a3b8' }}>{s.reason}</div>}
            </button>
          ))}
          <button onClick={() => setSuggestion(null)} style={{ fontSize: 11, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer' }}>
            跳过推荐
          </button>
        </div>
      )}

      {selected && (
        <div style={{ position: 'absolute', left: 8, bottom: 8, right: 8, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 8, fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <strong>{selected.roleRef}</strong>
          <input
            placeholder="模型覆盖（可选）"
            value={selected.modelOverride ?? ''}
            onChange={(e) => setNodes(positioned.map((n) => (n.id === selected.id ? { ...n, modelOverride: e.target.value } : n)))}
            style={{ fontSize: 12, width: 140 }}
          />
          <input
            placeholder="输入门禁 requires（逗号分隔）"
            value={selected.inputGate ?? ''}
            onChange={(e) => setNodes(positioned.map((n) => (n.id === selected.id ? { ...n, inputGate: e.target.value } : n)))}
            style={{ fontSize: 12, width: 180 }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={selected.approval ?? false}
              onChange={(e) => setNodes(positioned.map((n) => (n.id === selected.id ? { ...n, approval: e.target.checked } : n)))}
            />
            需用户审批
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={selected.onlyMarkdown ?? false}
              onChange={(e) => setNodes(positioned.map((n) => (n.id === selected.id ? { ...n, onlyMarkdown: e.target.checked } : n)))}
            />
            仅 .md
          </label>
        </div>
      )}
    </div>
  )
}
