/**
 * 图画布（MVP-4 P4.C.2 简化版）。
 *
 * 原生 SVG 自绘（节点≤50 场景零新依赖；MVP-5 可演进 React Flow）：
 * - 分层布局：按 seq 边拓扑分层（简化 dagre 语义），cond/loop 边跳过占位
 * - 节点按 snap.nodeStates 染色
 * - 点击节点回调 onSelectNode
 */
import { useMemo } from 'react'
import type { ClientGraphSpec, GraphSnapshot } from '../types'

interface Props {
  spec: ClientGraphSpec | null
  snap: GraphSnapshot | null
  roleMap: Record<string, string>
  onSelectNode: (nodeId: string) => void
}

const NODE_W = 130
const NODE_H = 46
const COL_X = 60
const ROW_Y = 40

/** 节点状态 → 填充色。 */
export function nodeFill(state: string | undefined): string {
  switch (state) {
    case 'running': return '#fbbf24'
    case 'completed': return '#22c55e'
    case 'failed': return '#ef4444'
    case 'waiting': return '#a5b4fc'
    case 'paused': return '#a5b4fc'
    default: return '#e5e7eb'
  }
}

/** 按 seq 边计算分层（cond/loop 边只影响同层）。 */
function layout(spec: ClientGraphSpec): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  const seqEdges = spec.edges.filter((e) => e.type === 'seq')
  const out = new Map<string, string[]>()
  for (const e of seqEdges) {
    const list = out.get(e.from) ?? []
    list.push(e.to)
    out.set(e.from, list)
  }
  const level = new Map<string, number>()
  const assign = (id: string, l: number): void => {
    const prev = level.get(id)
    if (prev !== undefined && prev >= l) return
    level.set(id, l)
    for (const to of out.get(id) ?? []) assign(to, l + 1)
  }
  assign(spec.entryPoint, 0)
  for (const n of spec.nodes) if (!level.has(n.id)) assign(n.id, 0)

  // 每层列坐标（同层节点竖直排布）
  const byLevel = new Map<number, string[]>()
  for (const [id, l] of level) {
    const list = byLevel.get(l) ?? []
    list.push(id)
    byLevel.set(l, list)
  }
  for (const [l, ids] of byLevel) {
    ids.forEach((id, i) => {
      pos.set(id, { x: l * (NODE_W + COL_X), y: i * (NODE_H + ROW_Y) })
    })
  }
  // 未分层节点（孤立）放底部
  let orphanY = byLevel.size * (NODE_H + ROW_Y)
  for (const n of spec.nodes) {
    if (!pos.has(n.id)) {
      pos.set(n.id, { x: 0, y: orphanY })
      orphanY += NODE_H + ROW_Y
    }
  }
  return pos
}

/** 渲染 SVG 图。 */
export function GraphCanvas({ spec, snap, roleMap, onSelectNode }: Props) {
  const { nodes, edges, width, height } = useMemo(() => {
    if (!spec) return { nodes: [], edges: [], width: 600, height: 400 }
    const pos = layout(spec)
    const ns = spec.nodes.map((n) => ({
      id: n.id,
      x: pos.get(n.id)?.x ?? 0,
      y: pos.get(n.id)?.y ?? 0,
      role: roleMap[n.id],
      state: snap?.nodeStates[n.id],
    }))
    const es = spec.edges.map((e, i) => {
      const from = pos.get(e.from)
      const to = pos.get(e.to)
      return {
        id: `${e.from}-${e.to}-${i}`,
        from,
        to,
        loop: e.type === 'loop',
      }
    })
    const w = Math.max(600, ...ns.map((n) => n.x + NODE_W + 40))
    const h = Math.max(400, ...ns.map((n) => n.y + NODE_H + 40))
    return { nodes: ns, edges: es, width: w, height: h }
  }, [spec, snap, roleMap])

  if (!spec) {
    return <div className="weave-canvas-empty" style={{ padding: 24, color: '#888' }}>（无图数据，请先运行 weave_run_graph）</div>
  }

  return (
    <div className="weave-canvas" style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'auto' }}>
      <svg width={width} height={height} style={{ display: 'block', background: '#fafafa' }}>
        {edges.map((e) =>
          e.from && e.to ? (
            <line
              key={e.id}
              x1={e.from.x + NODE_W / 2}
              y1={e.from.y + NODE_H / 2}
              x2={e.to.x + NODE_W / 2}
              y2={e.to.y + NODE_H / 2}
              stroke={e.loop ? '#f59e0b' : '#94a3b8'}
              strokeWidth={e.loop ? 2 : 1.5}
              strokeDasharray={e.loop ? '6 4' : undefined}
            />
          ) : null,
        )}
        {nodes.map((n) => (
          <g
            key={n.id}
            onClick={() => onSelectNode(n.id)}
            style={{ cursor: 'pointer' }}
          >
            <rect
              x={n.x}
              y={n.y}
              width={NODE_W}
              height={NODE_H}
              rx={6}
              fill={nodeFill(n.state)}
              stroke="#64748b"
              strokeWidth={snap?.current === n.id ? 2.5 : 1}
            />
            <text x={n.x + 8} y={n.y + 18} fontSize={12} fontWeight={600} fill="#111">
              {n.id}
            </text>
            <text x={n.x + 8} y={n.y + 34} fontSize={10} fill="#334155">
              {n.role ?? ''}
            </text>
            {snap?.current === n.id && (
              <text x={n.x + NODE_W - 8} y={n.y + 18} fontSize={10} fill="#7c2d12" textAnchor="end">
                运行中
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  )
}
