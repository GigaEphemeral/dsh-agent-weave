/**
 * 任务树持久化（MVP-3 P3.C.1）。
 *
 * 任务树：根任务（用户需求）→ 子任务（Agent 拆解）→ 孙任务。
 * 支持增删节点、查询子树、落盘/恢复（JSON）。
 */
export interface TaskNode {
  /** 任务 ID（根 = 'root'；子 = '<parentId>.<n>'）。 */
  id: string
  /** 关联角色（执行者 provider 名）。 */
  roleId: string
  /** 一句话描述。 */
  summary: string
  /** 状态：pending / running / completed / failed / paused。 */
  status: TaskStatus
  /** 产出物引用（art:// 或路径）。 */
  artifacts: string[]
  /** 父任务 ID。 */
  parentId: string | null
  createdAt: number
  updatedAt: number
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused'

export interface TaskTree {
  /** 创建根任务。 */
  createRoot(summary: string, roleId?: string): TaskNode
  /** 添加子任务。 */
  addChild(parentId: string, input: { summary: string; roleId?: string }): TaskNode | null
  /** 更新任务状态。 */
  setStatus(id: string, status: TaskStatus): void
  /** 追加产物引用。 */
  addArtifact(id: string, ref: string): void
  /** 查询任务。 */
  get(id: string): TaskNode | undefined
  /** 查询子树（含自身）。 */
  subtree(id: string): TaskNode[]
  /** 未完成任务列表（pending/running）。 */
  pending(): TaskNode[]
  /** 序列化（无 root 时返回 null 标记）。 */
  toJSON(): { root: TaskNode | null; children: Record<string, TaskNode[]> }
}

/** 创建任务树。 */
export function createTaskTree(initial?: unknown): TaskTree {
  const nodes = new Map<string, TaskNode>()
  const childrenMap = new Map<string, string[]>()

  const ensureNode = (id: string): TaskNode | undefined => nodes.get(id)

  const toJSON = () => {
    const root = nodes.get('root')
    if (!root) return { root: null, children: {} }
    const children: Record<string, TaskNode[]> = {}
    for (const [parentId, ids] of childrenMap) {
      children[parentId] = ids.map((id) => nodes.get(id)).filter(Boolean) as TaskNode[]
    }
    return { root, children }
  }

  const tree: TaskTree = {
    createRoot(summary, roleId = '') {
      const now = Date.now()
      const root: TaskNode = {
        id: 'root', roleId, summary, status: 'pending',
        artifacts: [], parentId: null, createdAt: now, updatedAt: now,
      }
      nodes.set('root', root)
      childrenMap.set('root', [])
      return root
    },
    addChild(parentId, input) {
      if (!ensureNode(parentId)) return null
      const siblings = childrenMap.get(parentId) ?? []
      const id = `${parentId}.${siblings.length}`
      const now = Date.now()
      const node: TaskNode = {
        id, roleId: input.roleId ?? '', summary: input.summary, status: 'pending',
        artifacts: [], parentId, createdAt: now, updatedAt: now,
      }
      nodes.set(id, node)
      siblings.push(id)
      childrenMap.set(parentId, siblings)
      return node
    },
    setStatus(id, status) {
      const n = nodes.get(id)
      if (n) {
        n.status = status
        n.updatedAt = Date.now()
      }
    },
    addArtifact(id, ref) {
      const n = nodes.get(id)
      if (n && !n.artifacts.includes(ref)) {
        n.artifacts.push(ref)
        n.updatedAt = Date.now()
      }
    },
    get: (id) => nodes.get(id),
    subtree(id) {
      const out: TaskNode[] = []
      const stack = [id]
      while (stack.length) {
        const cur = stack.pop()
        if (!cur) continue
        const n = nodes.get(cur)
        if (n) out.push(n)
        for (const c of childrenMap.get(cur) ?? []) stack.push(c)
      }
      return out
    },
    pending() {
      return [...nodes.values()].filter((n) => n.status === 'pending' || n.status === 'running')
    },
    toJSON,
  }

  // 恢复
  if (initial && typeof initial === 'object') {
    const data = initial as { root?: TaskNode; children?: Record<string, TaskNode[]> }
    if (data.root) {
      nodes.set(data.root.id, data.root)
      childrenMap.set(data.root.id, [])
      for (const [pid, list] of Object.entries(data.children ?? {})) {
        for (const n of list) {
          nodes.set(n.id, n)
          const sib = childrenMap.get(pid) ?? []
          sib.push(n.id)
          childrenMap.set(pid, sib)
        }
      }
    }
  }

  return tree
}
