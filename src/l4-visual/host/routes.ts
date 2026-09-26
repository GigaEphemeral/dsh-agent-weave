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
import { controlActiveGraph } from '../../l2-engine/graph-control.js'
import type { GraphDefinitionSpec } from '../../l2-engine/types.js'
import {
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  STARTABLE_STATUSES,
  type TaskDraft,
} from './task-store.js'

type Req = {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  on?: (ev: string, cb: (...args: unknown[]) => void) => unknown
  off?: (ev: string, cb: (...args: unknown[]) => void) => unknown
}
type Res = { writeHead(code: number, headers?: Record<string, string>): unknown; end(body?: string): unknown; write?(body: string): boolean }

/** 读取 JSON 请求体（空 body 返回 {}）。 */
function readBody(req: Req): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const onData = (chunk: unknown): void => {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk, 'utf8'))
    }
    const onEnd = (): void => {
      req.off?.('data', onData)
      req.off?.('end', onEnd)
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    }
    req.on?.('data', onData)
    req.on?.('end', onEnd)
  })
}

/** 对外返回任务（剥离非序列化 parentAgent）。 */
function publicTask(task: TaskDraft): Omit<TaskDraft, 'parentAgent'> {
  const { parentAgent: _parentAgent, ...pub } = task
  void _parentAgent
  return pub
}

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

type WeaveHandler = (rest: string, req: Req, res: Res) => Promise<void>

/** 最近一次注册的 weave 请求处理器（供单测直接调用；不参与生产路由）。 */
let weaveHandler: WeaveHandler | null = null

export function getWeaveHandler(): WeaveHandler | null {
  return weaveHandler
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

  const handle = async (rest: string, req: Req, res: Res): Promise<void> => {
    if (!requireAuth(req)) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    const method = req.method ?? 'GET'
    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')

    // GET /api/weave/stream —— 全局事件流（★ 问题一步骤2：前端感知新图启动）
    if (rest === '/stream' || rest === '/stream/') {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      const lastEventId = req.headers?.['last-event-id']
      const raw = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId
      const subId = broker.subscribe('*', res as never, raw)
      req.on?.('close', () => broker.unsubscribe(subId))
      return
    }

    // GET /api/weave/graphs/active —— 当前活跃图（★ 问题一步骤5：前端兜底绑定）
    if (rest === '/graphs/active' || rest === '/graphs/active/') {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      const snap = getGlobalSnapshot()
      if (!snap || !snap.graphId) { json(res, 404, { error: 'no active graph' }); return }
      json(res, 200, { graphId: snap.graphId })
      return
    }

    // GET /api/weave/roles —— 角色库（MVP-5 Phase A：搜索/排序）
    if (rest === '/roles' || rest === '/roles/') {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      const { listRoles } = await import('./role-library.js')
      json(res, 200, listRoles({
        search: query.get('search') ?? undefined,
        sort: query.get('sort') === 'name' ? 'name' : 'order',
      }))
      return
    }

    // 图保存与复用（MVP-5 Phase B）：/api/weave/graphs/saved[...]
    const gparts = rest.split('/').filter(Boolean)
    if (gparts[0] === 'graphs' && gparts[1] === 'saved') {
      const { listSavedGraphs, loadSavedGraph, deleteSavedGraph, cloneSavedGraph } = await import('./graph-store.js')
      if (gparts.length === 2 && method === 'GET') {
        json(res, 200, listSavedGraphs())
        return
      }
      if (gparts.length === 3) {
        const id = gparts[2] ?? ''
        if (method === 'GET') {
          const g = loadSavedGraph(id)
          if (!g) { json(res, 404, { error: 'graph not found' }); return }
          json(res, 200, g)
          return
        }
        if (method === 'DELETE') {
          const ok = deleteSavedGraph(id)
          json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'graph not found' })
          return
        }
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (gparts.length === 4 && gparts[3] === 'clone' && method === 'POST') {
        const r = cloneSavedGraph(gparts[2] ?? '')
        json(res, r.ok ? 200 : 404, r)
        return
      }
      json(res, 400, { error: 'bad graphs path' })
      return
    }

    // POST /api/weave/graphs —— 保存图（Phase B）
    if (rest === '/graphs' || rest === '/graphs/') {
      if (method === 'POST') {
        const body = await readBody(req)
        const spec = body.spec as GraphDefinitionSpec | undefined
        const id = typeof body.id === 'string' && body.id ? body.id : 'graph-' + Date.now()
        const meta = (body.meta ?? {}) as { name?: string; description?: string }
        if (!spec) { json(res, 400, { error: 'spec required' }); return }
        const { saveGraph } = await import('./graph-store.js')
        try {
          json(res, 200, saveGraph(id, spec, meta))
        } catch (error) {
          json(res, 400, { error: 'graph invalid', details: error instanceof Error ? error.message : String(error) })
        }
        return
      }
    }

    // GET /api/weave/graphs（无 graphId）
    if (rest === '/graphs' || rest === '/graphs/') {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      const entry = getGraph('') // 当前注册图（单图模式取任意）
      const root = entry?.artifactsRoot ?? resolveArtifactsRoot({})
      json(res, 200, listRuns(root))
      return
    }

    // ─── 任务草稿（MVP-5 Phase I） ───────────────────────────────
    const tparts = rest.split('/').filter(Boolean)
    if (tparts[0] === 'tasks' && tparts.length === 1) {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      json(res, 200, listTasks().map(publicTask))
      return
    }
    if (tparts[0] === 'tasks' && tparts.length === 2) {
      const taskId = tparts[1] ?? ''
      const task = getTask(taskId)
      if (!task) { json(res, 404, { error: 'task not found' }); return }
      if (method === 'GET') {
        json(res, 200, publicTask(task))
        return
      }
      if (method === 'PATCH') {
        const body = await readBody(req)
        const graph = body.graph as TaskDraft['graph'] | undefined
        const status = body.status as TaskDraft['status'] | undefined
        const next = updateTask(taskId, {
          ...(typeof body.userInput === 'string' ? { userInput: body.userInput } : {}),
          ...(graph !== undefined ? { graph } : {}),
          ...(status !== undefined ? { status } : {}),
        })
        if (!next) { json(res, 404, { error: 'task not found' }); return }
        json(res, 200, publicTask(next))
        return
      }
      if (method === 'DELETE') {
        deleteTask(taskId)
        json(res, 200, { ok: true })
        return
      }
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (tparts[0] === 'tasks' && tparts.length === 3) {
      const taskId = tparts[1] ?? ''
      const action = tparts[2] ?? ''
      const task = getTask(taskId)
      if (!task) { json(res, 404, { error: 'task not found' }); return }

      if (method === 'POST' && action === 'start') {
        if (!STARTABLE_STATUSES.has(task.status)) {
          json(res, 409, { error: `任务状态不允许启动: ${task.status}` })
          return
        }
        if (!task.parentAgent) {
          json(res, 409, { error: '任务缺少 parent agent（请由主 agent 发起启动）' })
          return
        }
        const started = updateTask(taskId, { status: 'running', startedAt: Date.now() })
        const { runGraphRealTool } = await import('../../cli/graph-run-commands.js')
        try {
          const result = await runGraphRealTool(
            ctx,
            task.graph,
            task.userInput,
            task.parentAgent as never,
            task.outputDir,
          )
          updateTask(taskId, { graphId: result.graphId, status: 'running' })
          json(res, 200, { ok: true, taskId, graphId: result.graphId, status: 'running' })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          updateTask(taskId, { status: 'failed', error: message })
          json(res, 500, { ok: false, error: message })
        }
        void started
        return
      }

      if (method === 'POST' && action === 'cancel') {
        const next = updateTask(taskId, { status: 'aborted' })
        json(res, 200, next ? { ok: true, status: next.status } : { ok: false })
        return
      }

      if (method === 'POST' && action === 'answer') {
        const body = await readBody(req)
        const answer = typeof body.answer === 'string' ? body.answer : ''
        if (!task.currentChildId || !task.parentAgent) {
          json(res, 409, { error: '任务当前没有等待回答的子代理' })
          return
        }
        try {
          await ctx.subagents.sendMessage(
            task.parentAgent as never,
            task.currentChildId as never,
            [{ type: 'text', text: `[用户回答] ${answer}` }],
            { signal: new AbortController().signal },
          )
          updateTask(taskId, { status: 'running' })
          json(res, 200, { ok: true, status: 'running' })
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      json(res, 405, { error: 'method not allowed' })
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

    // GET /graph/:graphId/tokens（MVP-5 Phase E：总 + 每节点 + 每角色）
    if (tail[0] === 'tokens' && tail.length === 1) {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      const rows = tokens.rows()
      const roleMap = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number }>()
      for (const row of rows) {
        const agg = roleMap.get(row.role) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }
        agg.inputTokens += row.usage.inputTokens
        agg.outputTokens += row.usage.outputTokens
        agg.cacheReadTokens += row.usage.cacheReadTokens
        agg.totalTokens += row.usage.totalTokens
        roleMap.set(row.role, agg)
      }
      json(res, 200, {
        rows,
        total: tokens.total(),
        byRole: [...roleMap.entries()].map(([role, usage]) => ({ role, usage })),
      })
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

    // GET /graph/:graphId/logs —— 结构化日志（MVP-5 Phase G）
    if (tail[0] === 'logs' && tail.length === 1) {
      if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
      const { readTraceLogs } = await import('./log-reader.js')
      const root = entry?.artifactsRoot ?? resolveArtifactsRoot({})
      const limit = Number.parseInt(query.get('limit') ?? '500', 10)
      json(res, 200, readTraceLogs(root, graphId, {
        limit: Number.isFinite(limit) ? limit : 500,
        level: query.get('level') ?? undefined,
        search: query.get('search') ?? undefined,
      }))
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
    // 问题四修复4：优先内存化图控制（即时响应）；同时写标志文件兼容 chain-runner
    if (tail.length === 1 && ['pause', 'resume', 'stop'].includes(tail[0] ?? '')) {
      if (method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
      const root = entry?.artifactsRoot ?? resolveArtifactsRoot({})
      const action = tail[0] as 'pause' | 'resume' | 'stop'
      controlActiveGraph(action, graphId)
      if (action === 'pause') void pauseGraph(graphId, root)
      else if (action === 'resume') void resumeGraph(graphId, root)
      else void stopGraph(graphId, root)
      json(res, 200, { ok: true, action })
      return
    }

    json(res, 404, { error: 'not found' })
  }

  // 暴露 handler 供单测直接调用（生产不受影响）
  weaveHandler = handle

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
