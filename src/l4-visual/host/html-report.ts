/**
 * HTML 执行报告生成器（MVP-2 T13）。
 *
 * 运行结束后生成自包含 HTML（内联 CSS + 简单 JS，无外部依赖），4 个 section：
 * - Summary：执行状态 / 迭代 / 耗时 / Token
 * - Graph SVG：节点按状态染色（绿=完成 黄=运行 红=失败 灰=闲置）
 * - Timeline：完整事件时间线
 * - Token 分账：按节点/角色 Token 消耗表
 */
import type { ExecutionSnapshot } from './event-bus.js'
import type { TrajectoryEvent } from '../../l2-engine/types.js'

/** 节点布局信息。 */
interface NodeLayout {
  id: string
  x: number
  y: number
}

/** 汇总 Token 分账（按节点）。 */
export interface TokenRow {
  node: string
  role: string
  input: number
  output: number
  cacheRead: number
  total: number
}

/** 从轨迹事件汇总 Token 分账。 */
export function summarizeTokens(trajectory: TrajectoryEvent[]): TokenRow[] {
  const byNode = new Map<string, TokenRow>()
  for (const event of trajectory) {
    if (event.type !== 'graph/node-end') continue
    const node = event.node ?? 'unknown'
    const data = event.data ?? {}
    const input = typeof data.inputTokens === 'number' ? data.inputTokens : 0
    const output = typeof data.outputTokens === 'number' ? data.outputTokens : 0
    const cacheRead = typeof data.cacheReadTokens === 'number' ? data.cacheReadTokens : 0
    const role = typeof data.role === 'string' ? data.role : ''
    const existing = byNode.get(node)
    if (existing) {
      existing.input += input
      existing.output += output
      existing.cacheRead += cacheRead
      existing.total += input + output + cacheRead
    } else {
      byNode.set(node, {
        node,
        role,
        input,
        output,
        cacheRead,
        total: input + output + cacheRead,
      })
    }
  }
  return [...byNode.values()].sort((a, b) => b.total - a.total)
}

/** 事件时间格式化（相对图开始）。 */
function formatRel(ts: number, start: number): string {
  const s = Math.max(0, Math.floor((ts - start) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** 事件图标。 */
function icon(type: TrajectoryEvent['type']): string {
  switch (type) {
    case 'graph/node-start':
      return '▶'
    case 'graph/node-end':
      return '✓'
    case 'graph/loop-iteration':
      return '⚠'
    case 'graph/node-error':
    case 'graph/error':
      return '✗'
    case 'graph/checkpoint-written':
      return '💾'
    default:
      return '·'
  }
}

/** 事件消息。 */
function message(event: TrajectoryEvent): string {
  switch (event.type) {
    case 'graph/start':
      return `图开始 ${event.graphId}`
    case 'graph/node-start':
      return `${event.node} 开始`
    case 'graph/node-end':
      return `${event.node} 完成 (${((event.durationMs ?? 0) / 1000).toFixed(1)}s)`
    case 'graph/loop-iteration':
      return `${event.node} 回退 (iter=${String(event.data?.iteration ?? '')})`
    case 'graph/node-error':
      return `${event.node} 出错: ${String(event.data?.error ?? '')}`
    case 'graph/error':
      return `图错误: ${String(event.data?.error ?? '')}`
    case 'graph/checkpoint-written':
      return `checkpoint @${event.node} iter=${String(event.data?.iteration ?? '')}`
    case 'graph/end':
      return '图结束'
    default:
      return event.type
  }
}

/** 布局节点（横向排列，避免重叠）。 */
function layoutNodes(nodeIds: string[]): NodeLayout[] {
  return nodeIds.map((id, i) => ({ id, x: 80 + i * 180, y: 80 }))
}

/** 生成 SVG 图结构。 */
function renderSvg(nodeIds: string[], edges: Array<{ from: string; to: string }>, snap: ExecutionSnapshot): string {
  const nodes = layoutNodes(nodeIds)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edgeLines = edges
    .map((e) => {
      const from = byId.get(e.from)
      const to = byId.get(e.to)
      if (!from || !to) return ''
      return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#999" stroke-width="1.5" marker-end="url(#arrow)"/>`
    })
    .join('\n')
  const nodeCircles = nodes
    .map((n) => {
      const state = snap.nodeStates[n.id] ?? 'idle'
      const fill =
        state === 'completed'
          ? '#22c55e'
          : state === 'running'
            ? '#fbbf24'
            : state === 'failed'
              ? '#ef4444'
              : '#e5e7eb'
      return `<g><circle cx="${n.x}" cy="${n.y}" r="28" fill="${fill}" stroke="#666" stroke-width="1.5"/><text x="${n.x}" y="${n.y + 4}" text-anchor="middle" font-size="11" fill="#111">${n.id}</text></g>`
    })
    .join('\n')
  const width = Math.max(400, nodes.length * 180 + 80)
  return `<svg viewBox="0 0 ${width} 160" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#999"/></marker></defs>
  ${edgeLines}
  ${nodeCircles}
</svg>`
}

/** 生成完整 HTML 报告。 */
export function renderHtmlReport(snap: ExecutionSnapshot, edges: Array<{ from: string; to: string }> = []): string {
  const tokens = summarizeTokens(snap.trajectory)
  const totalTokens = tokens.reduce((sum, t) => sum + t.total, 0)
  const statusClass = snap.status === 'completed' ? 'success' : snap.status === 'failed' ? 'failed' : 'running'
  const statusText = snap.status === 'completed' ? '完成' : snap.status === 'failed' ? '失败' : '运行中'

  const timelineHtml = snap.trajectory
    .map((e) => {
      const cls = e.type === 'graph/loop-iteration' ? 'warn' : e.type.includes('error') ? 'error' : ''
      return `<div class="timeline-entry ${cls}">[${formatRel(e.timestamp, snap.startedAt)}] ${icon(e.type)} ${message(e)}</div>`
    })
    .join('\n')

  const tokenRows = tokens
    .map(
      (t) =>
        `<tr><td>${t.node}</td><td>${t.role || '-'}</td><td>${t.input.toLocaleString()}</td><td>${t.output.toLocaleString()}</td><td>${t.cacheRead.toLocaleString()}</td><td>${t.total.toLocaleString()}</td></tr>`,
    )
    .join('\n')

  const nodeIds = [...new Set([...snap.trajectory.map((e) => e.node).filter(Boolean) as string[]])]
  const svg = renderSvg(nodeIds, edges, snap)

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Graph Execution Report · ${snap.graphId}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
  .summary { background: #f5f5f5; padding: 16px; border-radius: 8px; }
  .status-success { color: #16a34a; font-weight: bold; }
  .status-failed { color: #dc2626; font-weight: bold; }
  .status-running { color: #d97706; font-weight: bold; }
  .timeline-entry { padding: 4px 0; border-bottom: 1px solid #eee; font-family: monospace; }
  .timeline-entry.warn { color: #d97706; }
  .timeline-entry.error { color: #dc2626; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { padding: 8px; text-align: left; border-bottom: 1px solid #eee; }
  th { background: #f0f0f0; }
  section { margin-bottom: 28px; }
  h2 { border-bottom: 2px solid #eee; padding-bottom: 6px; }
</style>
</head>
<body>
  <h1>图执行报告</h1>
  <section class="summary">
    <h2>执行摘要</h2>
    <p>图 ID: <code>${snap.graphId}</code></p>
    <p>状态: <span class="status-${statusClass}">${statusText}</span></p>
    <p>迭代次数: ${snap.iteration} / ${snap.maxIterations}</p>
    <p>总耗时: ${(snap.elapsedMs / 1000).toFixed(1)}s</p>
    <p>总 Token: ${totalTokens.toLocaleString()}</p>
    <p>retry_count: ${snap.retryCount} / ${snap.maxRetry}</p>
  </section>
  <section>
    <h2>图结构</h2>
    ${svg}
  </section>
  <section>
    <h2>事件时间线</h2>
    <div id="timeline">
      ${timelineHtml}
    </div>
  </section>
  <section>
    <h2>Token 分账</h2>
    <table>
      <thead><tr><th>节点</th><th>角色</th><th>输入</th><th>输出</th><th>缓存读</th><th>合计</th></tr></thead>
      <tbody>
        ${tokenRows || '<tr><td colspan="6">（无 Token 数据）</td></tr>'}
      </tbody>
    </table>
  </section>
</body>
</html>`
}
