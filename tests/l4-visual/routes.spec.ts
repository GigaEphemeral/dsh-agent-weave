/**
 * MVP-5 REST 路由单测（Phase I/A/B）。
 *
 * 通过 registerVisualRoutes 暴露的 getWeaveHandler() 直接调用内部 handler，
 * 覆盖：任务 CRUD/取消/启动守卫、角色库、图保存/列表。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerVisualRoutes, getWeaveHandler } from '../../src/l4-visual/host/routes'
import { createSseBroker } from '../../src/l4-visual/host/sse-broker'
import { createApprovalService } from '../../src/l4-visual/host/approval-service'
import { createTokenCollector } from '../../src/l5-observability/token-collector'
import { createTask, deleteTask } from '../../src/l4-visual/host/task-store'
import { setRolesDir } from '../../src/l4-visual/host/role-library'
import { setGraphsDir } from '../../src/l4-visual/host/graph-store'
import { buildGraphFromTemplate } from '../../src/l4-visual/host/task-store'

interface ResState { status: number; body: unknown }

function makeRes(): { res: unknown; state: ResState } {
  const state: ResState = { status: 0, body: null }
  const res = {
    writeHead(code: number): Record<string, unknown> { state.status = code; return {} },
    end(body?: string): unknown { state.body = body ? JSON.parse(body) as unknown : null; return {} },
    write(): boolean { return true },
  }
  return { res, state }
}

interface ReqMock {
  method?: string
  url?: string
  headers: Record<string, string>
  on(ev: string, cb: (...args: unknown[]) => void): unknown
  off(ev: string, cb: (...args: unknown[]) => void): unknown
  _emit(ev: string, ...args: unknown[]): void
}

function makeReq(method: string, url: string, body?: unknown): ReqMock {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  return {
    method,
    url,
    headers: {},
    on(ev, cb) { (listeners[ev] ??= []).push(cb); return {} },
    off(ev, cb) {
      const arr = listeners[ev] ?? []
      const i = arr.indexOf(cb)
      if (i >= 0) arr.splice(i, 1)
      return {}
    },
    _emit(ev, ...args) {
      for (const cb of listeners[ev] ?? []) cb(...args)
    },
  }
}

function setupHandler(): (rest: string, req: unknown, res: unknown) => Promise<void> {
  delete process.env.WEAVE_API_TOKEN
  const broker = createSseBroker()
  const approvals = createApprovalService(broker)
  const tokens = createTokenCollector()
  const ctx = {
    get: () => undefined,
    on: () => {},
    emit: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    subagents: { list: () => [], sendMessage: async () => 'x' },
    effect: (fn: () => unknown) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  }
  const webServer = { register: () => () => {} }
  registerVisualRoutes(ctx as never, broker, approvals, tokens, webServer)
  const handle = getWeaveHandler()
  if (!handle) throw new Error('handler not exposed')
  return handle as (rest: string, req: unknown, res: unknown) => Promise<void>
}

const r1Yaml = `schema_version: '1.0'
id: R1-requirement
name: 需求分析师
description: 分析用户需求
order: 10
tags: [需求]
system_prompt_ref: R1/SKILL.md
traits: []
capabilities: []
tools: []
model: { provider: huoshan-haowen, model: deepseek-v4-flash }
memory_scope: private
lifecycle: on-demand
max_concurrent_children: 1
capability: { allow_delegation: false, max_depth: 1, allowed_children: [], allow_shell: true, allow_write: true }
quality_gate: []
token_budget: 2000
handoff: { upstream: [], downstream: [R2], edge_type: seq }
`

let rolesDir = ''
let graphsDir = ''

beforeEach(() => {
  rolesDir = mkdtempSync(join(tmpdir(), 'weave-routes-roles-'))
  graphsDir = mkdtempSync(join(tmpdir(), 'weave-routes-graphs-'))
  writeFileSync(join(rolesDir, 'R1-requirement.yaml'), r1Yaml, 'utf8')
  setRolesDir(rolesDir)
  setGraphsDir(graphsDir)
})

afterEach(() => {
  rmSync(rolesDir, { recursive: true, force: true })
  rmSync(graphsDir, { recursive: true, force: true })
})

describe('weave REST 路由', () => {
  it('GET /tasks 返回任务列表', async () => {
    const handle = setupHandler()
    const { res, state } = makeRes()
    createTask({
      taskId: 'task-r1', sessionId: 's1', userInput: 'x', template: 'full-sdlc',
      graph: buildGraphFromTemplate('full-sdlc'), status: 'proposing',
    })
    await handle('/tasks', makeReq('GET', '/api/weave/tasks'), res)
    expect(state.status).toBe(200)
    expect((state.body as Array<{ taskId: string }>).some((t) => t.taskId === 'task-r1')).toBe(true)
    deleteTask('task-r1')
  })

  it('POST /tasks/:id/cancel → aborted', async () => {
    const handle = setupHandler()
    createTask({
      taskId: 'task-c1', sessionId: 's2', userInput: 'x', template: 'quick-dev',
      graph: buildGraphFromTemplate('quick-dev'), status: 'proposing',
    })
    const { res, state } = makeRes()
    await handle('/tasks/task-c1/cancel', makeReq('POST', '/api/weave/tasks/task-c1/cancel'), res)
    expect(state.status).toBe(200)
    deleteTask('task-c1')
  })

  it('POST /tasks/:id/start 缺少 parentAgent → 409', async () => {
    const handle = setupHandler()
    createTask({
      taskId: 'task-s1', sessionId: 's3', userInput: 'x', template: 'custom',
      graph: buildGraphFromTemplate('custom'), status: 'drafting',
    })
    const { res, state } = makeRes()
    await handle('/tasks/task-s1/start', makeReq('POST', '/api/weave/tasks/task-s1/start'), res)
    expect(state.status).toBe(409)
    deleteTask('task-s1')
  })

  it('GET /roles 返回角色库（搜索/排序参数透传）', async () => {
    const handle = setupHandler()
    const { res, state } = makeRes()
    await handle('/roles', makeReq('GET', '/api/weave/roles?search=需求'), res)
    expect(state.status).toBe(200)
    expect((state.body as Array<{ id: string }>)[0]?.id).toBe('R1-requirement')
  })

  it('POST /graphs 保存 + GET /graphs/saved 列表', async () => {
    const handle = setupHandler()
    const spec = buildGraphFromTemplate('quick-dev')
    const req = makeReq('POST', '/api/weave/graphs', { id: 'g1', spec })
    const saveRes = makeRes()
    const pending = handle('/graphs', req, saveRes.res)
    req._emit('data', Buffer.from(JSON.stringify({ id: 'g1', spec })))
    req._emit('end')
    await pending
    expect(saveRes.state.status).toBe(200)

    const listRes = makeRes()
    await handle('/graphs/saved', makeReq('GET', '/api/weave/graphs/saved'), listRes.res)
    expect(listRes.state.status).toBe(200)
    expect((listRes.state.body as Array<{ id: string }>)[0]?.id).toBe('g1')
  })

  // ─── MVP-5B B6：角色编辑器动态候选值 + 交接单（planB §5.x） ───

  it('GET /providers /capabilities /tools 返回动态候选值（不硬编码）', async () => {
    const handle = setupHandler()
    const p = makeRes()
    await handle('/providers', makeReq('GET', '/api/weave/providers'), p.res)
    expect(p.state.status).toBe(200)
    expect((p.state.body as { overallSource: string }).overallSource).toBe('yaml-scan') // roles 目录有 R1

    const c = makeRes()
    await handle('/capabilities', makeReq('GET', '/api/weave/capabilities'), c.res)
    expect((c.state.body as { capabilities: string[] }).capabilities).toHaveLength(8)

    const t = makeRes()
    await handle('/tools', makeReq('GET', '/api/weave/tools'), t.res)
    expect((t.state.body as { tools: string[] }).tools).toBeInstanceOf(Array)
  })

  it('POST /roles 保存角色定义（§5.3）', async () => {
    const handle = setupHandler()
    const req = makeReq('POST', '/api/weave/roles', { id: 'R9-reviewer', name: '评审者', provider: 'acme', model: 'm1', tools: ['read'] })
    const res = makeRes()
    const pending = handle('/roles', req, res.res)
    req._emit('data', Buffer.from(JSON.stringify({ id: 'R9-reviewer', name: '评审者', provider: 'acme', model: 'm1', tools: ['read'] })))
    req._emit('end')
    await pending
    expect(res.state.status).toBe(200)
    expect((res.state.body as { ok: boolean; id: string }).ok).toBe(true)
    expect((res.state.body as { id: string }).id).toBe('R9-reviewer')
    // 落盘后角色库可搜索到（query 放 URL，rest 保持 /roles）
    const listRes = makeRes()
    await handle('/roles', makeReq('GET', '/api/weave/roles?search=R9-reviewer'), listRes.res)
    expect((listRes.state.body as Array<{ id: string }>).some((r) => r.id === 'R9-reviewer')).toBe(true)
  })

  it('POST /roles 非法（缺 id）→ ok:false', async () => {
    const handle = setupHandler()
    const req = makeReq('POST', '/api/weave/roles', { name: '无名' })
    const res = makeRes()
    const pending = handle('/roles', req, res.res)
    req._emit('data', Buffer.from(JSON.stringify({ name: '无名' })))
    req._emit('end')
    await pending
    expect((res.state.body as { ok: boolean }).ok).toBe(false)
  })

  it('GET /graph/:id/handoff 返回 latest/byNode（空图时 latest=null）', async () => {
    const handle = setupHandler()
    const res = makeRes()
    await handle('/graph/g-unknown/handoff', makeReq('GET', '/api/weave/graph/g-unknown/handoff'), res.res)
    expect(res.state.status).toBe(200)
    expect((res.state.body as { latest: unknown; byNode: Record<string, unknown> }).latest).toBeNull()
    expect((res.state.body as { byNode: Record<string, unknown> }).byNode).toEqual({})
  })
})
