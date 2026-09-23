/**
 * 可视化 REST 路由（MVP-4 P4.B.1，webServer 对象路由契约）。
 *
 * 端点（prefix 匹配，手动解析路径参数）：
 *   GET  /api/weave/graphs                        运行历史
 *   GET  /api/weave/graph/:graphId/status         当前快照
 *   GET  /api/weave/graph/:graphId/spec           图定义+roleMap
 *   GET  /api/weave/graph/:graphId/stream         SSE 事件流
 *   GET  /api/weave/graph/:graphId/tokens         Token 分账
 *   GET  /api/weave/graph/:graphId/approvals      审批列表
 *   GET  /api/weave/graph/:graphId/checkpoints    恢复点
 *   GET  /api/weave/graph/:graphId/node/:nodeId/activity  节点活动
 *   POST /api/weave/graph/:graphId/pause|resume|stop      图控制
 *   POST /api/weave/approval/:id/approve|reject            审批决议
 *
 * 鉴权：x-weave-token 与 WEAVE_API_TOKEN 比对（P4.B.9）；未配置 env 时放行（本地单机）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SseBroker } from './sse-broker.js'
import type { ApprovalService } from './approval-service.js'
import type { TokenCollector } from '../../l5-observability/token-collector.js'
import type { WebServerLike } from './visual-runtime.js'
import { getGlobalSnapshot } from './shared-bus.js'
import { getGraph } from './spec-registry.js'
import { resolveArtifactsRoot } from './artifacts-root.js'
import { listRuns, listCheckpoints } from './run-history.js'
import { readNodeActivity } from './activity-reader.js'
import { pauseGraph, resumeGraph, stopGraph } from './graph-control.js'

type Req = { method?: string; url?: string; headers?: Record<string, string | string[] | undefined>; on?: (ev: string, cb: () => void) => unknown }
type Res = { writeHead(code: number, headers?: Record<string, string>): unknown; end(body?: string): unknown; write?(body: string): boolean }

function json(res: Res, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** 鉴权：env 未配置或 header 匹配则放行。 */
function requireAuth(req: Req): boolean {
  const token = process.env.WEAVE_API_TOKEN
  if (!token) return true
  const header = req.headers?.['x-weave-token']
  return header === token
}

/** 解析 /api/weave/graph/<graphId>/<rest...>。 */
function parseGraphPath(rest: string): { graphId: string; rest: string[] } | null {
  const parts = rest.split('/').filter(Boolean)
  if (parts.length < 1) return null
  const [graphId, ...tail] = parts
  return graphId ? { graphId, rest: tail } : null
}

/** 解析 /api/weave/approval/<id>/<action>。 */
function parseApprovalPath(rest: string): { id: string; action: string } | null {
  const parts = rest.split('/').filter(Boolean)
  if (parts.length < 2) return null
  return { id: parts[0] ?? '', action: parts[1] ?? '' }
}

export function registerVisualRoutes(
  ctx: Context,
  broker: SseBroker,
  approvals: ApprovalService,
  tokens: TokenCollector,
  webServer: WebServerLike,
): () => void {
  void ctx
  const disposers: Array<() => void> = []

  const handle = (rest: string, req: Req, res: Res): void => {
    if (!requireAuth(req)) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    const method = req.method ?? 'GET'

    // GET /api/weave/graphs（无 graphId）
    if (rest === '/graphs' || rest === '/graphs/') {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      const entry = getGraph('') // 当前注册图（单图模式取任意）
      const root = entry?.artifactsRoot ?? resolveArtifactsRoot({})
      json(res, 200, listRuns(root))
      return
    }

    // GET /api/weave/approval/:id/:action
    if (rest.startsWith('/approval/')) {
      if (method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
      const parsed = parseApprovalPath(rest.slice('/approval/'.length))
      if (!parsed) { json(res, 400, { error: 'bad approval path' }); return }
      const decision = parsed.action === 'approve' ? 'approved' : parsed.action === 'reject' ? 'rejected' : null
      if (!decision) { json(res, 400, { error: `unknown action: ${parsed.action}` }); return }
      const ok = approvals.resolve(parsed.id, decision)
      json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'approval not found or resolved' })
      return
    }

    // /api/weave/graph/<graphId>/...
    if (!rest.startsWith('/graph/')) { json(res, 404, { error: 'not found' }); return }
    const parsed = parseGraphPath(rest.slice('/graph/'.length))
    if (!parsed) { json(res, 400, { error: 'bad graph path' }); return }
    const { graphId, rest: tail } = parsed
    const entry = getGraph(graphId)

    // GET /graph/:graphId/stream（SSE）
    if (tail[0] === 'stream' && tail.length === 1) {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      const lastEventId = req.headers?.['last-event-id']
      const raw = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId
      const subId = broker.subscribe(graphId, res as never, raw)
      req.on?.('close', () => broker.unsubscribe(subId))
      return
    }

    // GET /graph/:graphId/status
    if (tail[0] === 'status' && tail.length === 1) {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      const snap = getGlobalSnapshot()
      if (!snap || snap.graphId !== graphId) { json(res, 404, { error: 'no active graph' }); return }
      json(res, 200, snap)
      return
    }

    // GET /graph/:graphId/spec
    if (tail[0] === 'spec' && tail.length === 1) {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      if (!entry) { json(res, 404, { error: 'graph not found' }); return }
      json(res, 200, { spec: entry.spec, roleMap: entry.roleMap })
      return
    }

    // GET /graph/:graphId/tokens
    if (tail[0] === 'tokens' && tail.length === 1) {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      json(res, 200, { rows: tokens.rows(), total: tokens.total() })
      return
    }

    // GET /graph/:graphId/approvals
    if (tail[0] === 'approvals' && tail.length === 1) {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      json(res, 200, approvals.list(graphId))
      return
    }

    // GET /graph/:graphId/checkpoints
    if (tail[0] === 'checkpoints' && tail.length === 1) {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      // 单图模式：checkpoint store 未全局化，返回空列表（Phase D 接真实 store）
      json(res, 200, listCheckpoints(undefined, graphId))
      return
    }

    // GET /graph/:graphId/node/:nodeId/activity
    if (tail[0] === 'node' && tail.length === 3 && tail[2] === 'activity') {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      const nodeId = tail[1]
      const root = entry?.artifactsRoot ?? resolveArtifactsRoot({})
      json(res, 200, readNodeActivity(root, graphId, nodeId ?? ''))
      return
    }

    // POST /graph/:graphId/pause|resume|stop
    if (tail.length === 1 && ['pause', 'resume', 'stop'].includes(tail[0] ?? '')) {
      if (method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
      const root = entry?.artifactsRoot ?? resolveArtifactsRoot({})
      const action = tail[0] as 'pause' | 'resume' | 'stop'
      if (action === 'pause') void pauseGraph(graphId, root)
      else if (action === 'resume') void resumeGraph(graphId, root)
      else void stopGraph(graphId, root)
      json(res, 200, { ok: true, action })
      return
    }

    json(res, 404, { error: 'not found' })
  }

  // prefix 路由：/api/weave/*（内部再分发）
  disposers.push(
    webServer.register({
      kind: 'prefix',
      path: '/api/weave',
      handler: (req, res) => {
        const r = req as Req
        const rs = res as Res
        const url = r.url ?? ''
        const rest = url.split('?')[0]?.slice('/api/weave'.length) ?? ''
        // SSE 需要 res.write 存在
        handle(rest, r, rs)
      },
    }),
  )

  return () => {
    for (const d of disposers) d()
  }
}
