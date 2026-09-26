/**
 * 引导式画布编辑器（MVP-5 Phase C 简化实现；MVP-5B UI 重构改造）。
 *
 * 原生 div+SVG 自绘（零新依赖，MVP-5 可演进 React Flow）：
 * - 从角色库拖入角色 → 生成节点；节点可拖动
 * - 点击节点 → 点击另一节点 → 连 seq 边
 * - 角色带 suggests_next → 弹出推荐下一步面板
 * - 双击节点 / ⚙ 配置 → 派发 weave:open-node-editor（BoardOverlays 渲染 NodeEditorModal）
 * - 监听 weave:node-saved / weave:node-deleted 回写节点
 * - readonly：运行中锁定编辑（禁拖入/拖动/删除/双击）
 * - 导出 ClientGraphSpec（供保存 / 启动任务）
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClientGraphSpec } from '../types'
import {
  buildGraphSpec,
  layoutNodes,
  NODE_W,
  NODE_H,
  COL_X,
  ROW_Y,
  resolveLinkTarget,
  snapToGrid,
  type EditorEdge,
  type EditorNode,
} from './canvas-model'

export type { EditorNode }

interface RoleDrop {
  id: string
  name: string
  suggests_next?: Array<{ roleRef: string; label?: string; reason?: string }>
  produces?: Array<{ kind: string; name: string; contract?: string }>
  capabilities?: string[]
  tools?: string[]
}

interface Props {
  initialGraph?: ClientGraphSpec | null
  onGraphChange?: (spec: ClientGraphSpec) => void
  /** MVP-5B UI 重构：运行中只读（禁编辑）。 */
  readonly?: boolean
  /** P4：运行时节点状态（nodeStates：running/completed/failed...）。 */
  liveState?: Record<string, string>
  /** P4：节点活动（头顶气泡）。 */
  liveActivity?: Map<string, { text: string; icon?: string | undefined; at: number }>
}

const NODE_STATUS_COLOR: Record<string, string> = {
  running: '#eff6ff',
  completed: '#ecfdf5',
  failed: '#fef2f2',
  waiting: '#fffbeb',
}

export function CanvasEditor({ initialGraph, onGraphChange, readonly = false, liveState, liveActivity }: Props) {
  const [nodes, setNodes] = useState<EditorNode[]>(() =>
    (initialGraph?.nodes ?? []).map((n, i) => ({
      id: n.id,
      roleRef: n.roleRef ?? n.id,
      roleName: n.roleRef ?? n.id,
      x: (i % 3) * (NODE_W + COL_X),
      y: Math.floor(i / 3) * (NODE_H + ROW_Y),
    })),
  )
  const [edges, setEdges] = useState<EditorEdge[]>(() =>
    (initialGraph?.edges ?? []).filter((e) => e.type === 'seq' || e.type === 'cond' || e.type === 'loop').map((e, i) => ({
      id: `e-${i}-${e.from}-${e.to}`,
      from: e.from,
      to: e.to,
      type: (e.type === 'cond' || e.type === 'loop' ? e.type : 'seq') as EditorEdge['type'],
      ...(e.when !== undefined ? { when: e.when } : {}),
      ...(e.maxIter !== undefined ? { maxIter: e.maxIter } : {}),
    })),
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [roles, setRoles] = useState<Array<RoleDrop>>([])
  const [suggestion, setSuggestion] = useState<{ sourceId: string; items: Array<{ roleRef: string; label?: string; reason?: string }> } | null>(null)
  const [counter, setCounter] = useState(initialGraph?.nodes.length ?? 0)
  // P2：端口拖出连边（linking 状态 + 临时线端点）
  const [linking, setLinking] = useState<{ fromId: string; mx: number; my: number } | null>(null)
  const [dropIndicator, setDropIndicator] = useState<{ x: number; y: number } | null>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  // MVP-5B B6：角色库候选（节点编辑器 roleRef 下拉，动态拉取不硬编码）
  useEffect(() => {
    fetch('/api/weave/roles')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setRoles(Array.isArray(d) ? (d as RoleDrop[]) : []))
      .catch(() => setRoles([]))
  }, [])

  // MVP-5B UI 重构：节点编辑浮层回写（BoardOverlays 派发）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onNodeSaved = (e: Event): void => {
      const d = (e as CustomEvent<{ nodeId: string; node: EditorNode }>).detail
      if (!d?.nodeId || !d.node) return
      const ns = nodes.map((n) => (n.id === d.nodeId ? d.node : n))
      setNodes(ns)
      emit(ns, edges)
    }
    const onNodeDeleted = (e: Event): void => {
      const d = (e as CustomEvent<{ nodeId: string }>).detail
      if (!d?.nodeId) return
      removeNode(d.nodeId)
    }
    // P2：端口连边结果（EdgeTypePicker 选择后派发）
    const onEdgeCreated = (e: Event): void => {
      const d = (e as CustomEvent<{ fromId: string; toId: string; type: EditorEdge['type']; when?: string; maxIter?: number }>).detail
      if (!d?.fromId || !d?.toId) return
      const es: EditorEdge[] = [
        ...edges,
        {
          id: `e-${Date.now()}-${d.fromId}-${d.toId}`,
          from: d.fromId,
          to: d.toId,
          type: d.type,
          ...(d.when !== undefined ? { when: d.when } : {}),
          ...(d.maxIter !== undefined ? { maxIter: d.maxIter } : {}),
        },
      ]
      setEdges(es)
      emit(nodes, es)
    }
    window.addEventListener('weave:node-saved', onNodeSaved)
    window.addEventListener('weave:node-deleted', onNodeDeleted)
    window.addEventListener('weave:edge-created', onEdgeCreated)
    return () => {
      window.removeEventListener('weave:node-saved', onNodeSaved)
      window.removeEventListener('weave:node-deleted', onNodeDeleted)
      window.removeEventListener('weave:edge-created', onEdgeCreated)
    }
  }, [nodes, edges])

  const positioned = useMemo(() => layoutNodes(nodes, edges), [nodes, edges])

  const emit = (ns: EditorNode[], es: EditorEdge[]): void => {
    onGraphChange?.(buildGraphSpec(ns, es))
  }

  const openNodeEditor = (id: string): void => {
    const target = positioned.find((n) => n.id === id)
    if (!target) return
    const role = roles.find((r) => r.id === target.roleRef)
    window.dispatchEvent(new CustomEvent('weave:open-node-editor', {
      detail: {
        nodeId: id,
        node: target,
        roles,
        roleDefault: role
          ? {
              produces: role.produces,
              capabilities: role.capabilities,
              tools: role.tools,
            }
          : undefined,
      },
    }))
  }

  const addRoleByName = async (roleRef: string, sourceId: string): Promise<void> => {
    if (readonly) return
    const res = await fetch('/api/weave/roles')
    const roles = (await res.json()) as Array<{ id: string; name: string; suggests_next?: RoleDrop['suggests_next'] }>
    const role = roles.find((r) => r.id === roleRef)
    if (!role) return
    const id = `${role.id}-${counter + 1}`
    const idx = nodes.length
    const ns = [...nodes, {
      id, roleRef: role.id, roleName: role.name,
      x: (idx % 3) * (NODE_W + COL_X),        // ★ 修复：网格铺开
      y: Math.floor(idx / 3) * (NODE_H + ROW_Y),
    }]
    const es: EditorEdge[] = [...edges, { id: `e-${counter}-${sourceId}-${id}`, from: sourceId, to: id, type: 'seq' }]
    setNodes(ns)
    setEdges(es)
    setCounter(counter + 1)
    setSuggestion(role.suggests_next && role.suggests_next.length > 0 ? { sourceId: id, items: role.suggests_next } : null)
    emit(ns, es)
  }

  // P0：删隐式连边——点击只选中，连边走端口拖出（P2）
  const selectNode = (id: string): void => {
    setSelectedId(id === selectedId ? null : id)
  }

  const removeNode = (id: string): void => {
    if (readonly) return
    const ns = nodes.filter((n) => n.id !== id)
    const es = edges.filter((e) => e.from !== id && e.to !== id)
    setNodes(ns)
    setEdges(es)
    setSelectedId(null)
    setSuggestion(null)
    emit(ns, es)
  }

  // P3：20px 网格吸附（纯函数 snapToGrid）
  const onDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    if (readonly) return
    const rect = innerRef.current?.getBoundingClientRect()
    if (!rect) return
    setDropIndicator({ x: snapToGrid(e.clientX - rect.left - NODE_W / 2), y: snapToGrid(e.clientY - rect.top - NODE_H / 2) })
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    if (readonly) return
    const rect = innerRef.current?.getBoundingClientRect()
    const x = snapToGrid(e.clientX - (rect?.left ?? 0) - NODE_W / 2)
    const y = snapToGrid(e.clientY - (rect?.top ?? 0) - NODE_H / 2)
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
    setDropIndicator(null)
  }

  const selected = positioned.find((n) => n.id === selectedId) ?? null

  // P2：端口拖出连边（linking 模式；mouseup 判定落点 → 弹 EdgeTypePicker）
  const onPortDown = (fromId: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    if (readonly) return
    setLinking({ fromId, mx: e.clientX, my: e.clientY })
    const onMove = (ev: MouseEvent): void => {
      setLinking((prev) => (prev ? { ...prev, mx: ev.clientX, my: ev.clientY } : prev))
    }
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const targetEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-node-id]')
      const toId = targetEl?.getAttribute('data-node-id')
      setLinking(null)
      const resolved = resolveLinkTarget(fromId, toId ?? null)
      if (resolved) {
        window.dispatchEvent(new CustomEvent('weave:open-edge-picker', { detail: { fromId, toId: resolved } }))
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div style={{ position: 'relative', width: '100%', minHeight: 260, height: '100%', border: '1px dashed #ccc', borderRadius: 8, background: '#fafafa', overflow: 'hidden' }}>
      {/* MVP-5 Phase D：边流动画（seq 虚线流动；cond 蓝实线；loop 橙弧线+maxIter 标签） */}
      <style>{'@keyframes weave-edge-flow { to { stroke-dashoffset: -12; } }'}</style>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {edges.map((e) => {
          const a = positioned.find((n) => n.id === e.from)
          const b = positioned.find((n) => n.id === e.to)
          if (!a || !b) return null
          const x1 = a.x + NODE_W / 2
          const y1 = a.y + NODE_H / 2
          const x2 = b.x + NODE_W / 2
          const y2 = b.y + NODE_H / 2
          const isLoop = e.type === 'loop'
          const isCond = e.type === 'cond'
          return (
            <g key={e.id}>
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={isLoop ? '#f59e0b' : isCond ? '#3b82f6' : '#94a3b8'}
                strokeWidth={isLoop || isCond ? 2 : 1.5}
                strokeDasharray={isLoop ? undefined : '6 4'}
                style={!isLoop && !isCond ? { animation: 'weave-edge-flow 1s linear infinite' } : undefined}
              />
              {isLoop && e.maxIter !== undefined && (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} fill="#b45309" fontSize={10}>
                  loop ×{e.maxIter}
                </text>
              )}
              {isCond && e.when && (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} fill="#1d4ed8" fontSize={10}>
                  {e.when}
                </text>
              )}
            </g>
          )
        })}
        {/* P2：linking 临时线（端口 → 鼠标） */}
        {linking && (() => {
          const from = positioned.find((n) => n.id === linking.fromId)
          if (!from) return null
          const rect = innerRef.current?.getBoundingClientRect()
          const originX = from.x + NODE_W / 2
          const originY = from.y + NODE_H / 2
          const mx = rect ? linking.mx - rect.left : originX
          const my = rect ? linking.my - rect.top : originY
          return (
            <line x1={originX} y1={originY} x2={mx} y2={my} stroke="#4f46e5" strokeWidth={2} strokeDasharray="4 4" />
          )
        })()}
      </svg>

      <div
        ref={innerRef}
        style={{ position: 'absolute', inset: 0 }}
        onDragOver={onDragOver}
        onDragLeave={() => setDropIndicator(null)}
        onDrop={onDrop}
      >
        {positioned.map((n) => {
          const status = liveState?.[n.id]
          const act = liveActivity?.get(n.id)
          return (
          <div
            key={n.id}
            data-node-id={n.id}
            draggable={!readonly}
            onDragStart={(e) => {
              e.dataTransfer.setData('application/weave-node', n.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onClick={() => selectNode(n.id)}
            onDoubleClick={() => {
              // MVP-5B UI 重构：双击派发事件（BoardOverlays 渲染浮层）
              if (readonly) return
              openNodeEditor(n.id)
            }}
            className={status ? `node status-${status}` : 'node'}
            style={{
              position: 'absolute',
              left: n.x,
              top: n.y,
              width: NODE_W,
              height: NODE_H,
              border: selectedId === n.id ? '2px solid #3b82f6' : status === 'running' ? '2px solid #f59e0b' : '1px solid #cbd5e1',
              borderRadius: 8,
              background: status ? (NODE_STATUS_COLOR[status] ?? '#fff') : '#fff',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              padding: '0 8px',
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(0,0,0,.12)',
              fontSize: 12,
              transition: 'background .2s, border-color .2s',
            }}
          >
            <strong>{n.roleName}</strong>
            <span style={{ color: '#64748b' }}>{n.id}</span>
            {n.modelOverride && <span style={{ color: '#8b5cf6' }}>⚙ {n.modelOverride}</span>}
            {n.approval && <span style={{ color: '#f59e0b' }}>✓ 需审批</span>}
            {n.override && Object.keys(n.override).length > 0 && (
              <span style={{ color: '#4f46e5' }}>⚡ 覆盖</span>
            )}
            {status === 'waiting' && <span style={{ color: '#b45309' }}>⏳ 等待依赖</span>}
            {/* P4：头顶活动气泡 */}
            {act?.text && (
              <span
                className="node-bubble"
                style={{
                  position: 'absolute', top: -20, left: 4, right: 4,
                  background: 'rgba(15,23,42,.85)', color: '#fff',
                  borderRadius: 6, padding: '1px 6px', fontSize: 10.5,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  pointerEvents: 'none',
                }}
              >
                {act.icon ?? '💬'} {act.text}
              </span>
            )}
            {!readonly && (
              <button
                style={{ position: 'absolute', top: 2, right: 2, border: 'none', background: 'transparent', color: '#ef4444', cursor: 'pointer' }}
                onClick={(e) => { e.stopPropagation(); removeNode(n.id) }}
              >
                ×
              </button>
            )}
            {/* P2：输出端口（悬停出现；端口拖出连边） */}
            {!readonly && (
              <span
                className="node-port"
                onMouseDown={(e) => onPortDown(n.id, e)}
                title={`从 ${n.id} 拖出连线`}
                style={{
                  position: 'absolute', right: -5, top: '50%', transform: 'translateY(-50%)',
                  width: 10, height: 10, borderRadius: '50%', background: '#4f46e5',
                  border: '2px solid #fff', cursor: 'crosshair', opacity: 0,
                  boxShadow: '0 0 0 1px rgba(79,70,229,.4)',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLSpanElement).style.opacity = '1' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLSpanElement).style.opacity = '0' }}
              />
            )}
          </div>
          )
        })}
        {nodes.length === 0 && !readonly && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>
            从左侧角色库拖入角色，开始编排
          </div>
        )}
        {/* P3：拖放落点指示 */}
        {dropIndicator && (
          <div style={{
            position: 'absolute', left: dropIndicator.x - 6, top: dropIndicator.y - 6,
            width: 12, height: 12, borderRadius: '50%', background: 'rgba(79,70,229,.35)',
            border: '2px solid #4f46e5', pointerEvents: 'none',
          }} />
        )}
      </div>

      {suggestion && !readonly && (
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

      {selected && !readonly && (
        <div style={{
          position: 'absolute', left: 8, right: 8, bottom: 8,
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
          padding: '6px 10px', fontSize: 12,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <strong>{selected.roleName}</strong>
          <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{selected.id}</span>
          <button
            onClick={() => openNodeEditor(selected.id)}
            style={{ marginLeft: 'auto', padding: '4px 12px', cursor: 'pointer' }}
          >
            ⚙ 编辑配置
          </button>
          <button
            onClick={() => setSelectedId(null)}
            style={{ padding: '4px 8px', cursor: 'pointer' }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
