/**
 * MVP-5 Phase I：任务草稿存储 + 单图模式守卫 + 模板图。
 */
import { describe, expect, it } from 'vitest'
import {
  buildGraphFromTemplate,
  canProposeTask,
  createTask,
  deleteTask,
  getActiveTask,
  getTask,
  listTasks,
  updateTask,
  STARTABLE_STATUSES,
} from '../../src/l4-visual/host/task-store'
import type { TaskDraft } from '../../src/l4-visual/host/task-store'

function makeTask(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    taskId: 'task-1',
    sessionId: 'sess-1',
    userInput: '做个 ETF 工具',
    template: 'full-sdlc',
    graph: buildGraphFromTemplate('full-sdlc'),
    status: 'proposing',
    ...overrides,
  }
}

describe('task-store', () => {
  it('createTask + getTask + listTasks', () => {
    createTask(makeTask())
    const t = getTask('task-1')
    expect(t?.userInput).toBe('做个 ETF 工具')
    expect(listTasks().some((x) => x.taskId === 'task-1')).toBe(true)
    deleteTask('task-1')
  })

  it('单图模式：会话活跃任务存在时拒绝新任务', () => {
    createTask(makeTask())
    const guard = canProposeTask('sess-1')
    expect(guard.ok).toBe(false)
    expect(guard.existing?.taskId).toBe('task-1')
    deleteTask('task-1')
  })

  it('任务终结后可再次提议（terminal status 放行）', () => {
    createTask(makeTask({ status: 'completed' }))
    expect(canProposeTask('sess-1').ok).toBe(true)
    deleteTask('task-1')
  })

  it('getActiveTask 只返回非终结状态任务', () => {
    createTask(makeTask())
    expect(getActiveTask('sess-1')?.taskId).toBe('task-1')
    updateTask('task-1', { status: 'failed' })
    expect(getActiveTask('sess-1')).toBeUndefined()
    deleteTask('task-1')
  })

  it('updateTask 更新时间戳并合并补丁', () => {
    createTask(makeTask())
    const t0 = getTask('task-1')
    const next = updateTask('task-1', { status: 'running', graphId: 'graph-x' })
    expect(next?.status).toBe('running')
    expect(next?.graphId).toBe('graph-x')
    expect(next?.updatedAt).toBeGreaterThanOrEqual(t0?.updatedAt ?? 0)
    deleteTask('task-1')
  })
})

describe('buildGraphFromTemplate', () => {
  it('full-sdlc：六阶段 + SOP 约束 + 独立验证', () => {
    const g = buildGraphFromTemplate('full-sdlc')
    expect(g.entryPoint).toBe('requirement')
    expect(g.nodes.map((n) => n.id)).toEqual(['requirement', 'architecture', 'design', 'develop', 'test', 'quality'])
    expect(g.edges).toHaveLength(5)
    expect(g.constraints?.required_phases).toEqual(['requirement', 'architecture', 'design', 'develop', 'test', 'quality'])
    expect(g.constraints?.independent_verification?.test_node).toBe('test')
    expect(g.constraints?.independent_verification?.quality_node).toBe('quality')
    expect(g.constraints?.allow_silent_degrade).toBe(false)
    expect(g.graphSchemaHash.length).toBeGreaterThan(0)
  })

  it('quick-dev：三阶段（开发-测试-评审）', () => {
    const g = buildGraphFromTemplate('quick-dev')
    expect(g.entryPoint).toBe('develop')
    expect(g.nodes.map((n) => n.id)).toEqual(['develop', 'test', 'quality'])
  })

  it('research-only：两阶段（需求-架构）', () => {
    const g = buildGraphFromTemplate('research-only')
    expect(g.entryPoint).toBe('requirement')
    expect(g.nodes.map((n) => n.id)).toEqual(['requirement', 'architecture'])
  })

  it('custom：最小可编辑草稿', () => {
    const g = buildGraphFromTemplate('custom')
    expect(g.entryPoint).toBe('develop')
    expect(g.nodes).toHaveLength(1)
  })
})

describe('任务状态机（Phase I 8 状态）', () => {
  it('仅 proposing/drafting 可启动', () => {
    const startable = (s: TaskDraft['status']): boolean => STARTABLE_STATUSES.has(s)
    expect(startable('proposing')).toBe(true)
    expect(startable('drafting')).toBe(true)
    expect(startable('running')).toBe(false)
    expect(startable('awaiting_user')).toBe(false)
    expect(startable('paused')).toBe(false)
    expect(startable('stopped')).toBe(false)
    expect(startable('completed')).toBe(false)
    expect(startable('failed')).toBe(false)
    expect(startable('aborted')).toBe(false)
  })

  it('drafting → running（写 startedAt）→ failed 后会话可再提议', () => {
    createTask(makeTask())
    updateTask('task-1', { status: 'drafting' })
    updateTask('task-1', { status: 'running', startedAt: 123 })
    expect(getTask('task-1')?.startedAt).toBe(123)
    updateTask('task-1', { status: 'failed', error: 'boom' })
    expect(getTask('task-1')?.error).toBe('boom')
    expect(canProposeTask('sess-1').ok).toBe(true)
    deleteTask('task-1')
  })
})
