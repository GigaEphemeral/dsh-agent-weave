# MVP-5 完整规划（合并版 v5）

> 版本：v5（2026-09-25）
> 前置：MVP-4 完成
> 定位：从"内置图 + 只读看板"升级为"用户可编辑图 + 引导式编排 + 完整生命周期 + 严格角色边界"
> 合并说明：v1（主体规划）+ v2（入口设计），按用户决策统一冲突点

---

## 〇、决策记录

| # | 冲突 | 决策 |
|---|---|---|
| 1 | `weave_run_graph` 调用方 | **面板调用**（主 agent 不直接调） |
| 2 | 任务状态机 vs 图状态机 | **任务状态机**（8 种），图状态映射到任务状态 |
| 3 | 用户确认两套机制 | **都保留**：`humanApproval`（审批门禁）+ `UserQuestionModal`（提问弹窗） |
| 4 | 面板布局 | **右侧滑出**（主 agent 仍可见） |
| 5 | 工作区扫描 | **移除**，改为 **skill 层约束 + 工具白名单** |
| 6 | `weave_propose_task` | **融合进主流程** |
| 7 | `graph/paused` 和 `graph/awaiting-user` | **融合**：统一为 `graph/paused`，用 `pauseReason` 区分 |
| 8 | 预研依赖 | **标注**到每个任务 |
| 9 | 会话 vs 图关系 | **单图模式**（sessionId 一对一 graphId） |

---

## 一、MVP-5 目标

### 1.1 一句话

**用户说"用 weave 创建 XXX" → 主 agent 弹出面板（右侧滑出，主 agent 仍可见）→ 用户在面板编辑工作流（角色/门禁/模型）→ 点击"开始工作" → 图执行 → 实时看到"谁在干什么" → 中途介入 → 完成显示产物；同时角色职责严格受控、异常可传播、项目事实可共享。**

### 1.2 十五个硬目标

| 类别 | # | 目标 | 验收标准 |
|---|---|---|---|
| **前置修复** | G0.1 | 角色职责边界 | R1 只产需求文档；越界由 skill 阻止 |
| | G0.2 | 异常退出与传播 | 环境不满足 → 图暂停 → 主 agent 停止派发 |
| | G0.3 | 交付物独立验证 | SOP 六阶段完整，R7/R8 独立于 R6 |
| | G0.4 | 项目事实共享 | R1 探测结论自动注入下游 prompt |
| | G0.5 | 无硬超时 + 用户暂停 | 引擎不做超时判断；暂停用 DSH 原生 `interrupt` |
| **入口** | G0.6 | 结构化任务入口 | `weave_propose_task` → 面板编辑 → 确认启动 |
| **主体** | G1 | 角色库（描述/排序/搜索） | 导入/新建/编辑/删除；hover 描述；搜索 |
| | G2 | 引导式画布 | 选角色 → 推荐下一步 → 生成 DSL |
| | G3 | 门禁配置 | 输入/输出/用户审批三类 |
| | G4 | 模型覆盖 | 节点级 `modelOverride` |
| | G5 | 图保存与复用 | CRUD + 模板 |
| | G6 | 动效 | 状态切换 + 边流动 + 活动滑入 |
| | G7 | "谁在干什么" | 头顶气泡显示当前活动 |
| | G8 | 结构化日志 | 分级 + 落盘 + 可查询 |
| | G9 | Token 分账 | 总 + 每节点 + 每角色 |
| | G10 | 节点跳转 subagent | 双击节点打开 DSH 原生视图 |

### 1.3 明确不做（MVP-6）

- 社区 Gallery / 市场同步
- 自定义节点插件注册
- 沙箱隔离
- 观察者 L3
- 对抗评审
- 自进化机制

---

## 二、任务状态机（统一）

### 2.1 任务状态机（8 种）

```
idle → proposing → drafting → running ⇄ awaiting_user → completed
                                  ↓                          ↓
                                paused                     failed
                                  ↓                          ↓
                                stopped                    aborted
```

| 状态 | 含义 | 触发 |
|---|---|---|
| `idle` | 无活跃任务 | 会话初始 / 任务完成后 |
| `proposing` | 主 agent 已提议，等待用户选择 | 主 agent 调 `weave_propose_task` |
| `drafting` | 面板已打开，用户在编辑 | 用户选择"进入面板编辑" |
| `running` | 图执行中 | 用户点【开始工作】 |
| `awaiting_user` | 图暂停等用户回答 | `ask_user_question` 或审批门禁 |
| `paused` | 用户主动暂停 | 用户点【暂停】 |
| `stopped` | 用户主动终止 | 用户点【终止】 |
| `completed` | 图正常完成 | 图返回 `success: true` |
| `failed` | 图执行失败 | 图返回 `success: false` |
| `aborted` | 用户取消草稿 | 用户在面板点【取消】 |

### 2.2 图状态与任务状态映射

| 图事件 | 任务状态变化 |
|---|---|
| `graph/start` | `running` |
| `graph/node-end` | 不变（仍在 `running`） |
| **`graph/paused` + pauseReason='user-pause'** | `paused` |
| **`graph/paused` + pauseReason='awaiting-user'** | `awaiting_user` |
| **`graph/paused` + pauseReason='approval-pending'** | `awaiting_user` |
| **`graph/paused` + pauseReason='environment-gate'** | `awaiting_user` |
| `graph/end` + success=true | `completed` |
| `graph/end` + success=false | `failed` |
| `graph/end` + stopped=true | `stopped` |

**关键**：`graph/paused` 和 `graph/awaiting-user` **融合为同一个事件类型**，用 `pauseReason` 区分：

```typescript
type PauseReason =
  | 'user-pause'              // 用户主动暂停
  | 'awaiting-user'           // 子代理 ask_user_question
  | 'approval-pending'        // humanApproval 门禁
  | 'environment-gate'        // Environment Gate 失败
  | 'idle-timeout'            // 长时间无活动
```

### 2.3 单图模式（sessionId ↔ graphId 一对一）

**关键约束**：会话里**同一时间只能有一个活跃 weave 任务**。

```typescript
// 会话级任务存储
const sessionTasks = new Map<string, Task>()
// key: sessionId, value: Task

// 主 agent 调 weave_propose_task 时检查
const existing = sessionTasks.get(exec.sessionId)
if (existing && !['completed', 'aborted', 'failed', 'stopped'].includes(existing.status)) {
  return {
    ok: false,
    message: `已有活跃任务（${existing.taskId}，状态：${existing.status}）`,
  }
}
```

---

## 三、Phase 0：前置修复（~10d）

> **所有主体功能的前置条件**。

### 3.1 问题 1：角色职责边界（~1.5d，纯 skill）

**现象**：R1（需求分析师）写了 56 个文件、18.2M token 的完整项目，抢了 R6 的活。

**修复原则**：**移除工作区扫描**（共享工作区无法归因）。**通过 SKILL.md 约束 + 工具白名单**。

#### 3.1.1 SKILL.md 五段结构（强制）

**每个角色的 SKILL.md 必须包含以下五段**：

```markdown
# R1-requirement（需求分析师）

## 一、职责（You ARE）

- 分析用户需求，产出需求文档
- 明确 In/Out 边界、验收标准、风险
- **唯一的产出物**：`productions/R1-requirement/requirement.md`

## 二、非职责（You ARE NOT）

以下行为**严格禁止**，违反即视为任务失败：

- ❌ **禁止写代码**（.py / .js / .ts / .html / .css / .bat / .sh）
- ❌ **禁止创建项目目录**（backend/ / frontend/ / tests/ / src/）
- ❌ **禁止安装依赖**（pip install / npm install）
- ❌ **禁止 spawn 子代理**
- ❌ **禁止"换方案绕过"**（如环境缺失时改用其他路径）

**为什么**：你的产出会被下游 R2/R4/R6 消费。你写代码 = 抢了下游的活 + SOP 失效。

## 三、允许的工具

| 工具 | 用途 | 说明 |
|---|---|---|
| read | 读参考文档、上游产物 | 仅工作区内 |
| glob | 搜索文件 | 仅工作区内 |
| grep | 搜索内容 | 仅工作区内 |
| write | 写 requirement.md | 只用于产出文档 |

## 四、环境异常处理

遇到以下情况，**必须停止并退出**，不得降级尝试：

| 情况 | 处理 |
|---|---|
| 参考文档不存在 | 退出，报告"缺少输入" |
| 工作区不可写 | 退出，报告"环境不可用" |
| 读文件权限被拒 | 退出，报告"权限不足" |

**禁止的行为**：
- ❌ 写临时脚本"绕过"环境问题
- ❌ 换一种探测方式继续
- ❌ 自行假设环境不可用并降级

## 五、输出契约

你的 `requirement.md` **必须包含以下章节**：

```markdown
# 需求文档

## 目标
（明确要做什么）

## In/Out
（范围内 / 范围外）

## 验收标准
（可量化、可测试）

## 风险与假设
（已知风险 + 未验证假设）
```
```

#### 3.1.2 六个角色的"非职责"清单

| 角色 | 严格禁止 |
|---|---|
| **R1 需求** | 写代码、装依赖、建项目目录、spawn |
| **R2 架构** | 写代码、装依赖、建项目目录、spawn |
| **R4 设计** | 写代码、装依赖、建项目目录、spawn |
| **R6 开发** | spawn 子代理；跳步到测试/评审 |
| **R7 测试** | 修改被测代码；跳过测试用例；spawn |
| **R8 质量** | 修改代码；跳过评审；spawn |

#### 3.1.3 工具白名单（角色 YAML）

```yaml
# R1/R2/R4/R8：设计评审类，不给 pwsh
tools:
  - read
  - glob
  - grep
  - write

# R6：开发类，给全工具
tools:
  - read
  - glob
  - grep
  - write
  - edit
  - pwsh
  - ask_user_question

# R7：测试类，给 pwsh（跑测试）
tools:
  - read
  - glob
  - grep
  - write
  - pwsh
```

**关键**：**R1/R2/R4/R8 不给 `pwsh`**——从工具层防绕过。

### 3.2 问题 2：异常退出与传播（~2d）

**现象**：R1 遇到 `pip install` 失败不停手，主 agent 也不感知。

#### 3.2.1 Environment Gate

```yaml
# 角色 YAML
environment:
  preflight:
    - cmd: "python --version"
      expect_contains: "Python 3"
      required: true
    - cmd: "pip list | findstr fastapi"
      expect_contains: "fastapi"
      required: false   # 缺失则报告，不静默降级
```

```typescript
// 引擎执行
const envCheck = await checkEnvironment(ctx, role)
if (!envCheck.passed) {
  emit({
    type: 'graph/paused',
    graphId,
    node: current,
    timestamp: Date.now(),
    data: {
      pauseReason: 'environment-gate',
      missing: envCheck.missing,
      resumeFrom: current,
    },
  })
  return { graphId, success: true, data: { paused: true, pauseReason: 'environment-gate' } }
}
```

#### 3.2.2 Failure Propagation

**图返回值**：

```typescript
{
  graphId: string,
  success: boolean,
  status: 'completed' | 'paused' | 'failed' | 'stopped',
  pauseReason?: PauseReason,
  errorType?: string,
  error?: string,
  errorNode?: string,
}
```

**主 agent 契约（`weave_graph_help` 加章节）**：

```markdown
## 图执行结果处理契约

| status | 主 agent 应做 |
|---|---|
| completed | 继续下一任务 |
| running（异步） | 不要重复调用 |
| paused | 停止派发，报告用户暂停原因 |
| failed | 停止所有派发，报告详情 |
| stopped | 停止派发 |

**强制规则**：
1. 收到 failed/paused → 禁止继续派发
2. 禁止"重试"失败任务
3. 禁止"忽略"错误继续
4. 必须向用户报告：状态、原因、出错节点
```

### 3.3 问题 3：交付物独立验证（~2.1d）

**现象**：R1 自己写代码、自己写测试、自称"全绿"，SOP 六阶段断裂。

#### 3.3.1 SOP 强制顺序

```yaml
# 图 DSL 加
graphConstraints:
  required_phases: [requirement, architecture, design, develop, test, quality]
  allow_silent_degrade: false
  independent_verification:
    test_node: test
    quality_node: quality
    must_be_independent_from: [develop]
```

#### 3.3.2 降级检测

```typescript
if (detectedDegrade(node, context)) {
  emit({
    type: 'graph/paused',
    graphId, node: current, timestamp: Date.now(),
    data: {
      pauseReason: 'awaiting-user',
      reason: `节点 ${node} 检测到降级尝试`,
      original: 'FastAPI',
      fallback: 'stdlib http.server',
      resumeFrom: current,
    },
  })
}
```

#### 3.3.3 独立验证约束

```typescript
// 引擎检查：test/quality 节点的 childId 必须不同于 develop
if (node.id === 'test' || node.id === 'quality') {
  const developChildId = childIdByNode.get('develop')
  if (developChildId === currentChildId) {
    throw new Error(`${node.id} 节点必须独立于 develop 节点`)
  }
}
```

### 3.4 问题 4：项目事实共享（~2.1d）

**现象**：R1/R2/R4/R6 各探测一遍 Python 版本、API 连通性。

#### 3.4.1 数据结构

```typescript
// src/l2-engine/project-memory.ts
export interface Fact {
  key: string                    // "api.tencent.qt.status"
  category: 'environment' | 'api' | 'decision' | 'discovery' | 'constraint'
  value: unknown
  sourceNode: string
  confidence: 'confirmed' | 'assumed' | 'user-provided'
  summary: string
  at: number
}
```

#### 3.4.2 节点产出规范（SKILL.md 加）

```markdown
## 输出规范

你的产出文件必须以 YAML front-matter 开头：

```yaml
---
facts:
  - key: api.tencent.qt.status
    category: api
    value: available
    confidence: confirmed
    summary: "腾讯行情 API 可访问，GBK 编码"
  - key: env.python.version
    category: environment
    value: "3.14.6"
    confidence: confirmed
    summary: "Python 3.14.6 已安装"
---

# 正文
```
```

#### 3.4.3 引擎集成

```typescript
// 节点完成后
if (projectMemory) {
  const extracted = extractFacts(text)
  projectMemory.recordFactsFromNode(extracted.facts, name)
}

// 构造 prompt 时注入
const factsSection = buildFactsSection(projectMemory)
const prompt = `
...
项目事实（上游已确认，**请不要重复探测**）：
${factsSection}

【行为约束】
- 不要重复探测已确认的事实
- 需要新事实时才调用工具探测
`
```

### 3.5 超时重设计（~1.5d）

**原则**：无硬超时。只等 `end` / `error` / `abort` 三种信号。

```typescript
// src/l2-engine/subagent-waiter.ts
export function waitForSubagentEnd(
  ctx: Context,
  childId: string,
  opts: WaitOptions = {},
): Promise<SubagentEndPayload> {
  return new Promise((resolve, reject) => {
    let lastActivityAt = Date.now()

    // ★ 空闲只提示，不中止
    idleCheckTimer = setInterval(() => {
      const idleMs = Date.now() - lastActivityAt
      if (idleMs >= opts.idleWarningMs) {   // 默认 10 分钟
        opts.onIdleWarning?.(idleMs)         // emit graph/node-idle-warning
      }
    }, 30_000)

    // ★ 三种退出路径
    subscribeSubagentEvents(ctx, childId, {
      onActivity: (a) => { lastActivityAt = Date.now(); opts.onActivity?.(a) },
      onEnd: (p) => { cleanup(); resolve(p) },
      onError: (e) => { cleanup(); reject(e) },
    })

    // ★ 用户暂停：调 DSH 原生 interrupt
    opts.signal?.addEventListener('abort', async () => {
      await interruptSubagent(ctx, childId, { kind: 'ancestor', agent: opts.parentAgent })
      cleanup()
      reject(new PauseError(childId))
    }, { once: true })
  })
}
```

**默认参数**（已决策）：

| 参数 | 默认值 |
|---|---|
| 空闲提示阈值 | 10 分钟 |
| 空闲提示动作 | 前端显示 + Notification |
| 循环检测 | 默认开启（10 次窗口 / 5 次重复） |
| Token 速率检测 | 默认关闭 |
| 用户暂停 | abort 子代理 |

### 3.6 权限与暂停（~1d）

**子代理权限两层模型**：

| 层 | 控制者 | 说明 |
|---|---|---|
| Sandbox Policy | session 级 | 父代理决定天花板 |
| ToolFilter | 角色 YAML | 白名单，实际可用工具 |

**暂停用 DSH 原生 `interrupt`**：

```typescript
await ctx.subagents.interrupt(childId, {
  kind: 'ancestor',
  agent: parentAgent,
})
```

**环境缺失处理策略（SKILL.md 加）**：

```markdown
## 环境缺失处理策略

1. **优先自动安装**：`pip install --user` / `npm install --prefix .`
2. **失败 → 询问用户**：`ask_user_question` 或 `update_goal(blocked)`
3. **禁止**：写临时脚本绕过、静默降级、自行假设环境
```

### 3.7 Phase 0 工作量

| 问题 | 工作量 |
|---|---|
| 问题 1（职责 skill 约束） | 1.5d |
| 问题 2（异常退出传播） | 2d |
| 问题 3（独立验证） | 2.1d |
| 问题 4（事实共享） | 2.1d |
| 超时重设计 | 1.5d |
| 权限与暂停 | 1d |
| **合计** | **~10.2d** |

---

## 四、Phase I：入口设计（~5.6d）

> **用户第一接触点**。排在 Phase A 之前。

### 4.1 结构化任务入口

**流程**：

```
用户："用 weave 创建 ETF 工具"
   ↓
主 agent 调 weave_propose_task（不直接跑图）
   ↓
创建草稿 + SSE 推送 task-proposed 事件
   ↓
Client 右侧滑出编辑面板（主 agent 仍可见）
   ↓
用户编辑工作流（角色/门禁/模型）
   ↓
点击【开始工作】→ 面板调 weave_run_graph
   ↓
图执行，面板实时染色
```

### 4.2 新工具 `weave_propose_task`

```typescript
weave_propose_task({
  user_input: string
  template?: 'full-sdlc' | 'quick-dev' | 'research-only' | 'custom'
  graph_path?: string
  output_dir?: string
})
```

**返回值**：

```typescript
{
  ok: true,
  taskId: string,              // "task-1700000000-abc123"
  status: 'proposing',
  panelUrl: string,            // "#weave?taskId=xxx"
  draftSummary: {
    template: string,
    nodes: Array<{ id: string, roleRef: string }>,
    edges: Array<{ from: string, to: string }>,
  },
  message: string,
}
```

**实现**：

```typescript
// src/cli/propose-commands.ts
export function registerProposeCommand(ctx: Context): () => void {
  return ctx.tools.register(defineTool({
    name: 'weave_propose_task',
    description:
      '创建 weave 任务草稿并打开编辑面板。**不直接执行**。' +
      '用于用户说"用 weave 创建 XXX"时。' +
      '用户会在面板里编辑工作流，确认后点击开始。',
    parameters: {
      user_input: { type: 'string', required: true },
      template: { type: 'string', enum: ['full-sdlc', 'quick-dev', 'research-only', 'custom'] },
      graph_path: { type: 'string' },
      output_dir: { type: 'string' },
    },
    async execute(args, exec) {
      const workspace = resolveExecWorkspace(exec)
      const taskId = generateTaskId()

      // 1. 单图模式：检查会话是否已有活跃任务
      const existing = getActiveTask(exec.sessionId)
      if (existing && !['completed', 'aborted', 'failed', 'stopped'].includes(existing.status)) {
        return {
          ok: false,
          message: `已有活跃任务（${existing.taskId}，状态：${existing.status}）。请先完成或取消。`,
        }
      }

      // 2. 基于模板生成草稿图
      const template = args.template ?? 'full-sdlc'
      const draftGraph = buildGraphFromTemplate(template, {
        workspace,
        graphPath: args.graph_path,
        outputDir: args.output_dir,
      })

      // 3. 创建任务草稿
      const task: Task = {
        taskId,
        sessionId: exec.sessionId,
        userInput: args.user_input,
        template,
        graph: draftGraph,
        status: 'proposing',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      createTask(task)

      // 4. SSE 推送"任务已提议"事件
      const bus = getGlobalBus()
      bus?.handle({
        type: 'weave/task-proposed',
        graphId: taskId,
        timestamp: Date.now(),
        data: { taskId, userInput: args.user_input, template, graph: draftGraph },
      })

      return {
        ok: true,
        taskId,
        status: 'proposing',
        panelUrl: `#weave?taskId=${taskId}`,
        draftSummary: {
          template,
          nodes: draftGraph.nodes.map((n) => ({ id: n.id, roleRef: n.roleRef })),
          edges: draftGraph.edges.map((e) => ({ from: e.from, to: e.to })),
        },
        message: '已创建任务草稿。面板已弹出，请编辑后点击"开始工作"。在你确认之前，图不会执行。',
      }
    },
  }))
}
```

### 4.3 主 agent 行为契约

**`weave_graph_help` 加章节**：

```markdown
## 任务入口契约

### 何时调 weave_propose_task

用户说"用 weave 创建 XXX"、"用 weave 编排 XXX"、"打开 weave 面板"时：
**调 `weave_propose_task`，不要直接调 `weave_run_graph`**。

### 何时调 weave_run_graph

**只在用户明确说"跳过编辑直接跑"时**，或用户已在前面几轮对话里完整给出：
- 图 YAML 的绝对路径
- 完整的需求文本
- 明确的"直接执行"

### 主 agent 报告话术

调 `weave_propose_task` 后：
```
已创建任务草稿。面板已在右侧打开。
请在面板中：
  1. 拖入/调整角色节点
  2. 配置各节点的输入输出门禁
  3. 覆盖模型（可选）
  4. 点击【开始工作】

在你确认之前，图不会执行。
```
```

### 4.4 Client 订阅事件 + 右侧滑出面板

**`src/client/index.tsx`**：

```tsx
export function apply(ctx: Context): void {
  // 订阅 task-proposed 事件
  const es = new EventSource('/api/weave/stream')
  es.onmessage = (msg) => {
    const evt = JSON.parse(msg.data)
    if (evt.event_type === 'weave-task-proposed') {
      window.dispatchEvent(new CustomEvent('weave:task-proposed', { detail: evt.data }))
      // 打开右侧面板
      try {
        const slots = (ctx as any).slots
        if (slots?.activate) slots.activate('conversation.view', 'weave-dashboard', { taskId: evt.data.taskId })
      } catch { /* 降级：D1 按钮闪烁 */ }
    }
  }
  ctx.effect(() => () => es.close())
}
```

**`WeaveEditPanel.tsx`（右侧滑出）**：

```tsx
export function WeaveEditPanel() {
  const [task, setTask] = useState<TaskDraft | null>(null)

  useEffect(() => {
    function onTaskProposed(e: Event) {
      setTask((e as CustomEvent).detail)
    }
    window.addEventListener('weave:task-proposed', onTaskProposed)
    return () => window.removeEventListener('weave:task-proposed', onTaskProposed)
  }, [])

  useEffect(() => {
    document.body.classList.toggle('weave-panel-open', !!task)
  }, [task])

  if (!task) return null

  return (
    <div className="weave-edit-panel open">
      <header>
        <h3>编辑工作流：{task.template}</h3>
        <button onClick={() => setTask(null)}>×</button>
      </header>
      <div className="weave-edit-panel__body">
        <WeaveCanvas taskId={task.taskId} initialGraph={task.graph} />
        <NodeConfigDrawer taskId={task.taskId} />
      </div>
      <footer>
        <button onClick={handleCancel}>取消</button>
        <button onClick={handleStart} className="primary">开始工作</button>
      </footer>
    </div>
  )
}
```

**样式**：

```css
.weave-edit-panel {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: 720px;
  background: var(--dsw-alias-bg-base);
  border-left: 1px solid var(--dsw-alias-border-l2);
  transform: translateX(100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  z-index: 1000;
  display: flex;
  flex-direction: column;
}

.weave-edit-panel.open {
  transform: translateX(0);
}

body.weave-panel-open main {
  margin-right: 720px;
  transition: margin-right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
```

### 4.5 任务草稿 REST API

```typescript
// GET /api/weave/tasks/:taskId —— 读草稿
// PATCH /api/weave/tasks/:taskId —— 编辑草稿
// POST /api/weave/tasks/:taskId/start —— 开始工作（面板调 weave_run_graph）
// POST /api/weave/tasks/:taskId/cancel —— 取消
// POST /api/weave/tasks/:taskId/answer —— 用户回答（图恢复）
```

**start 实现**：

```typescript
if (rest.endsWith('/start') && method === 'POST') {
  const taskId = rest.split('/')[2]
  const task = getTask(taskId)
  if (!task) { json(res, 404, { error: 'task not found' }); return }
  if (task.status !== 'drafting' && task.status !== 'proposing') {
    json(res, 409, { error: `任务状态不允许启动: ${task.status}` }); return
  }

  updateTask(taskId, { status: 'running', startedAt: Date.now() })

  // 面板调 weave_run_graph
  const result = await runGraphRealTool(ctx, task.graph, task.userInput, execAgent, task.outputDir)

  json(res, 200, { ok: true, graphId: result.graphId, status: 'running' })
}
```

### 4.6 用户确认机制（两个通道，融合）

**两个通道并存**：

| 通道 | 触发 | UI | 对应 `pauseReason` |
|---|---|---|---|
| **A. `ask_user_question`** | 子代理主动提问 | `UserQuestionModal`（弹窗） | `awaiting-user` |
| **B. `humanApproval` 门禁** | 图流经审批节点 | 面板审批列表 + 弹窗 | `approval-pending` |

**统一入口**：两者都让图进入 `graph/paused` 状态，用 `pauseReason` 区分。前端统一从 `graph/paused` 事件渲染对应 UI。

**`UserQuestionModal`**（通道 A）：

```tsx
function UserQuestionModal({ question, onAnswer }) {
  return (
    <div className="user-question-modal">
      <div className="user-question-modal__header">
        <span>节点 {question.nodeId} 需要你的确认</span>
      </div>
      <div className="user-question-modal__body">
        <p>{question.text}</p>
        {question.options && (
          <div className="options">
            {question.options.map((opt) => (
              <button key={opt.value} onClick={() => onAnswer(opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
```

**审批列表**（通道 B）复用 MVP-4 的 `ApprovalPanel`。

**回答后恢复**：

```typescript
// POST /api/weave/tasks/:taskId/answer
if (rest.endsWith('/answer') && method === 'POST') {
  const { answer } = await readBody(req)
  const task = getTask(taskId)
  await ctx.subagents.sendMessage(parent, task.currentChildId, [
    { type: 'text', text: `[用户回答] ${answer}` },
  ], {})
  updateTask(taskId, { status: 'running' })
  json(res, 200, { ok: true })
}
```

### 4.7 Phase I 工作量

| # | 任务 | 工作量 |
|---|---|---|
| 1 | `weave_propose_task` 工具 | 0.5d |
| 2 | 任务草稿存储（`task-store.ts`） | 0.5d |
| 3 | `/tasks/*` REST API | 1d |
| 4 | Client 订阅 `task-proposed` 事件 | 0.3d |
| 5 | `WeaveEditPanel`（右侧滑出） | 1d |
| 6 | 面板状态切换（editing/running/awaiting/completed） | 0.5d |
| 7 | `UserQuestionModal`（图暂停时弹） | 0.5d |
| 8 | 主 agent 行为契约 | 0.3d |
| 9 | 测试 | 1d |
| **合计** | | **~5.6d** |

---

## 五、Phase A：角色库（~4d）

### 5.1 角色 YAML 扩展

```yaml
# roles/R2-architect.yaml
id: R2-architect
name: 架构师
description: "负责技术选型、模块划分、关键接口设计。适合需求明确后进入。"
order: 20
tags: ["设计", "架构"]

suggests_next:
  - roleRef: R4-designer
    label: 详细设计
    reason: 架构确定后进入详细设计
  - roleRef: R6-developer
    label: 直接开发
    reason: 简单项目可跳过详细设计
```

### 5.2 REST API

```typescript
// GET /api/weave/roles?search=xxx&sort=order
if (rest.startsWith('/roles') && method === 'GET') {
  const search = url.searchParams.get('search') ?? ''
  const sort = url.searchParams.get('sort') ?? 'order'

  let roles = loadAllRoles(getRolesDir())
  if (search) {
    const q = search.toLowerCase()
    roles = roles.filter((r) =>
      r.id.toLowerCase().includes(q) ||
      r.name.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      r.tags.some((t) => t.toLowerCase().includes(q))
    )
  }
  roles.sort((a, b) => sort === 'order' ? a.order - b.order : a.name.localeCompare(b.name))
  json(res, 200, roles)
}
```

### 5.3 角色卡片 UI

```tsx
export function RoleListItem({ role, onDragStart, onClick }) {
  return (
    <Tooltip
      content={
        <div className="role-tooltip">
          <div className="role-tooltip__name">{role.name}</div>
          <div className="role-tooltip__id">{role.id}</div>
          {role.description && <div className="role-tooltip__desc">{role.description}</div>}
          {role.tags.length > 0 && (
            <div className="role-tooltip__tags">
              {role.tags.map((t) => <span key={t} className="role-tag">{t}</span>)}
            </div>
          )}
          <div className="role-tooltip__hint">拖拽到画布使用</div>
        </div>
      }
      delay={300}
      placement="right"
    >
      <div className="role-list-item" draggable onDragStart={onDragStart} onClick={onClick}>
        <div className="role-list-item__icon">{roleIcon(role.id)}</div>
        <div className="role-list-item__content">
          <div className="role-list-item__name">{role.name}</div>
          <div className="role-list-item__id">{role.id}</div>
        </div>
        <div className="role-list-item__drag-handle">⋮⋮</div>
      </div>
    </Tooltip>
  )
}
```

---

## 六、Phase B：图保存与复用（~2.5d）

### 6.1 存储布局

```
<用户数据根>/weave/
├── roles/                       # 全局角色库
├── graphs/                      # 保存的图
│   ├── etf-tool-dev.yaml
│   └── etf-tool-dev.meta.json
├── tasks/                       # 任务草稿
└── runs/<graphId>/              # 运行数据
```

### 6.2 REST API

```typescript
// POST /api/weave/graphs —— 保存图
if (rest === '/graphs' && method === 'POST') {
  const { id, spec, meta } = await readBody(req)

  const parsed = parseGraphDefinition(spec)
  const validation = validateGraph(parsed, { registeredRoles: new Set(ctx.subagents.list()) })
  if (!validation.valid) {
    json(res, 400, { error: 'graph invalid', details: validation.errors })
    return
  }

  const hash = computeGraphSchemaHash(parsed)
  parsed.graphSchemaHash = hash

  writeFileSync(join(graphsDir, `${id}.yaml`), yamlDump(parsed), 'utf8')
  writeFileSync(join(graphsDir, `${id}.meta.json`), JSON.stringify({
    ...meta, id, graphSchemaHash: hash, updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8')

  json(res, 200, { ok: true, id, graphSchemaHash: hash })
}
```

---

## 七、Phase C：引导式画布（~5d）

### 7.1 画布骨架

```tsx
export function WeaveCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [suggestionPanel, setSuggestionPanel] = useState<{ sourceNodeId: string; suggestions: RoleSuggestion[] } | null>(null)

  const onDrop = useCallback(async (event) => {
    const roleId = event.dataTransfer.getData('application/weave-role')
    const role = await fetchRole(roleId)
    const newNode = { id: `${roleId}-${Date.now()}`, type: 'role', position: {...}, data: { role } }
    setNodes((nds) => nds.concat(newNode))

    if (role.suggests_next?.length > 0) {
      setSuggestionPanel({ sourceNodeId: newNode.id, suggestions: role.suggests_next })
    }
  }, [])

  return (
    <div className="weave-canvas" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={{ role: RoleNode }} {...} />
      {suggestionPanel && <SuggestionPanel {...suggestionPanel} />}
    </div>
  )
}
```

### 7.2 引导推荐面板

```tsx
export function SuggestionPanel({ suggestions, onPick, onSkip }) {
  if (suggestions.length === 0) {
    return (
      <div className="suggestion-panel suggestion-panel--empty">
        <div>选择下一步角色</div>
        <div>（此角色未配置推荐）</div>
        <button onClick={onSkip}>从全部角色中选择</button>
      </div>
    )
  }
  return (
    <div className="suggestion-panel">
      <div className="suggestion-panel__title">推荐下一步（可选）</div>
      {suggestions.map((s) => (
        <button key={s.roleRef} className="suggestion-item" onClick={() => onPick(s.roleRef)}>
          <div className="suggestion-item__label">{s.label}</div>
          <div className="suggestion-item__role">{s.roleRef}</div>
          {s.reason && <div className="suggestion-item__reason">{s.reason}</div>}
        </button>
      ))}
      <button className="btn btn--ghost" onClick={onSkip}>跳过推荐</button>
    </div>
  )
}
```

### 7.3 门禁配置抽屉

```tsx
export function NodeConfigDrawer({ nodeId, onClose }) {
  return (
    <div className="weave-drawer weave-drawer--open">
      <h3>配置节点</h3>
      <section>
        <label>模型覆盖</label>
        <select><option>vol186coding / deepseek-v4-flash</option></select>
      </section>
      <section>
        <label>输入门禁</label>
        <div>requires: [requirement]</div>
      </section>
      <section>
        <label>输出门禁</label>
        <div>· 产物非空</div>
      </section>
      <section>
        <label>用户审批</label>
        <input type="checkbox" /> 强制审批
      </section>
    </div>
  )
}
```

---

## 八、Phase D：动效与实时监看（~4d）

### 8.1 节点状态动效

```css
.weave-node--running::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--dsw-alias-brand-primary) 0%, var(--dsw-alias-brand-primary) 30%, transparent 30%);
  background-size: 200% 100%;
  animation: weave-node-progress 1.5s linear infinite;
}

@keyframes weave-node-progress {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
```

### 8.2 头顶气泡

```tsx
export function RoleNode({ data }) {
  const { role, state, activity, metrics } = data
  return (
    <>
      <div className={`weave-node weave-node--${state}`}>
        <div className="weave-node__header">
          <span>{iconFor(state)}</span>
          <span>{role.id}</span>
        </div>
        <div className="weave-node__role">{role.name}</div>
        {metrics && <div className="weave-node__metrics">{metrics.duration} · {metrics.tokens}</div>}
      </div>

      {state === 'running' && activity && (
        <div className="weave-bubble">
          <div className="weave-bubble__arrow" />
          <div className="weave-bubble__content">
            <span>{activityIcon(activity.kind)}</span>
            <span>{activity.text}</span>
          </div>
        </div>
      )}
    </>
  )
}
```

### 8.3 边流转动效

```css
.react-flow__edge-path.edge--active {
  stroke: var(--dsw-alias-brand-primary);
  stroke-width: 2.5;
  stroke-dasharray: 8 4;
  animation: weave-edge-flow 1s linear infinite;
}

@keyframes weave-edge-flow {
  to { stroke-dashoffset: -12; }
}
```

---

## 九、Phase E：Token 分账（~2.5d）

### 9.1 三层采集

```
层 1：引擎侧 reportTokenUsage（addSubagent 从 result 读）
层 2：Session 日志读取（解析 zstd jsonl）
层 3：ctx.tokenMeter 订阅（若有）
```

### 9.2 REST API

```typescript
// GET /api/weave/graph/:graphId/tokens
if (tail[0] === 'tokens') {
  const collector = getGraphTokenCollector(graphId)
  json(res, 200, {
    total: collector.total(),
    byNode: ...,
    byRole: ...,
    records: collector.nodes().slice(-100),
  })
}
```

### 9.3 Token 面板

```tsx
export function TokenPanel({ graphId }) {
  const [data, setData] = useState<TokenData | null>(null)
  const [view, setView] = useState<'node' | 'role'>('node')

  useEffect(() => {
    const fetchData = () => fetch(`/api/weave/graph/${graphId}/tokens`).then(r => r.json()).then(setData)
    fetchData()
    const timer = setInterval(fetchData, 3000)
    return () => clearInterval(timer)
  }, [graphId])

  return (
    <div className="token-panel">
      <div className="token-summary">
        <div className="token-summary__number">{data.total.totalTokens.toLocaleString()}</div>
        <div className="token-summary__breakdown">
          <span>输入 {data.total.inputTokens.toLocaleString()}</span>
          <span>输出 {data.total.outputTokens.toLocaleString()}</span>
          <span>缓存读 {data.total.cacheReadTokens.toLocaleString()}</span>
        </div>
      </div>
      <table className="token-table">...</table>
    </div>
  )
}
```

---

## 十、Phase F：节点跳转 subagent（~1.5d）

### 10.1 引擎侧暴露 childId

```typescript
const started = await nodeCtx.ctx.subagents.startContinuable({ ... })
childIdByNode.set(name, started.childId)

nodeCtx.emit({
  type: 'graph/node-start',
  graphId: nodeCtx.graphId,
  node: name,
  timestamp: Date.now(),
  data: { role: options.role ?? '', childId: started.childId },
})
```

### 10.2 前端双击跳转

```tsx
export function RoleNode({ data }) {
  const handleDoubleClick = () => {
    if (!data.childId) return
    openSubagent(data.childId)
  }
  return <div onDoubleClick={handleDoubleClick}>...</div>
}

// 跳转实现（待 PR-5.3 探测）
function openSubagent(childId: string) {
  window.location.hash = `/subagent/${childId}`
}
```

---

## 十一、Phase G：日志系统（~3d）

### 11.1 结构化日志

```json
{
  "ts": 1790215858275,
  "time": "2026-09-24T11:30:58.275+08:00",
  "level": "info",
  "component": "weave-addsubagent",
  "graphId": "graph-xxx",
  "nodeId": "requirement",
  "roleId": "R1-requirement",
  "childId": "f6a0cba2-...",
  "msg": "startContinuable 返回",
  "data": { "elapsedMs": 58 }
}
```

### 11.2 日志查看器

```tsx
export function LogViewer({ graphId }) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [filter, setFilter] = useState({ level: 'info', search: '' })

  useEffect(() => {
    const es = new EventSource(`/api/weave/logs/stream?graphId=${graphId}`)
    es.onmessage = (msg) => {
      const entry = JSON.parse(msg.data)
      if (matchFilter(entry, filter)) setLogs((prev) => [...prev.slice(-500), entry])
    }
    return () => es.close()
  }, [graphId, filter])

  return (
    <div className="log-viewer">
      <div className="log-viewer__toolbar">
        <select>...</select>
        <input placeholder="搜索..." />
        <button>暂停</button>
      </div>
      <div className="log-viewer__list">
        {logs.map((log, i) => (
          <div key={i} className={`log-line log-line--${log.level}`}>
            <span>{formatTime(log.time)}</span>
            <span>{log.level.toUpperCase()}</span>
            <span>[{log.component}]</span>
            <span>{log.msg}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
```

---

## 十二、Phase H：测试与验收（~2d）

### 12.1 单测

- 角色 CRUD + 搜索 + 排序
- 图 CRUD + 复制 + 导入导出
- Environment Gate 前置检查
- ProjectMemory facts 提取与注入
- 超时重设计（无硬超时）
- Token 分账
- 任务草稿 CRUD
- `weave_propose_task` → 草稿 → 启动

### 12.2 E2E

- 用户说"用 weave 创建" → 主 agent 调 `weave_propose_task` → 面板打开 → 编辑 → 启动 → 实时监看 → 中断 → 恢复

---

## 十三、预研项（含依赖标注）

| # | 预研项 | 优先级 | 阻塞 |
|---|---|---|---|
| PR-5.1 | `ctx.tokenMeter` API 探测 | 🔴 P0 | Phase E Token 分账 |
| PR-5.2 | session 日志读取可行性（zstd + 路径） | 🔴 P0 | Phase E 兜底 |
| PR-5.3 | DSH subagent 视图跳转 API 探测 | 🔴 P0 | Phase F 跳转 |
| PR-5.4 | `ctx.subagents.interrupt` 签名 + authority | 🔴 P0 | Phase 0 权限与暂停 |
| PR-5.5 | DSH subagent 事件名探测 | 🔴 P0 | Phase 0 超时重设计 |
| **PR-5.6** | **DSH Slots API 探测（`conversation.view` 激活）** | 🔴 P0 | **Phase I 右侧滑出面板** |
| **PR-5.7** | **DSH `ask_user_question` 子代理路由探测** | 🔴 P0 | **Phase I 用户确认通道 A** |
| PR-5.8 | DSH UI primitives 可用组件探测 | 🟡 P1 | 前端组件选型 |
| PR-5.9 | React Flow 版本兼容 + DnD | 🟡 P1 | Phase C 画布 |
| PR-5.10 | DSH 主题令牌完整清单 | 🟡 P1 | UI 视觉 |

**预研 3-4 天并行完成**。

---

## 十四、完整任务拆解与工作量

| Phase | 任务 | 工作量 | 依赖 |
|---|---|---|---|
| **Phase 0：前置修复** | 6 类 | **10.2d** | PR-5.4, PR-5.5 |
| **Phase I：入口设计** | 9 | **5.6d** | PR-5.6, PR-5.7 |
| A. 角色库 | 5 | 4d | — |
| B. 图保存复用 | 3 | 2.5d | — |
| C. 引导式画布 | 5 | 5d | PR-5.9 |
| D. 动效与实时监看 | 4 | 4d | — |
| E. Token 分账 | 4 | 2.5d | PR-5.1, PR-5.2 |
| F. 跳转联动 | 3 | 1.5d | PR-5.3 |
| G. 日志系统 | 4 | 3d | — |
| H. 测试与验收 | 2 | 2d | 全部 |
| **合计** | **~45 项** | **~40.3d**（约 8 周） | |

**含 3-4d 预研**。

---

## 十五、执行顺序

```
第 1 阶段：Phase 0 前置修复（10.2d）
   ├─ 问题 2（异常退出传播）2d
   ├─ 问题 4（事实共享）2.1d
   ├─ 问题 1（职责 skill 约束）1.5d
   ├─ 超时重设计 1.5d
   ├─ 权限与暂停 1d
   └─ 问题 3（独立验证）2.1d

第 2 阶段：预研（3-4d，可与 Phase 0 并行）

第 3 阶段：Phase I 入口设计（5.6d）
   ├─ weave_propose_task
   ├─ 右侧滑出面板
   ├─ 任务草稿 REST API
   └─ 用户确认弹窗

第 4 阶段：主体功能（A-E，18d）

第 5 阶段：Phase F/G/H（6.5d）
```

---

## 十六、验收清单

| # | 场景 | 期望 |
|---|---|---|
| **Phase 0** | | |
| 1 | R1 产出需求文档 | 只产 requirement.md，不写代码 |
| 2 | R1 遇到环境缺失 | Environment Gate → 图暂停 → 主 agent 停止 |
| 3 | R6 写完代码 | R7 独立测试（childId 不同） |
| 4 | R8 评审不通过 | 图 `success: false` |
| 5 | R1 探测"腾讯 API 可达" | R2/R4/R6 prompt 里有此事实 |
| 6 | 子代理长时间无活动 | 前端提示"X 分钟无活动"，不中止 |
| 7 | 用户点暂停 | DSH 原生 interrupt 生效 |
| **Phase I** | | |
| 8 | 用户说"用 weave 创建 XXX" | 主 agent 调 `weave_propose_task` |
| 9 | 工具返回 | 返回 taskId + panelUrl + 草稿摘要 |
| 10 | 面板自动打开 | 右侧滑出，主 agent 仍可见 |
| 11 | 用户编辑画布 | 拖入/删除节点、配置门禁、覆盖模型 |
| 12 | 点击"开始工作" | 面板调 `weave_run_graph`，图开始跑 |
| 13 | R1 有疑问 | 面板弹 UserQuestionModal |
| 14 | 用户回答 | R1 继续，图恢复运行 |
| 15 | 会话已有活跃任务 | 再次 `weave_propose_task` → 提示"已有任务" |
| **主体功能** | | |
| 16 | 角色库 | 列表 + hover 描述 + 搜索 + 排序 |
| 17 | 引导推荐 | 选节点 → 推荐面板滑入 |
| 18 | 门禁配置 | 抽屉滑出 |
| 19 | 图保存 | 编辑 → 保存 → 落盘 |
| 20 | 头顶气泡 | 显示当前活动 |
| 21 | Token 分账 | 总 + 每节点 + 每角色 |
| 22 | 节点跳转 | 双击打开 subagent 页面 |
| 23 | 日志 | 过滤/搜索 |

---

## 十七、一句话

**MVP-5 = Phase 0 前置修复（10.2d）+ Phase I 入口设计（5.6d）+ 8 个主体 Phase（24.5d）+ 预研（3-4d），总 ~40.3d（约 8 周）。**

**核心变化（相比 v4）**：
1. **新增 Phase I 入口设计**——`weave_propose_task` 工具 + 右侧滑出面板 + 任务草稿 + 用户确认
2. **统一任务状态机**（8 种）—— `graph/paused` 和 `graph/awaiting-user` 融合，用 `pauseReason` 区分
3. **`weave_run_graph` 调用方改为面板**——主 agent 不直接调
4. **两个用户确认通道并存**——`ask_user_question`（弹窗）+ `humanApproval`（审批列表），都映射到 `graph/paused`
5. **移除工作区扫描**——改为 skill 层约束 + 工具白名单
6. **单图模式**——sessionId 一对一 graphId
7. **预研项加依赖标注**——PR-5.6 / PR-5.7 明确阻塞 Phase I

**执行顺序**：**Phase 0 → 预研（并行）→ Phase I 入口 → A-E 主体 → F/G/H 收口**。