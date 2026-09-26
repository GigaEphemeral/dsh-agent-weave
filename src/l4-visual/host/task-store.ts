/**
 * 任务草稿存储 + 单图模式会话守卫（MVP-5 Phase I）。
 *
 * 状态机（8 种，决策 #2）：
 *   idle → proposing → drafting → running ⇄ awaiting_user → completed
 *                                 ↓                       ↓
 *                               paused                  failed
 *                                 ↓                       ↓
 *                               stopped                 aborted
 *
 * 单图模式（决策 #9）：sessionId 同一时间只允许一个活跃任务。
 */
import { computeGraphSchemaHash } from '../../l2-engine/graph-definition.js'
import type { GraphDefinitionSpec } from '../../l2-engine/types.js'

export type TaskStatus =
  | 'proposing' | 'drafting' | 'running' | 'awaiting_user'
  | 'paused' | 'stopped' | 'completed' | 'failed' | 'aborted'

export type TaskTemplate = 'full-sdlc' | 'quick-dev' | 'research-only' | 'custom'

export interface TaskDraft {
  taskId: string
  sessionId: string
  userInput: string
  template: TaskTemplate
  graph: GraphDefinitionSpec
  status: TaskStatus
  createdAt: number
  updatedAt: number
  startedAt?: number | undefined
  graphId?: string | undefined
  /** 暂停/失败原因（graph/paused pauseReason）。 */
  pauseReason?: string | undefined
  error?: string | undefined
  outputDir?: string | undefined
  /** 启动图所需的父 Agent（weave_propose_task 调用时捕获；REST /start 复用）。 */
  parentAgent?: unknown
  /** 当前等待用户回答的子代理 childId（answer 恢复用）。 */
  currentChildId?: string | undefined
}

const tasks = new Map<string, TaskDraft>()

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed', 'aborted', 'failed', 'stopped',
])

export const STARTABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(['proposing', 'drafting'])

export function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 会话级活跃任务（单图模式：同一 session 同时最多一个活跃任务）。 */
export function getActiveTask(sessionId: string): TaskDraft | undefined {
  return [...tasks.values()].find(
    (t) => t.sessionId === sessionId && !TERMINAL_STATUSES.has(t.status),
  )
}

export function getTask(taskId: string): TaskDraft | undefined {
  return tasks.get(taskId)
}

export function listTasks(): TaskDraft[] {
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
}

export function createTask(input: Omit<TaskDraft, 'createdAt' | 'updatedAt'>): TaskDraft {
  const now = Date.now()
  const task: TaskDraft = { ...input, createdAt: now, updatedAt: now }
  tasks.set(task.taskId, task)
  return task
}

export function updateTask(taskId: string, patch: Partial<TaskDraft>): TaskDraft | undefined {
  const task = tasks.get(taskId)
  if (!task) return undefined
  const updated: TaskDraft = { ...task, ...patch, updatedAt: Date.now() }
  tasks.set(taskId, updated)
  return updated
}

export function deleteTask(taskId: string): boolean {
  return tasks.delete(taskId)
}

/** 判断会话是否允许新建任务（无活跃任务或已有任务已终结）。 */
export function canProposeTask(sessionId: string): { ok: boolean; existing?: TaskDraft } {
  const existing = getActiveTask(sessionId)
  if (existing) return { ok: false, existing }
  return { ok: true }
}

// ─── 模板草稿图 ────────────────────────────────────────────────

function makeMetadata(): GraphDefinitionSpec['metadata'] {
  const now = new Date().toISOString()
  return { source: 'yaml', createdAt: now, updatedAt: now }
}

/** 基于模板构建草稿图（full-sdlc / quick-dev / research-only / custom）。 */
export function buildGraphFromTemplate(
  template: TaskTemplate,
  opts: { graphPath?: string; outputDir?: string } = {},
): GraphDefinitionSpec {
  const base = {
    version: '1.0',
    graphVersion: '0.1.0',
    graphSchemaHash: 'draft',
    maxIterations: 25,
    checkpoint: { strategy: 'node-level' as const, storage: 'fs' as const },
    metadata: makeMetadata(),
  }

  const chain = (
    ids: string[],
    roles: Record<string, string>,
  ): { nodes: GraphDefinitionSpec['nodes']; edges: GraphDefinitionSpec['edges'] } => {
    const nodes = ids.map((id) => ({
      id,
      roleRef: roles[id] ?? id,
      nodeType: 'role' as const,
      artifactName: id + '.md',
    }))
    const edges = ids.slice(0, -1).map((from, i) => ({
      from,
      to: ids[i + 1] ?? '',
      type: 'seq' as const,
    }))
    return { nodes, edges }
  }

  let spec: Omit<GraphDefinitionSpec, 'graphSchemaHash'>
  switch (template) {
    case 'full-sdlc': {
      const { nodes, edges } = chain(
        ['requirement', 'architecture', 'design', 'develop', 'test', 'quality'],
        {
          requirement: 'R1-requirement',
          architecture: 'R2-architect',
          design: 'R4-designer',
          develop: 'R6-developer',
          test: 'R7-tester',
          quality: 'R8-quality',
        },
      )
      spec = {
        ...base,
        entryPoint: 'requirement',
        nodes,
        edges,
        constraints: {
          required_phases: ['requirement', 'architecture', 'design', 'develop', 'test', 'quality'],
          allow_silent_degrade: false,
          independent_verification: {
            test_node: 'test',
            quality_node: 'quality',
            must_be_independent_from: ['develop'],
          },
        },
      }
      break
    }
    case 'quick-dev': {
      const { nodes, edges } = chain(['develop', 'test', 'quality'], {
        develop: 'R6-developer',
        test: 'R7-tester',
        quality: 'R8-quality',
      })
      spec = {
        ...base,
        entryPoint: 'develop',
        nodes,
        edges,
        constraints: {
          required_phases: ['develop', 'test', 'quality'],
          independent_verification: {
            test_node: 'test',
            quality_node: 'quality',
            must_be_independent_from: ['develop'],
          },
        },
      }
      break
    }
    case 'research-only': {
      const { nodes, edges } = chain(['requirement', 'architecture'], {
        requirement: 'R1-requirement',
        architecture: 'R2-architect',
      })
      spec = { ...base, entryPoint: 'requirement', nodes, edges }
      break
    }
    case 'custom': {
      const { nodes, edges } = chain(['develop'], { develop: 'R6-developer' })
      spec = { ...base, entryPoint: 'develop', nodes, edges }
      void opts // graphPath 由调用方覆盖；此处保持最小可编辑草稿
      break
    }
    default: {
      const { nodes, edges } = chain(['requirement', 'architecture', 'design', 'develop', 'test', 'quality'], {
        requirement: 'R1-requirement',
        architecture: 'R2-architect',
        design: 'R4-designer',
        develop: 'R6-developer',
        test: 'R7-tester',
        quality: 'R8-quality',
      })
      spec = { ...base, entryPoint: 'requirement', nodes, edges }
    }
  }

  const graph = { ...spec, graphSchemaHash: computeGraphSchemaHash(spec) }
  return graph
}
