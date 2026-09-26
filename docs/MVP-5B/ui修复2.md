# Weave 编排 UI 改造 · 完整方案

> 版本：v2 · 整合「index2.html 对齐」+「节点级覆盖」
> 基准：`index2.html`（交互原型）→ `src/client/**`（实际 TSX 代码）

---

## 一、目标与范围

| 项 | 说明 |
|---|---|
| **参考** | `index2.html` —— 拖动/连边全部跑通的交互原型 |
| **改造对象** | 实际插件代码 `src/client/**` 下的 TSX |
| **不做** | 把 HTML 抄进去；而是把原型验证过的交互在 TSX 里重建 |
| **新增** | 节点级覆盖（本项目必交文档 + 能力微调）—— 把"角色定义"和"项目实例"解耦 |

---

## 二、核心概念（先理清）

```
┌──────────────────────────────────────────────────────────────┐
│ 三层语义，从全局到具体：                                        │
│                                                                │
│   L1 角色定义（Role）      ── 全局，跨项目复用                    │
│       例：R1 = 读输入 + 产出 requirement.md                     │
│                                                                │
│   L2 节点实例（Node）      ── 本图/本项目，引用某个角色             │
│       例：本图里的 R1 节点，位置(40,30)                          │
│                                                                │
│   L3 节点覆盖（Override）  ── 本项目对角色默认的局部调整           │
│       例：本项目 R1 除 requirement.md 外，额外交验收标准           │
│                                                                │
│ 覆盖语义：三态                                                  │
│   undefined → 完全继承角色默认                                   │
│   []        → 显式清空（本项目不交任何产物）                      │
│   [...]     → 覆盖（本项目按此清单）                              │
└──────────────────────────────────────────────────────────────┘
```

**能力约束**：**只能减不能加**（不能开启角色没有的能力）—— 职责边界的红线，不能绕过 MVP-5 Phase 0 的修复。

---

## 三、统一数据模型

### 3.1 EditorNode（画布节点）

```ts
// src/client/dashboard/canvas-model.ts
export interface EditorNode {
  id: string
  roleRef: string                 // 引用的角色 ID
  roleName: string                // 冗余显示（避免每帧查表）
  x: number
  y: number

  // ★ L3：本项目覆盖（三态语义）
  override?: {
    produces?: Array<{ kind: ProducedKind; name: string; contract?: string }>
    consumes?: Array<{ kind: string; name: string; from?: string }>
    capabilities?: string[]       // 只能减不能加
    tools?: string[]              // 只能减不能加
    modelOverride?: string
    inputGate?: string[]
    approval?: boolean
    promptTemplate?: string
  }

  // 运行时（引擎回填，前端只读）
  status?: 'idle' | 'waiting' | 'running' | 'completed' | 'failed'
  activity?: { text: string; icon: string }
  metrics?: { startedAt?: number; endedAt?: number; tokensIn?: number; tokensOut?: number }
  artifacts?: Array<{ name: string; size: number; generated: boolean }>

  // 兜底（不推荐，兼容旧数据）
  artifactName?: string
  onlyMarkdown?: boolean
}

export type ProducedKind = 'doc' | 'code' | 'test' | 'script' | 'config' | 'data'
```

### 3.2 EditorEdge（画布边）

```ts
export interface EditorEdge {
  id: string
  from: string
  to: string
  type: 'seq' | 'cond' | 'loop'
  when?: string       // cond 边的条件表达式
  maxIter?: number    // loop 边的最大回退次数
}
```

### 3.3 合并函数（运行时核心）

```ts
/** 节点 + 角色 → 有效配置（引擎跑的时候用这个） */
export function effectiveRole(role: RoleDefinition, node: EditorNode): RoleDefinition {
  const ov = node.override
  if (!ov) return role
  return {
    ...role,
    // ★ 能力只能减不能加
    capabilities: intersect(role.capabilities, ov.capabilities ?? role.capabilities),
    tools: intersect(role.tools, ov.tools ?? role.tools),
    input: {
      requires: role.input.requires,
      consumes: ov.consumes ?? role.input.consumes,
    },
    output: {
      ...role.output,
      produces: ov.produces ?? role.output.produces,
    },
  }
}

/** 交集：只保留角色本来就有、且本节点允许的 */
function intersect(roleCaps: string[], nodeCaps: string[]): string[] {
  return nodeCaps.filter(c => roleCaps.includes(c))
}
```

### 3.4 Role schema 扩展（YAML）

```yaml
id: R1-requirement
# ... 原有字段
input:
  requires: []                      # 上游节点 ID 依赖
  consumes:                         # 消费的上游产物（新增）
    - kind: doc
      name: requirement.md
      from: R0-input
output:
  produces:                         # 产出清单（新增）
    - kind: doc
      name: requirement.md
      contract: |
        必须包含 In/Out、验收标准、风险
  constraints:
    onlyMarkdown: true
    forbidExtensions: [.py, .js]
suggests_next:                      # 推荐下一步（新增）
  - roleRef: R2-architect
    label: 架构设计
    reason: 需求明确后进入架构
```

**后端 Zod schema**（`role-schema.ts`）同步扩展三处：
```ts
input: z.object({
  requires: z.array(z.string()).default([]),
  consumes: z.array(ConsumeSchema).default([]),  // ★ 新增
}).optional(),
output: z.object({
  produces: z.array(ProduceSchema).default([]),  // ★ 新增
  onlyMarkdown: z.boolean().optional(),
  forbidExtensions: z.array(z.string()).optional(),
  requiredSections: z.array(z.string()).optional(),
}).optional(),
suggests_next: z.array(SuggestNextSchema).default([]),  // ★ 新增
```

---

## 四、逐文件改造清单

### P0 · 阻塞 Bug（0.5d）

| 文件 | 问题 | 修复 |
|---|---|---|
| `canvas-model.ts` | `layoutNodes` 每次重排，拖动立刻被覆盖 | 无连线时**不重排**；`buildGraphSpec` 支持 cond/loop |
| `CanvasEditor.tsx` | `selectNode` 隐式连边；`draggable` 与 drop 冲突；useEffect 语法错误 | 删隐式连边；节点拖动改 `mousedown+mousemove`；修语法错误 |
| `board-styles.ts` | checkbox 被 `.field input` 撑成整行 | 加 `.field input[type="checkbox"]` 重置；`.role-list` 改 `flex:1; min-height:0` |

**P0 关键代码**：

```ts
// canvas-model.ts
export function layoutNodes(nodes: EditorNode[], edges: EditorEdge[]): EditorNode[] {
  if (edges.length === 0) return nodes.map(n => ({ ...n }))
  const seqEdges = edges.filter(e => e.type === 'seq')
  if (seqEdges.length === 0) return nodes.map(n => ({ ...n }))
  // ... 只走 seq 分层
}
```

```css
/* board-styles.ts */
.weave-modal .field input[type="checkbox"],
.weave-modal .checkbox input[type="checkbox"] {
  width: auto !important; padding: 0 !important;
  border: none !important; background: none !important;
  accent-color: var(--w-brand); cursor: pointer; flex: 0 0 auto;
}
```

---

### P1 · 角色 I/O 模型 + 节点覆盖（2d）

**（对应需求 1、4、6）**

| 文件 | 改动 |
|---|---|
| `shared/types.ts` | `RoleDefinition.input.consumes` / `output.produces` / `suggests_next` |
| `l3-roles/role-schema.ts` | Zod schema 扩展 |
| `l4-visual/host/role-library.ts` | `toRoleEntry` 透传新字段；`saveRoleDefinition` 写 YAML |
| `dashboard/RoleEditor.tsx` | 加 3 段 UI（产出/消费/推荐） |
| `dashboard/RoleLibraryPanel.tsx` | 卡片显示 provider + I/O 摘要 |
| `dashboard/NodeEditorModal.tsx` | ★ 加「必交文档」「能力微调」两段（节点级覆盖） |
| **新建** `dashboard/shared/IOEditor.tsx` | 通用 I/O 编辑组件（角色/节点复用） |
| `board-styles.ts` | `.io-row` / `.inherit-toggle` / `.override-badge` |

#### P1.1 复用组件 `IOEditor`

```tsx
// 角色编辑器用（无继承概念，直接编辑）
<IOEditor
  value={role.output.produces}
  onChange={produces => set({ produces })}
  showInheritOption={false}
/>

// 节点编辑器用（三态：继承/覆盖）
<NodeIOEditor
  roleDefault={role.output.produces}      // 显示角色默认
  value={node.override?.produces}         // undefined = 继承
  onChange={produces => setOverride({ produces })}
  showInheritOption={true}
/>
```

#### P1.2 节点编辑器 UI 结构

```
┌─ 节点配置 · 需求分析师 ──────────────────────────┐
│ [基本信息] 节点 ID / 角色 / 模型覆盖              │
│ [输入门禁] 上游依赖                               │
│                                                   │
│ [必交文档]  ← ★ 新增（覆盖角色默认）              │
│   ○ 完全继承角色（默认）                          │
│   ● 覆盖（本项目必须多交 1 份）                   │
│     📄 requirement.md                            │
│     📄 acceptance-criteria.md  ← 项目额外要求     │
│     [+ 添加产出]                                 │
│                                                   │
│ [能力微调]  ← ★ 新增                              │
│   ☑ 读取   ☑ 分析   ☑ 写文档                     │
│   ⊘ 写代码  ← 角色无此能力，灰显                  │
│                                                   │
│ [工具白名单]（同上逻辑）                          │
│ [输出约束] ☑ 仅 .md  ☐ 需用户审批                │
│                                                   │
│              [删除节点] [取消] [保存]             │
└───────────────────────────────────────────────────┘
```

#### P1.3 节点卡片徽章

```tsx
const hasOverride = node.override && Object.keys(node.override).length > 0
<div className={`node ${hasOverride ? 'has-override' : ''}`}>
  ...
  {hasOverride && (
    <span className="override-badge" title={diffText(node)}>⚡</span>
  )}
</div>
```

Hover tooltip：
```
本节点覆盖：
  · 产出 +1（acceptance-criteria.md）
  · 能力 -1（禁用"分析"）
```

---

### P2 · 端口拖出连边（1d）

**（对应需求 3）**

| 文件 | 改动 |
|---|---|
| `CanvasEditor.tsx` | 端口 `mousedown` → linking 模式；`mousemove` 画临时线；`mouseup` 判定落点 |
| `BoardOverlays.tsx` | 渲染 `EdgeTypePicker` |
| **新建** `dashboard/EdgeTypePicker.tsx` | seq / cond / loop 选择器 |
| `board-styles.ts` | `.node-port` / `.link-preview` / `.link-target-hover` |

**交互时序**：

```
悬停节点 → 右侧 ● 端口
  ↓ mousedown
linking 模式，临时线跟随鼠标
  ↓ mousemove
检测鼠标下节点 → 高亮
  ↓ mouseup
弹 EdgeTypePicker → 选 seq/cond/loop
  ↓
dispatch weave:edge-created → CanvasEditor 添加 Edge
```

**关键代码**：

```tsx
const onPortDown = (nodeId: string, e: React.MouseEvent) => {
  e.stopPropagation(); e.preventDefault()
  setLinking({ fromId: nodeId, mx: e.clientX, my: e.clientY })
  document.addEventListener('mousemove', onLinkMove)
  document.addEventListener('mouseup', onLinkUp)
}

const onLinkUp = (e: MouseEvent) => {
  document.removeEventListener('mousemove', onLinkMove)
  document.removeEventListener('mouseup', onLinkUp)
  const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node-id]')
  const toId = targetEl?.getAttribute('data-node-id')
  if (toId && toId !== linking?.fromId) {
    window.dispatchEvent(new CustomEvent('weave:open-edge-picker', {
      detail: { fromId: linking.fromId, toId },
    }))
  }
  setLinking(null)
}
```

---

### P3 · 拖拽优化（0.5d）

**（对应需求 2）**

| 文件 | 改动 |
|---|---|
| `RoleLibraryPanel.tsx` | dragStart payload 带 `produces/consumes/suggests_next` |
| `CanvasEditor.tsx` | onDrop 网格吸附 + 落点指示 + dragend 清理 |
| `board-styles.ts` | `.drop-indicator` |

**关键代码**：

```tsx
// RoleLibraryPanel
const payload: DraggableRole = {
  id: r.id, name: r.name,
  suggests_next: r.suggests_next,
  produces: r.output?.produces,
  consumes: r.input?.consumes,
}
e.dataTransfer.setData('application/weave-role', JSON.stringify(payload))

// CanvasEditor
const onDrop = (e: React.DragEvent) => {
  e.preventDefault()
  if (readonly) return
  const raw = e.dataTransfer.getData('application/weave-role')
  if (!raw) return
  const role = JSON.parse(raw)
  const rect = innerRef.current!.getBoundingClientRect()
  const x = snap(e.clientX - rect.left - NODE_W / 2)
  const y = snap(e.clientY - rect.top - NODE_H / 2)
  const node: EditorNode = {
    id: `${role.id}-${nextId()}`,
    roleRef: role.id, roleName: role.name,
    x, y,
    consumes: role.consumes,
    produces: role.produces,
    status: 'idle',
  }
  setNodes(prev => [...prev, node])
  clearDropIndicator()
}

const snap = (v: number) => Math.round(v / 20) * 20  // 20px 网格
```

---

### P4 · 状态展示（1d）

**（对应需求 5）**

| 文件 | 改动 |
|---|---|
| `canvas-model.ts` | `EditorNode.status/activity/metrics` |
| `CanvasEditor.tsx` | 节点 class 加 status；渲染头顶气泡 |
| `panes/RuntimePane.tsx` | 加「节点实时活动」卡片 |
| `board-styles.ts` | 气泡、进度条、状态色 |

**三层展示**：

```
L1 节点态     → class="node status-running"（边框/背景/进度条动画）
L2 头顶气泡   → <Bubble>{activity.text}</Bubble>（useActivityFeed）
L3 活动流     → ActivityStream（历史 + 实时）
```

**活动事件分类**（后端 `TrajectoryEvent.data.kind`）：

| kind | icon | 触发 |
|---|---|---|
| `reading` | 📖 | 读上游产物 |
| `thinking` | 💭 | 分析/思考 |
| `tool-call` | 🔧 | 工具调用 |
| `tool-result` | ✓ | 工具返回 |
| `writing` | 📝 | 写产物 |
| `done` | ✅ | 完成 |

---

### P5 · 活动流增强 + 持久化（1d）

| 文件 | 改动 |
|---|---|
| `ActivityStream.tsx` | 事件分类增强 + 暂停/清空按钮 |
| `hooks/useActivityFeed.ts` | 历史 + 实时合并去重 |
| `state/board-state.ts` | 浮层状态上提（`editingRoleId`/`editingNodeId`/`linkingFromId`） |
| `dashboard/CanvasPane.tsx` | 监听 `weave:save-graph` / `weave:edge-created` |
| **新建** `dashboard/Persistence.ts` | localStorage 读写（roles + graph） |

---


## 五、后端契约变化

| API | 变化 |
|---|---|
| `POST /api/weave/roles` | body 新增 `produces[]` / `consumes[]` / `suggestsNext[]` |
| `GET /api/weave/roles` | 响应新增 `output.produces` / `input.consumes` / `suggests_next` |
| `GET /api/weave/graph/:id/stream` | `node-activity` 的 `data.kind` 支持 `reading`/`writing`/`thinking` |
| `POST /api/weave/graphs` | 图 DSL `edges[].type` 支持 `cond`/`loop` + `when`/`maxIter`；`nodes[].override` |

**运行时校验扩展**（`state-graph.ts`）：

```ts
// 节点启动前
const eff = effectiveRole(role, node)
for (const dep of eff.input.requires ?? []) {
  if (!completedNodes.has(dep)) throw new Error(`节点 ${node.id} 依赖 ${dep} 未完成`)
}

// 节点完成后
for (const p of eff.output.produces ?? []) {
  if (!existsSync(join(nodeDir, p.name))) {
    throw new Error(`节点 ${node.id} 未产出 ${p.name}（本项目要求）`)
  }
}
```

---

## 六、实施顺序与工时

| 阶段 | 内容 | 工时 | 依赖 |
|---|---|---|---|
| **P0** | 阻塞 bug（layout/隐式连边/checkbox/语法） | 0.5d | — |
| **P1** | 角色 I/O + 节点覆盖 | 2d | P0 |
| **P2** | 端口拖出连边 | 1d | P0 |
| **P3** | 拖拽优化 | 0.5d | P0 |
| **P4** | 状态展示 | 1d | P1（要 I/O 数据） |
| **P5** | 活动流 + 持久化 | 1d | P4 |

**并行建议**：P2/P3 可以并行 P1（都改 CanvasEditor 但修改区域不冲突）；P4 依赖 P1 完成。

---

## 七、验收清单

| # | 场景 | 期望 | 关联需求 |
|---|---|---|---|
| 1 | 点【+ 新建角色】 | 完整编辑器（含产出/消费/推荐三段） | 1 |
| 2 | 保存新角色 | 角色库刷新；拖拽 payload 带 I/O | 1 |
| 3 | 拖角色卡到画布 | 落点虚线框指示；松手网格吸附 | 2 |
| 4 | 拖动已有节点 | 位置跟随；**不被 layout 重排** | 2 |
| 5 | 悬停节点右侧 | `+` 端口出现 | 3 |
| 6 | 从端口拖出到目标 | 临时线跟随；目标高亮；松手弹类型选择 | 3 |
| 7 | 选 loop 类型 | 边显示橙色弧线 + `loop ×3` 标签 | 3 |
| 8 | 角色卡片 hover | 显示输入/输出摘要 | 4 |
| 9 | **节点编辑器加「必交文档」** | 三态切换（继承/覆盖）；额外产物保存生效 | **6** |
| 10 | **节点编辑器禁开角色没有的能力** | 灰显不可点 + tooltip 提示 | **6** |
| 11 | 点【开始工作】 | 节点变琥珀色；头顶气泡显示当前活动 | 5 |
| 12 | 运行中活动流 | 📖💭🔧📝 分类实时滚动 | 5 |
| 13 | 上游节点未完成 | 下游节点显示"等待依赖" | 4 |
| 14 | 节点有 override | 卡片显示 ⚡ 徽章；hover 显示差异 | 6 |
| 15 | 刷新页面 | 角色/图从 localStorage 恢复 | P5 |

---

## 八、一句话

**index2.html 是交互基准，实际 TSX 代码是改造对象**。

- **P0** 修 3 个阻塞 bug（layout 覆盖 / 隐式连边 / checkbox 样式）
- **P1** 角色 I/O + **节点级覆盖**（三态语义：undefined 继承 / [] 清空 / [...] 覆盖；能力只能减不能加）
- **P2-P5** 按需求逐项落地（拖拽 / 连边 / 状态展示 / 活动流 ）

**核心设计**：**角色定义 ≠ 节点实例**。角色提供全局默认，节点可以有本项目覆盖。运行时通过 `effectiveRole(role, node)` 合并后校验。**总工时 ~6.5d**，改完后 `index2.html` 的交互在插件里全部可用，且支持**项目级定制**。