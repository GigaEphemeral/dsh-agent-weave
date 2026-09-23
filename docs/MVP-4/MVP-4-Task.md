# MVP-4 完整开发计划（修订版）

> 版本：v2（2026-09-24）｜基线：DSH 0.1.5-rc.2 + Windows 11 + Node 22
> 前置：MVP-3 已完成（Phase 0/A/B/C/D/E/F 全部交付）
> 目标：**从 CLI 终端视图升级为 Web 实时看板**——在 DSH 对话 tab 内看到图节点实时染色、节点活动、Token 分账、审批待办、观察者信号、消息流，并可控制执行
> UI 集成：**D1 页头按钮 + D3 主区切换**（MVP-4）；**D2 侧栏常驻**（MVP-5 演进）
> 消息流：**场景 A 只读桥接，零额外 token**

---

# 一、MVP-4 目标与验收

## 一句话目标

用户在 DSH 对话页点击"Weave 看板"按钮 → 主区切换为全屏看板 → 实时看到图节点染色、当前节点活动、Token 分账、审批待办、观察者信号、消息流 → 可暂停/恢复/终止/审批/从 checkpoint 恢复 → 切回对话继续聊。

## 7 个硬目标

| # | 目标 | 验收标准 |
|---|---|---|
| G1 | 对话页内入口 | DSH 对话页头出现"Weave 看板"按钮（D1） |
| G2 | 主区看板切换 | 点击按钮 → 主区切换为全屏看板（D3） |
| G3 | 实时图染色 | 节点状态变化在 2s 内反映（SSE 推送） |
| G4 | 当前节点活动 | 点击节点看到最近 activity 行 |
| G5 | Token 分账 | 按节点/角色分账，实时更新，真实数值非 0 |
| G6 | 审批面板 | 待办列表 + 批准/拒绝 + 倒计时 |
| G7 | 观察者信号 | GREEN/YELLOW/RED 染色 + 热力图 |
| G8 | 消息流 | A→父→B 时间线（**零额外 token**） |
| G9 | 运行控制 | 暂停/恢复/终止/从 checkpoint 恢复 |
| G10 | 真实环境回归 | 真实 LLM 端到端 + 暂停恢复 + 审批 + 观察者 L2 |

## 明确不做（MVP-5+）

- 拖拽改图、连边（MVP-5 P5.1）
- 导入 YAML 角色（MVP-5 P5.1.1）
- 导入/导出流程包（MVP-5 P5.2.2）
- 自定义节点插件注册（MVP-5 P5.2.3）
- 沙箱隔离（MVP-5 P5.2.4）
- 画廊视图（MVP-5 P5.2）
- 侧栏常驻面板（D2，MVP-5 演进）
- 对话流内嵌卡片（D4，MVP-5 可选）
- 观察者 L3 / 对抗评审 / 记忆压缩（MVP-6）

---

# 二、UI 集成方案

## 2.1 四种集成深度对比

| 深度 | 挂载点 | 效果 | MVP-4 |
|---|---|---|---|
| **D1 页头按钮** | `conversation.header` | 按钮"Weave 看板" | ✅ 采用 |
| **D2 侧栏面板** | `sidebar.bottom` | 看板常驻侧栏 | ⏭ MVP-5 演进 |
| **D3 主区切换** | `conversation.view` | 主区切换为看板 | ✅ 采用 |
| **D4 对话流内嵌卡片** | `conversation.message` | 每个节点执行作为 chat 卡片 | ⏭ MVP-5 可选 |

## 2.2 MVP-4 采用 D1 + D3

```tsx
// src/client/index.tsx
import type { Context } from '@deepseek-ai/cordis'
import { WeaveDashboardButton } from './dashboard/WeaveDashboardButton.js'
import { WeaveDashboardView } from './dashboard/WeaveDashboardView.js'

export const name = 'dsh-agent-weave-client'

export function apply(ctx: Context): void {
  // D1：页头按钮（常驻）
  ctx.slots?.inject('conversation.header', () => <WeaveDashboardButton />)
  // D3：主区切换（按需渲染）
  ctx.slots?.inject('conversation.view', () => <WeaveDashboardView />)
}
```

**效果**：

```
┌──────────────────────────────────────────────┐
│ [对话页头]  [Weave 看板] ← D1 按钮            │
├──────────────────────────────────────────────┤
│ [对话 tab] [看板 tab] ← D3 主区切换            │
├──────────────────────────────────────────────┤
│                                              │
│  对话模式：用户/AI 消息流                      │
│  看板模式：全屏图渲染 + 面板                   │
│                                              │
└──────────────────────────────────────────────┘
```

## 2.3 D2 演进预留

MVP-4 的组件设计为可复用，MVP-5 加一行即可演进：

```typescript
// MVP-5 追加（不改现有代码）
ctx.slots?.inject('sidebar.bottom', () => <WeaveDashboardCompact />)
```

---

# 三、消息流桥接（场景 A：零额外 token）

## 3.1 核心设计

**关键原则**：UI 只读 RunLedger 里的 `agent-message` 事件，**不改变 `sendMessage` 行为，不把消息注入任何 agent context**。

## 3.2 零 token 证据链

| 环节 | 是否进 context | Token |
|---|---|---|
| `sendMessage` 投递（原有行为） | 目标 subagent | 原有开销，非新增 |
| RunLedger 追加事件 | 否（本地文件） | 0 |
| SSE 推送 | 否（网络传输） | 0 |
| UI 渲染 | 否（浏览器） | 0 |
| **UI 展示消息流** | **否** | **0 新增** |

## 3.3 实现

```typescript
// src/l2-engine/message-bus.ts 扩展
export interface MessageBusOptions {
  ttlMs?: number
  sendImpl?: (to: string, content: Message) => Promise<string>
  /** MVP-4 P4.B.11：消息发送后追加 ledger（只读桥接，零 token） */
  ledger?: RunLedger
  /** 当前 graphId（供 ledger 记录） */
  graphId?: string
}

export function createMessageBus(options: MessageBusOptions = {}): MessageBus {
  // ...
  async send(msg) {
    if (!sendImpl) throw new Error('MessageBus 未配置 sendImpl')
    if (this.isExpired(msg)) throw new Error(`消息已过期: ${msg.id}`)
    const result = await sendImpl(msg.to, msg)

    // MVP-4 P4.B.11：只读桥接（不改变 sendMessage 行为，零 token 新增）
    options.ledger?.append({
      type: 'agent-message',
      graphId: options.graphId ?? '',
      node: msg.from,
      timestamp: Date.now(),
      data: {
        id: msg.id,
        from: msg.from,
        to: msg.to,
        type: msg.type,
        correlation_id: msg.correlation_id,
        priority: msg.priority,
        deadline: msg.deadline,
        // 只存摘要，不存 full_content（避免 ledger 膨胀）
        summary: msg.payload.summary,
        artifact_ref: msg.payload.artifact_ref,
      },
    })
    return result
  }
}
```

## 3.4 RunLedger 事件类型扩展

```typescript
// src/l5-observability/run-ledger.ts
export type LedgerEventType =
  | 'graph/start' | 'graph/node-start' | 'graph/node-end' | 'graph/node-error'
  | 'graph/end' | 'checkpoint-written' | 'approval' | 'token-accounted'
  | 'agent-message'   // MVP-4 P4.B.11 新增
  | 'observer-signal' // MVP-4 P4.B.7 新增
  | 'approval-request' | 'approval-decided'  // MVP-4 P4.B.3 新增
```

---

# 四、代码审查问题清单

## P0 阻塞（10 项，必须 Phase 0 修）

| # | 问题 | 位置 | 修复 |
|---|---|---|---|
| P0-1 | 引擎事件未桥接 bus | `state-graph.ts` | 加 `eventSink` 参数 |
| P0-2 | bus 不共享 | `graph-visual-commands.ts` | 用 `shared-bus.ts` |
| P0-3 | artifactsRoot 用 cwd（违反 R45） | `graph-visual-commands.ts` / `graph-run-commands.ts` | 用 `resolveArtifactsRoot` |
| P0-4 | 假 signal（违反 R1） | `state-graph.ts` `addSubagent` | 不传假 signal |
| P0-5 | 并发闸用拒绝版非排队版 | `state-graph.ts` | 改 `createQueueingCounter` |
| P0-6 | `ConditionHandler` 缺 `'__SKIP__'` | `types.ts` | 补类型 |
| P0-7 | `index.ts` 命令列表缺 `weave_graph_tail`，`inject` 缺 `webServer` | `index.ts` | 补 |
| P0-8 | `wait-for.ts` abort listener 泄漏 | `wait-for.ts` | 保存并移除 listener |
| P0-9 | Client 构建路径与计划不一致 | `tsconfig.client.json` | 统一为 `src/client/` |
| P0-10 | `event-bus.ts` 缺 `waiting`/`paused` 状态 | `event-bus.ts` | 补状态 |

## P1 重要（10 项，Phase 0~B 修）

| # | 问题 | 位置 | 修复 |
|---|---|---|---|
| P1-1 | RunLedger 未接入引擎 | `state-graph.ts` | 引擎持 ledger，emit 时写 |
| P1-2 | token-collector 未接入引擎 | `state-graph.ts` | node-end 时写 |
| P1-3 | approval-policy 未接入 state-graph | `state-graph.ts` | RunOptions 加 `approvalPolicy` |
| P1-4 | observer-l2 未接入引擎 | `state-graph.ts` | node-end 后触发观察 |
| P1-5 | `graph-definition.ts` 缺 `artifactName`/`edgeRole` | `graph-definition.ts` | 补 Schema |
| P1-6 | escalate 判断脆弱 | `condition-edge.ts` | 用 `edgeRole` |
| P1-7 | graphId 生成两次 | `graph-visual-commands.ts` | 一次生成全程复用 |
| P1-8 | `graph-run-commands.ts` 未传 `initialLoopUsage` | `graph-run-commands.ts` | 补恢复 |
| P1-9 | `GraphEngineService` 未传 `artifactsRoot`/`eventSink` | `graph-service.ts` | 补参数 |
| P1-10 | `index.tsx` Client 空壳 | `src/client/index.tsx` | 实现 D1+D3 |

## P2 轻微（10 项，Phase 0~E 顺手修）

| # | 问题 | 修复 |
|---|---|---|
| P2-1 | checkpoint 回调参数统一 | 从 payload 读 |
| P2-2 | GraphEngineService 未传 artifactsRoot | 从 Config 读 |
| P2-3 | observer-l2 信号内联类型 | 用 `createObserverSignal` |
| P2-4 | renderAsciiGraph 多条 seq | 已有分叉提示，保持 |
| P2-5 | terminal-view 时间语义 | 已修，保持 |
| P2-6 | loop-detector 80% 整数比较 | 已修，保持 |
| P2-7 | atomic-merge 深层污染 | 已修，保持 |
| P2-8 | ctx.emit 类型断言 | 扩展 Cordis Events 声明 |
| P2-9 | commands 列表硬编码 | 从各 register 收集 |
| P2-10 | peerDeps 缺 react/@xyflow | MVP-4 加 |

---

# 五、分阶段任务

## 阶段 0：修复与地基（9d）

### P4.0.1 共享 bus + eventSink（1d）

**新建** `src/l4-visual/host/shared-bus.ts`：

```typescript
import { createEventBus, type GraphEventBusInternal, type ExecutionSnapshot } from './event-bus.js'

let globalBus: GraphEventBusInternal | null = null
let globalGraphId: string | null = null

export function setGlobalBus(graphId: string): GraphEventBusInternal {
  if (globalGraphId === graphId && globalBus !== null) return globalBus
  globalBus = createEventBus({ graphId, maxIterations: 25 })
  globalGraphId = graphId
  return globalBus
}

export function getGlobalBus(): GraphEventBusInternal | null {
  return globalBus
}

export function getGlobalSnapshot(): ExecutionSnapshot | null {
  return globalBus?.getSnapshot() ?? null
}

export function resetGlobalBus(): void {
  globalBus = null
  globalGraphId = null
}
```

**改** `src/l2-engine/state-graph.ts`：

```typescript
export function createStateGraph<T extends Record<string, unknown>>(
  ctx: Context,
  maxIterations = 25,
  maxConcurrentChildren = 8,
  artifactsRoot?: string,
  /** P4.0.1：可选事件接收器 */
  eventSink?: (event: TrajectoryEvent) => void,
  /** P1-1：可选 RunLedger */
  ledger?: RunLedger,
  /** P1-2：可选 TokenCollector */
  tokenCollector?: TokenCollector,
): StateGraph<T> {
  // ...
  const emit = (event: TrajectoryEvent) => {
    trajectory.push(event)
    ;(ctx.emit as (name: string, payload: unknown) => void)(event.type, event)
    eventSink?.(event)   // P4.0.1
    ledger?.append({     // P1-1
      type: mapToLedgerType(event.type),
      graphId: event.graphId,
      node: event.node,
      timestamp: event.timestamp,
      data: event.data,
    })
    // P1-2：node-end 写 token
    if (event.type === 'graph/node-end' && event.data) {
      const d = event.data
      if (typeof d.inputTokens === 'number') {
        tokenCollector?.record(event.node ?? '', roleOf(event.node), {
          inputTokens: d.inputTokens,
          outputTokens: (d.outputTokens as number) ?? 0,
          cacheReadTokens: (d.cacheReadTokens as number) ?? 0,
        })
      }
    }
    ensureTraceFile()
    if (trace.file) {
      try { appendFileSync(trace.file, `${JSON.stringify(event)}\n`, 'utf8') } catch { /* 静默 */ }
    }
  }
  // ...
}
```

### P4.0.2 引擎事件桥接（含 P4.0.1，0.1d）

见 P4.0.1。

### P4.0.3 artifactsRoot 统一（0.5d）

**新建** `src/l4-visual/host/artifacts-root.ts`：

```typescript
import { join } from 'node:path'

export interface ArtifactsRootInput {
  explicit?: string | undefined
  workspace?: string | undefined
}

export function resolveArtifactsRoot(input: ArtifactsRootInput = {}): string {
  if (input.explicit) return input.explicit
  if (input.workspace) return join(input.workspace, 'productions')
  return join(process.cwd(), 'productions')
}
```

**改** `graph-visual-commands.ts` / `graph-run-commands.ts` / `graph-commands.ts`：三个工具全部接入，参数加 `output_dir`。

### P4.0.4 signal 修复（0.2d）

```typescript
// state-graph.ts addSubagent
const run = await nodeCtx.ctx.subagents.start(options.provider, {
  prompt: [{ type: 'text', text: prompt }],
  parent: agent as never,
  ...(signal ? { signal } : {}),   // 不传假 signal
  label: `${name}（${options.provider}）`,
})
```

### P4.0.5 trace tail 排序（0.2d）

```typescript
import { statSync } from 'node:fs'
files.sort((a, b) => {
  try {
    return statSync(join(tracesDir, b)).mtimeMs - statSync(join(tracesDir, a)).mtimeMs
  } catch { return 0 }
})
```

### P4.0.6 artifactName 支持（0.5d）

```typescript
// types.ts
export interface GraphNodeSpec {
  id: string
  roleRef?: string
  promptTemplate?: string
  nodeType: 'role' | 'condition' | 'approval'
  artifactName?: string   // P4.0.6
}

// graph-definition.ts
artifactName: z.string().optional(),

// graph-run-commands.ts
graph.addSubagent(node.id, {
  provider: node.roleRef,
  artifactName: node.artifactName ?? `${node.id}.md`,
  role: node.roleRef,
  ...(node.promptTemplate !== undefined ? { promptTemplate: node.promptTemplate } : {}),
})
```

### P4.0.7 edgeRole escalate（0.5d）

```typescript
// types.ts
export interface GraphEdgeSpec {
  // ...
  edgeRole?: 'normal' | 'escalate'
}

// graph-definition.ts
edgeRole: z.enum(['normal', 'escalate']).optional(),

// condition-edge.ts
const escalate = outgoing.find(
  (e) =>
    e.from === current &&
    ((e.type === 'cond' && e.edgeRole === 'escalate') ||
      (e.type === 'cond' && e.edgeRole === undefined && e.to.includes('approval'))),
)
```

### P4.0.8 initial_state 支持（0.5d）

```typescript
// graph-run-commands.ts
parameters: {
  // ...
  initial_state: { type: 'object', description: '初始状态字段（可选）' },
}

const initialState = {
  messages: [],
  retry_count: 0,
  max_iterations: spec.maxIterations ?? 25,
  user_input: userInput,
  ...(args.initial_state ?? {}),
}
```

### P4.0.9 pause 传入 HTML（0.2d）

```typescript
// graph-visual-commands.ts
import { readPauseState, pauseStatePath } from '../l2-engine/chain-runner.js'

const pauseState = readPauseState(pauseStatePath(root))
const html = renderHtmlReport(
  snap,
  spec.edges.map((e) => ({ from: e.from, to: e.to })),
  pauseState ? {
    pauseReason: pauseState.pauseReason,
    nextRoleId: pauseState.resumeInfo.nextRoleId,
    completedSteps: pauseState.resumeInfo.completedSteps,
  } : undefined,
)
```

### P4.0.10 graphId 复用（0.2d）

```typescript
async execute(args, exec) {
  const spec = loadGraphSpec(args.path)
  const graphId = `graph-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const bus = setGlobalBus(graphId)
  bus.handle({ type: 'graph/start', graphId, timestamp: Date.now() })
  // ... runGraphMock(ctx, spec, bus, graphId) 传 graphId
}
```

### P4.0.11 ConditionHandler 补 `'__SKIP__'`（0.1d）

```typescript
export type ConditionHandler<T> = (
  state: T, ctx: GraphNodeContext<T>, signal?: AbortSignal,
) =>
  | string
  | readonly string[]
  | '__END__'
  | '__SKIP__'   // P4.0.11
  | Promise<string | readonly string[] | '__END__' | '__SKIP__'>
```

### P4.0.12 index 命令列表（0.1d）

```typescript
export const inject = ['subagents', 'tools', 'skills', 'webServer']

commands: [
  'weave_graph_validate', 'weave_graph_show', 'weave_graph_help',
  'weave_graph_watch', 'weave_graph_report', 'weave_graph_status',
  'weave_graph_tail',
  'weave_run_graph',
],
```

### P4.0.13 observer-l2 信号统一（0.2d）

```typescript
// observer-l2.ts
import { createObserverSignal } from '../observers/signal.js'

toSignal(input) {
  return createObserverSignal({
    observer_id: input.observerId,
    observed_node: input.observedNode,
    signal_level: input.result.level,
    criteria_matched: input.result.findings,
    summary: input.summary,
  })
}
```

### P4.0.14 wait-for listener 泄漏（0.2d）

```typescript
interface PendingWait<T> {
  predicate: (m: T) => boolean
  resolve: (m: T) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout | null
  onAbort: (() => void) | null
  signal: AbortSignal | null
}

function cleanup<T>(entry: PendingWait<T>): void {
  const i = pending.indexOf(entry)
  if (i >= 0) pending.splice(i, 1)
  if (entry.timer) clearTimeout(entry.timer)
  if (entry.onAbort && entry.signal) {
    entry.signal.removeEventListener('abort', entry.onAbort)
  }
}
```

### P4.0.15 真实环境回归清单（1d）

新建 `docs/MVP-4/真实环境回归清单.md`：
- 真实 LLM 端到端
- 暂停/恢复
- sendMessage
- 观察者 L2
- 审批分级

### P4.0.16 多图/单图决策（0.5d）

**决策**：单图模式。`shared-bus.ts` 只维护一个活跃 bus；运行历史另存 `run-history.ts`。

### P4.0.17 Client 构建路径契约（0.5d）

**决策**：Client 代码放 `src/client/`，Host 可视化放 `src/l4-visual/host/`，二者分开。

### P4.0.18 统一 GraphEngineService 与 runGraphRealTool（1d）

```typescript
// graph-service.ts
fromDefinition<T>(spec: unknown, opts?: {
  artifactsRoot?: string
  eventSink?: (e: TrajectoryEvent) => void
  ledger?: RunLedger
  tokenCollector?: TokenCollector
}): StateGraph<T> {
  // ...
  const graph = createStateGraph<T>(
    this.ctx,
    parsed.maxIterations ?? this.config.defaultMaxIterations,
    this.config.maxConcurrentChildren,
    opts?.artifactsRoot ?? this.config.artifactsRoot,
    opts?.eventSink,
    opts?.ledger,
    opts?.tokenCollector,
  )
}
```

### P4.0.19 RunLedger/token-collector 接入引擎（1d）

见 P4.0.1 的 emit 内。

### P4.0.20 基础测试更新（0.5d）

新增：
- `tests/l4-visual/shared-bus.spec.ts`
- `tests/l4-visual/artifacts-root.spec.ts`
- `tests/l2-engine/state-graph-event-sink.spec.ts`

**G0' 门禁**：
- typecheck 0 error
- test ≥ 240
- `weave_run_graph` 后 `weave_graph_status` 显示真实进度
- 产物落 `exec.workspace`
- `artifactName` / `initial_state` 生效
- 热重载无泄漏

---

## 预研（4.5d）

| 编号 | 任务 | 交付 | 预估 |
|---|---|---|---|
| PR-M4.1 | DSH Client API / Slots 探测 | 挂载点、生命周期、通信方式 | 1d |
| PR-M4.2 | webServer / SSE / 鉴权探测 | curl 验证、路由参数、CORS | 1d |
| PR-M4.3 | React Flow 版本兼容 | 最小渲染示例 | 0.5d |
| PR-M4.4 | OTEL 事件契约 | 字段映射文档 | 0.5d |
| PR-M4.5 | Slots 挂载点确认（**D1+D3 重点**） | `conversation.header` + `conversation.view` 可用性 | 0.5d |
| PR-M4.6 | 大图渲染性能 | 50/100/200 节点基线 | 0.5d |
| PR-M4.7 | 多图策略确认 | 单图（已定） | 0.5d |

---

## Phase A：事件流契约与共享总线（5.5d）

### P4.A.1 事件契约定义（1.5d）

**新建** `src/l4-visual/shared/event-schema.ts`：

```typescript
import { z } from 'zod'

export const WsEventSchema = z.object({
  // OTEL 对齐
  trace_id: z.string(),
  span_id: z.string().optional(),
  'gen_ai.agent.name': z.string().optional(),
  'gen_ai.operation.name': z.enum([
    'invoke_agent', 'node_start', 'node_end', 'observer_signal',
  ]).optional(),
  'gen_ai.usage.input_tokens': z.number().optional(),
  'gen_ai.usage.output_tokens': z.number().optional(),
  'gen_ai.usage.cache_read_tokens': z.number().optional(),

  // 业务字段
  event_type: z.enum([
    'graph-start', 'node-start', 'node-end', 'node-error',
    'loop-iteration', 'checkpoint-written',
    'observer-signal', 'agent-message',        // P4.B.11 新增
    'approval-request', 'approval-decided', 'graph-end',
  ]),
  node: z.string().optional(),
  timestamp: z.number(),
  data: z.record(z.unknown()).default({}),
})

export type WsEvent = z.infer<typeof WsEventSchema>

export function trajectoryToWsEvent(
  evt: TrajectoryEvent,
  roleMap: Record<string, string>,
): WsEvent {
  const role = evt.node ? roleMap[evt.node] : undefined
  return {
    trace_id: evt.graphId,
    ...(evt.node ? { span_id: evt.node } : {}),
    ...(role ? { 'gen_ai.agent.name': role } : {}),
    'gen_ai.operation.name':
      evt.type === 'graph/node-start' ? 'node_start'
      : evt.type === 'graph/node-end' ? 'node_end'
      : evt.type === 'graph/node-error' ? 'node_end'
      : 'invoke_agent',
    ...(typeof evt.data?.inputTokens === 'number'
      ? { 'gen_ai.usage.input_tokens': evt.data.inputTokens } : {}),
    ...(typeof evt.data?.outputTokens === 'number'
      ? { 'gen_ai.usage.output_tokens': evt.data.outputTokens } : {}),
    ...(typeof evt.data?.cacheReadTokens === 'number'
      ? { 'gen_ai.usage.cache_read_tokens': evt.data.cacheReadTokens } : {}),
    event_type: mapEventType(evt.type),
    ...(evt.node ? { node: evt.node } : {}),
    timestamp: evt.timestamp,
    data: evt.data ?? {},
  }
}
```

### P4.A.2 shared-bus 完整化（0.5d）

见 P4.0.1。

### P4.A.3 SSE broker（1.5d）

**新建** `src/l4-visual/host/sse-broker.ts`：

```typescript
import type { Response } from 'node:http'
import type { WsEvent } from '../shared/event-schema.js'

interface Subscriber {
  id: string
  graphId: string
  res: Response
  lastSeq: number
}

export interface SseBroker {
  subscribe(graphId: string, res: Response, lastEventId?: string): string
  unsubscribe(id: string): void
  broadcast(graphId: string, event: WsEvent & { seq?: number }): void
  subscriberCount(graphId?: string): number
  dispose(): void
}

export function createSseBroker(): SseBroker {
  const subs = new Map<string, Subscriber>()

  return {
    subscribe(graphId, res, lastEventId) {
      const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(`: connected ${id}\n\n`)
      subs.set(id, { id, graphId, res, lastSeq: lastEventId ? Number.parseInt(lastEventId, 10) : 0 })
      return id
    },
    unsubscribe(id) {
      const sub = subs.get(id)
      if (sub) { sub.res.end(); subs.delete(id) }
    },
    broadcast(graphId, event) {
      const line = `data: ${JSON.stringify(event)}\n\n`
      for (const [id, sub] of subs) {
        if (sub.graphId !== graphId) continue
        try {
          sub.res.write(line)
          if (event.seq !== undefined) sub.lastSeq = event.seq
        } catch { subs.delete(id) }
      }
    },
    subscriberCount(graphId) {
      if (!graphId) return subs.size
      return [...subs.values()].filter((s) => s.graphId === graphId).length
    },
    dispose() {
      for (const sub of subs.values()) sub.res.end()
      subs.clear()
    },
  }
}
```

### P4.A.4 GraphSpec/roleMap 契约（1d）

**新建** `src/l4-visual/host/spec-registry.ts`：

```typescript
interface RegisteredGraph {
  spec: GraphDefinitionSpec
  roleMap: Record<string, string>
  artifactsRoot: string
}

const registry = new Map<string, RegisteredGraph>()

export function registerGraph(graphId: string, entry: RegisteredGraph): void {
  registry.set(graphId, entry)
}

export function getGraph(graphId: string): RegisteredGraph | undefined {
  return registry.get(graphId)
}
```

### P4.A.5 OTEL 映射单测（1d）

```typescript
// tests/l4-visual/event-schema.spec.ts
describe('P4.A.5 事件契约', () => {
  it('TrajectoryEvent → WsEvent 字段完整', () => {
    const evt = trajectoryToWsEvent(
      {
        type: 'graph/node-end',
        graphId: 'g1', node: 'develop', timestamp: 1000,
        durationMs: 500,
        data: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 },
      },
      { develop: 'R6-developer' },
    )
    expect(evt.trace_id).toBe('g1')
    expect(evt.span_id).toBe('develop')
    expect(evt['gen_ai.agent.name']).toBe('R6-developer')
    expect(evt['gen_ai.usage.input_tokens']).toBe(100)
    expect(evt.event_type).toBe('node-end')
    expect(() => WsEventSchema.parse(evt)).not.toThrow()
  })
})
```

---

## Phase B：Host 推送层与后端 API（15.5d）

### P4.B.1 REST API 注册（2d）

**新建** `src/l4-visual/host/routes.ts`：

```typescript
import type { Context } from '@deepseek-ai/cordis'
import { getGlobalSnapshot } from './shared-bus.js'
import { getGraph } from './spec-registry.js'
import { readPauseState, pauseStatePath } from '../../l2-engine/chain-runner.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SseBroker } from './sse-broker.js'
import type { ApprovalService } from './approval-service.js'
import type { TokenCollector } from '../../l5-observability/token-collector.js'
import { listRuns, listCheckpoints } from './run-history.js'
import { readNodeActivity } from './activity-reader.js'

export function registerVisualRoutes(
  ctx: Context,
  broker: SseBroker,
  approvals: ApprovalService,
  tokens: TokenCollector,
): () => void {
  const disposers: Array<() => void> = []

  // GET /api/weave/graph/:graphId/status
  disposers.push(ctx.webServer.register('/api/weave/graph/:graphId/status', (req, res) => {
    const snap = getGlobalSnapshot()
    if (!snap) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'no active graph' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(snap))
  }))

  // GET /api/weave/graph/:graphId/spec
  disposers.push(ctx.webServer.register('/api/weave/graph/:graphId/spec', (req, res) => {
    const graphId = (req.params as { graphId: string }).graphId
    const entry = getGraph(graphId)
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'graph not found' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ spec: entry.spec, roleMap: entry.roleMap }))
  }))

  // GET /api/weave/graph/:graphId/stream（SSE）
  disposers.push(ctx.webServer.register('/api/weave/graph/:graphId/stream', (req, res) => {
    const graphId = (req.params as { graphId: string }).graphId
    const lastEventId = req.headers['last-event-id'] as string | undefined
    const subId = broker.subscribe(graphId, res, lastEventId)
    req.on('close', () => broker.unsubscribe(subId))
  }))

  // GET /api/weave/graph/:graphId/tokens
  disposers.push(ctx.webServer.register('/api/weave/graph/:graphId/tokens', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ rows: tokens.rows(), total: tokens.total() }))
  }))

  // GET /api/weave/graph/:graphId/approvals
  disposers.push(ctx.webServer.register('/api/weave/graph/:graphId/approvals', (req, res) => {
    const graphId = (req.params as { graphId: string }).graphId
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(approvals.list(graphId)))
  }))

  // GET /api/weave/graphs（运行历史）
  disposers.push(ctx.webServer.register('/api/weave/graphs', (req, res) => {
    const entry = getGraph((req.params as { graphId?: string }).graphId ?? '')
    const root = entry?.artifactsRoot ?? resolveArtifactsRoot({})
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(listRuns(root)))
  }))

  // GET /api/weave/graph/:graphId/checkpoints
  disposers.push(ctx.webServer.register('/api/weave/graph/:graphId/checkpoints', (req, res) => {
    // 从 store 读
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify([]))  // 接真实 store
  }))

  // GET /api/weave/graph/:graphId/node/:nodeId/activity
  disposers.push(ctx.webServer.register('/api/weave/graph/:graphId/node/:nodeId/activity', (req, res) => {
    const { graphId, nodeId } = req.params as { graphId: string; nodeId: string }
    const entry = getGraph(graphId)
    const lines = entry ? readNodeActivity(entry.artifactsRoot, graphId, nodeId) : []
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(lines))
  }))

  // POST /api/weave/graph/:graphId/pause | resume | stop | restore
  for (const action of ['pause', 'resume', 'stop'] as const) {
    disposers.push(ctx.webServer.register(`/api/weave/graph/:graphId/${action}`, (req, res) => {
      const graphId = (req.params as { graphId: string }).graphId
      const entry = getGraph(graphId)
      if (entry) writeFileSync(join(entry.artifactsRoot, action.toUpperCase()), '', 'utf8')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, action }))
    }))
  }

  // POST /api/weave/approval/:id/approve | reject
  for (const decision of ['approve', 'reject'] as const) {
    disposers.push(ctx.webServer.register(`/api/weave/approval/:id/${decision}`, (req, res) => {
      const id = (req.params as { id: string }).id
      approvals.resolve(id, decision === 'approve' ? 'approved' : 'rejected')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }))
  }

  return () => { for (const d of disposers) d() }
}
```

### P4.B.2 SSE 广播（2d）

**新建** `src/l4-visual/host/event-bridge.ts`：

```typescript
import type { Context } from '@deepseek-ai/cordis'
import type { SseBroker } from './sse-broker.js'
import { trajectoryToWsEvent } from '../shared/event-schema.js'
import { getGlobalBus } from './shared-bus.js'
import { getGraph } from './spec-registry.js'

export function startEventBridge(ctx: Context, broker: SseBroker): () => void {
  let unsub: (() => void) | null = null

  const connect = () => {
    const bus = getGlobalBus()
    if (!bus) return false
    unsub = bus.subscribe((evt) => {
      const entry = getGraph(evt.graphId)
      const roleMap = entry?.roleMap ?? {}
      broker.broadcast(evt.graphId, trajectoryToWsEvent(evt, roleMap))
    })
    return true
  }

  if (!connect()) {
    const timer = setInterval(() => {
      if (connect()) clearInterval(timer)
    }, 500)
    ctx.effect(() => () => clearInterval(timer))
  }

  return () => { unsub?.() }
}
```

### P4.B.3 审批闭环服务（2d）

**新建** `src/l4-visual/host/approval-service.ts`：

```typescript
export interface ApprovalRequest {
  id: string
  graphId: string
  nodeId: string
  level: 'L1' | 'L2' | 'L3'
  reason: string
  createdAt: number
  timeoutMs: number
  resolved?: { decision: 'approved' | 'rejected'; at: number }
}

export function createApprovalService(broker: SseBroker): ApprovalService {
  const requests = new Map<string, ApprovalRequest>()
  const resolvers = new Map<string, Array<(d: 'approved' | 'rejected' | 'timeout') => void>>()

  return {
    create(input) {
      const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const req: ApprovalRequest = { ...input, id, createdAt: Date.now() }
      requests.set(id, req)
      broker.broadcast(input.graphId, {
        trace_id: input.graphId,
        event_type: 'approval-request',
        node: input.nodeId,
        timestamp: Date.now(),
        data: { approvalId: id, level: input.level, reason: input.reason, timeoutMs: input.timeoutMs },
      })
      if (Number.isFinite(input.timeoutMs)) {
        setTimeout(() => {
          if (!req.resolved) {
            req.resolved = { decision: 'rejected', at: Date.now() }
            const list = resolvers.get(id) ?? []
            for (const r of list) r('timeout')
            resolvers.delete(id)
          }
        }, input.timeoutMs)
      }
      return req
    },
    list: (graphId) => graphId ? [...requests.values()].filter((r) => r.graphId === graphId) : [...requests.values()],
    resolve(id, decision) {
      const req = requests.get(id)
      if (!req || req.resolved) return false
      req.resolved = { decision, at: Date.now() }
      broker.broadcast(req.graphId, {
        trace_id: req.graphId,
        event_type: 'approval-decided',
        node: req.nodeId,
        timestamp: Date.now(),
        data: { approvalId: id, decision },
      })
      const list = resolvers.get(id) ?? []
      for (const r of list) r(decision)
      resolvers.delete(id)
      return true
    },
    pending: (graphId) => [...requests.values()].filter((r) => r.graphId === graphId && !r.resolved),
    waitFor(id, signal) {
      return new Promise((resolve) => {
        const req = requests.get(id)
        if (req?.resolved) { resolve(req.resolved.decision); return }
        const list = resolvers.get(id) ?? []
        list.push(resolve)
        resolvers.set(id, list)
        signal?.addEventListener('abort', () => resolve('timeout'), { once: true })
      })
    },
  }
}
```

### P4.B.4 Token 聚合 API（1.5d）

见 P4.B.1 的 `/tokens` 端点。

### P4.B.5 图控制服务（2d）

```typescript
// src/l4-visual/host/graph-control.ts
export async function pauseGraph(graphId: string, productionsRoot: string): Promise<void> {
  writeFileSync(join(productionsRoot, 'PAUSE'), '', 'utf8')
}
export async function resumeGraph(graphId: string, productionsRoot: string): Promise<void> {
  writeFileSync(join(productionsRoot, 'RESUME'), '', 'utf8')
}
export async function stopGraph(graphId: string, productionsRoot: string): Promise<void> {
  writeFileSync(join(productionsRoot, 'STOP'), '', 'utf8')
}
```

### P4.B.6 运行历史/恢复点 API（1.5d）

**新建** `src/l4-visual/host/run-history.ts`：

```typescript
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RunHistoryEntry {
  graphId: string
  status: string
  startedAt: number
  artifactsRoot: string
}

export function listRuns(productionsRoot: string): RunHistoryEntry[] {
  const tracesDir = join(productionsRoot, 'traces')
  try {
    return readdirSync(tracesDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const graphId = f.replace('.jsonl', '')
        const lines = readFileSync(join(tracesDir, f), 'utf8').split('\n').filter(Boolean)
        const first = JSON.parse(lines[0] ?? '{}')
        const last = JSON.parse(lines[lines.length - 1] ?? '{}')
        return {
          graphId,
          status: last.type === 'graph/end' ? 'completed' : 'running',
          startedAt: first.timestamp ?? 0,
          artifactsRoot: productionsRoot,
        }
      })
  } catch { return [] }
}

export function listCheckpoints(store: CheckpointStore, graphId: string): Array<{
  iteration: number; node: string; timestamp: number
}> {
  const files = store.list(graphId)
  return files.map((f) => {
    const record = store.read(`${store.dir(graphId)}/${f}`)
    return record
      ? { iteration: record.iteration, node: record.node, timestamp: record.timestamp }
      : { iteration: 0, node: '', timestamp: 0 }
  })
}
```

### P4.B.7 观察者信号桥接（1d）

```typescript
// state-graph.ts 内 node-end 后触发观察
if (event.type === 'graph/node-end' && options.observer) {
  const result = options.observer.observe(node, content, criteria)
  if (result.signaled) {
    const sig = options.observer.toSignal({ observerId, observedNode: node, result, summary })
    ledger?.append({
      type: 'observer-signal',
      graphId: event.graphId,
      node,
      timestamp: Date.now(),
      data: sig,
    })
  }
}
```

### P4.B.8 节点活动日志通道 B（1.5d）

**新建** `src/l4-visual/host/activity-reader.ts`：

```typescript
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ActivityLine {
  timestamp: number
  icon: string
  text: string
}

export function readNodeActivity(
  productionsRoot: string,
  graphId: string,
  nodeId: string,
  limit = 20,
): ActivityLine[] {
  const traceFile = join(productionsRoot, 'traces', `${graphId}.jsonl`)
  if (!existsSync(traceFile)) return []
  const lines = readFileSync(traceFile, 'utf8').split('\n').filter(Boolean)
  const activities: ActivityLine[] = []
  for (const line of lines) {
    const evt = JSON.parse(line)
    if (evt.node !== nodeId) continue
    if (evt.type === 'graph/node-start') {
      activities.push({ timestamp: evt.timestamp, icon: '▶', text: `${nodeId} 开始` })
    } else if (evt.type === 'graph/node-end') {
      activities.push({ timestamp: evt.timestamp, icon: '✓', text: `${nodeId} 完成 (${evt.durationMs}ms)` })
    } else if (evt.type === 'graph/loop-iteration') {
      activities.push({ timestamp: evt.timestamp, icon: '⚠', text: `回退 ${evt.data?.from} → ${evt.data?.to}` })
    }
  }
  return activities.slice(-limit)
}
```

### P4.B.9 安全鉴权/CORS/CSRF（1d）

```typescript
function requireAuth(req: IncomingMessage): boolean {
  const token = req.headers['x-weave-token']
  return token === process.env.WEAVE_API_TOKEN
}
```

### P4.B.10 Host 测试（1.5d）

```typescript
describe('P4.B.10 REST 路由', () => {
  it('GET /status 返回快照', async () => { /* ... */ })
  it('GET /spec 返回图定义', async () => { /* ... */ })
  it('POST /pause 写 PAUSE 文件', async () => { /* ... */ })
})
```

### P4.B.11 消息流桥接（1.5d）★ 零额外 token

见"三、消息流桥接"。

### P4.B.12 消息流 SSE 事件（含 P4.B.11，0.5d）

在 `event-bridge.ts` 中额外桥接 ledger 的 `agent-message` 事件：

```typescript
// 从 ledger 读 agent-message 事件，转 WsEvent
ledger.on('agent-message', (evt) => {
  broker.broadcast(evt.graphId, {
    trace_id: evt.graphId,
    event_type: 'agent-message',
    node: evt.node,
    timestamp: evt.timestamp,
    data: evt.data,
  })
})
```

**G-B 门禁**：
- 11 个 REST 端点可用
- SSE 断线重连 + 心跳 + 事件 ID
- 审批 approve/reject 能唤醒等待
- pause/resume/stop 对图执行生效
- observer-signal 能从 Host 到 SSE
- agent-message 能从 Host 到 SSE（零 token）
- `/tokens` 返回真实数值

---

## Phase C：Client 看板（16d）

### P4.C.1 Client 基础设施（1d）

**改** `package.json`：

```json
{
  "dependencies": {
    "react": "^18.3.0",
    "@xyflow/react": "^12.0.0",
    "dagre": "^0.8.5"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.0",
    "@deepseek-ai/dsh-subagent": "^0.1.5-rc.2",
    "react": "^18.3.0"
  }
}
```

**改** `src/client/index.tsx`：

```tsx
import type { Context } from '@deepseek-ai/cordis'
import { WeaveDashboardButton } from './dashboard/WeaveDashboardButton.js'
import { WeaveDashboardView } from './dashboard/WeaveDashboardView.js'

export const name = 'dsh-agent-weave-client'

export function apply(ctx: Context): void {
  // D1：页头按钮
  ctx.slots?.inject('conversation.header', () => <WeaveDashboardButton />)
  // D3：主区切换
  ctx.slots?.inject('conversation.view', () => <WeaveDashboardView />)
}
```

**新建** `src/client/dashboard/WeaveDashboardButton.tsx`：

```tsx
import { useState } from 'react'
import { setDashboardOpen } from '../state/dashboard-state.js'

export function WeaveDashboardButton() {
  const [open, setOpen] = useState(false)
  return (
    <button
      onClick={() => { setOpen(!open); setDashboardOpen(!open) }}
      className={`weave-header-btn ${open ? 'active' : ''}`}
    >
      Weave 看板
    </button>
  )
}
```

**新建** `src/client/dashboard/WeaveDashboardView.tsx`：

```tsx
import { useDashboardOpen } from '../state/dashboard-state.js'
import { GraphCanvas } from './GraphCanvas.js'
import { ControlBar } from './ControlBar.js'
import { TokenPanel } from './TokenPanel.js'
import { ApprovalPanel } from './ApprovalPanel.js'
import { SignalPanel } from './SignalPanel.js'
import { MessageFlowPanel } from './MessageFlowPanel.js'
import { NodeActivityPanel } from './NodeActivityPanel.js'
import { RunHistoryPanel } from './RunHistoryPanel.js'
import { RestorePanel } from './RestorePanel.js'
import { ErrorBoundary } from '../components/ErrorBoundary.js'
import { useGraphStream } from '../hooks/useGraphStream.js'

export function WeaveDashboardView() {
  const open = useDashboardOpen()
  const [graphId, setGraphId] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const { snap, spec, roleMap } = useGraphStream(graphId)

  if (!open) return null

  return (
    <ErrorBoundary>
      <div className="weave-dashboard">
        <ControlBar graphId={graphId} onGraphChange={setGraphId} />
        <GraphCanvas spec={spec} snap={snap} roleMap={roleMap} onSelectNode={setSelectedNode} />
        <div className="weave-panels">
          <TokenPanel graphId={graphId} />
          <ApprovalPanel graphId={graphId} />
          <SignalPanel graphId={graphId} />
          <MessageFlowPanel graphId={graphId} />
          {selectedNode && <NodeActivityPanel graphId={graphId} nodeId={selectedNode} />}
          <RunHistoryPanel onSelect={setGraphId} />
          <RestorePanel graphId={graphId} />
        </div>
      </div>
    </ErrorBoundary>
  )
}
```

### P4.C.2 GraphCanvas（2.5d）

```tsx
// src/client/dashboard/GraphCanvas.tsx
import { useMemo } from 'react'
import ReactFlow, { Background, Controls, type Node, type Edge } from '@xyflow/react'
import dagre from 'dagre'
import '@xyflow/react/dist/style.css'

interface Props {
  spec: GraphDefinitionSpec | null
  snap: GraphSnapshot | null
  roleMap: Record<string, string>
  onSelectNode: (nodeId: string) => void
}

export function GraphCanvas({ spec, snap, roleMap, onSelectNode }: Props) {
  const { nodes, edges } = useMemo(() => {
    if (!spec) return { nodes: [], edges: [] }
    const g = new dagre.graphlib.Graph()
    g.setDefaultEdgeLabel(() => ({}))
    g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80 })
    for (const n of spec.nodes) g.setNode(n.id, { width: 120, height: 50 })
    for (const e of spec.edges) g.setEdge(e.from, e.to)
    dagre.layout(g)

    const rfNodes: Node[] = spec.nodes.map((n) => {
      const pos = g.node(n.id)
      const state = snap?.nodeStates[n.id] ?? 'idle'
      return {
        id: n.id,
        position: { x: pos.x - 60, y: pos.y - 25 },
        data: { label: n.id, state, role: roleMap[n.id] },
        style: nodeStyle(state),
      }
    })
    const rfEdges: Edge[] = spec.edges.map((e, i) => ({
      id: `${e.from}-${e.to}-${i}`,
      source: e.from,
      target: e.to,
      type: e.type === 'loop' ? 'smoothstep' : 'default',
      animated: e.type === 'loop',
      style: e.type === 'loop' ? { strokeDasharray: '5 5', stroke: '#f59e0b' } : {},
    }))
    return { nodes: rfNodes, edges: rfEdges }
  }, [spec, snap, roleMap])

  const nodeCount = spec?.nodes.length ?? 0
  return (
    <div style={{ width: '100%', height: 500, border: '1px solid #e5e7eb', borderRadius: 8 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        onlyRenderVisibleElements={nodeCount > 50}   // P4.C.10 大图虚拟化
        onNodeClick={(_, node) => onSelectNode(node.id)}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}

function nodeStyle(state: string): React.CSSProperties {
  const colors: Record<string, string> = {
    idle: '#e5e7eb', pending: '#fde68a', running: '#fbbf24',
    waiting: '#a5b4fc', completed: '#22c55e', failed: '#ef4444',
  }
  return {
    background: colors[state] ?? '#e5e7eb',
    color: '#111', border: '1px solid #666', borderRadius: 6, padding: 8, fontSize: 12,
  }
}
```

### P4.C.3 useGraphStream（1.5d）

```typescript
// src/client/hooks/useGraphStream.ts
import { useEffect, useState } from 'react'

export interface GraphSnapshot {
  graphId: string
  current: string
  currentRole: string
  iteration: number
  maxIterations: number
  retryCount: number
  tokenUsed: number
  status: 'running' | 'completed' | 'failed' | 'paused'
  nodeStates: Record<string, 'idle' | 'running' | 'completed' | 'failed'>
  startedAt: number
}

export function useGraphStream(graphId: string | null) {
  const [snap, setSnap] = useState<GraphSnapshot | null>(null)
  const [spec, setSpec] = useState<GraphDefinitionSpec | null>(null)
  const [roleMap, setRoleMap] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!graphId) { setSnap(null); setSpec(null); return }
    fetch(`/api/weave/graph/${graphId}/status`).then((r) => r.ok ? r.json() : null).then((s) => s && setSnap(s)).catch(() => {})
    fetch(`/api/weave/graph/${graphId}/spec`).then((r) => r.ok ? r.json() : null).then((d) => {
      if (d) { setSpec(d.spec); setRoleMap(d.roleMap) }
    }).catch(() => {})
  }, [graphId])

  useEffect(() => {
    if (!graphId) return
    const es = new EventSource(`/api/weave/graph/${graphId}/stream`)
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data)
        setSnap((prev) => applyEvent(prev, event))
      } catch { /* 忽略 */ }
    }
    es.onerror = () => { /* EventSource 自动重连 */ }
    return () => es.close()
  }, [graphId])

  return { snap, spec, roleMap }
}

function applyEvent(prev: GraphSnapshot | null, event: { event_type: string; node?: string; data?: Record<string, unknown> }): GraphSnapshot | null {
  if (!prev) return prev
  const next = { ...prev, nodeStates: { ...prev.nodeStates } }
  switch (event.event_type) {
    case 'node-start':
      if (event.node) { next.current = event.node; next.nodeStates[event.node] = 'running' }
      break
    case 'node-end':
      if (event.node) { next.nodeStates[event.node] = 'completed' }
      if (typeof event.data?.tokenUsed === 'number') next.tokenUsed += event.data.tokenUsed as number
      break
    case 'node-error':
      if (event.node) next.nodeStates[event.node] = 'failed'
      break
    case 'loop-iteration':
      if (typeof event.data?.iteration === 'number') next.iteration = event.data.iteration as number
      break
    case 'graph-end':
      next.status = 'completed'
      break
  }
  return next
}
```

### P4.C.4 TokenPanel（1.5d）

```tsx
// src/client/dashboard/TokenPanel.tsx
import { useEffect, useState } from 'react'

export function TokenPanel({ graphId }: { graphId: string | null }) {
  const [rows, setRows] = useState<TokenRow[]>([])
  const [total, setTotal] = useState({ totalTokens: 0 })

  useEffect(() => {
    if (!graphId) return
    const fetchData = () => {
      fetch(`/api/weave/graph/${graphId}/tokens`)
        .then((r) => r.ok ? r.json() : { rows: [], total: {} })
        .then((d) => { setRows(d.rows ?? []); setTotal(d.total ?? {}) })
        .catch(() => {})
    }
    fetchData()
    const t = setInterval(fetchData, 3000)
    return () => clearInterval(t)
  }, [graphId])

  return (
    <div className="token-panel">
      <h3>Token 消耗</h3>
      <div>总: {total.totalTokens?.toLocaleString() ?? 0}</div>
      <table>
        <thead><tr><th>节点</th><th>角色</th><th>输入</th><th>输出</th><th>合计</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.node}>
              <td>{r.node}</td><td>{r.role}</td>
              <td>{r.usage.inputTokens.toLocaleString()}</td>
              <td>{r.usage.outputTokens.toLocaleString()}</td>
              <td>{r.usage.totalTokens.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

### P4.C.5 ApprovalPanel（1.5d）

```tsx
// src/client/dashboard/ApprovalPanel.tsx
import { useEffect, useState } from 'react'

export function ApprovalPanel({ graphId }: { graphId: string | null }) {
  const [requests, setRequests] = useState<ApprovalRequest[]>([])
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!graphId) return
    const fetchList = () => {
      fetch(`/api/weave/graph/${graphId}/approvals`)
        .then((r) => r.ok ? r.json() : [])
        .then(setRequests)
        .catch(() => {})
    }
    fetchList()
    const t = setInterval(fetchList, 3000)
    return () => clearInterval(t)
  }, [graphId])

  // 倒计时刷新
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    await fetch(`/api/weave/approval/${id}/${decision === 'approved' ? 'approve' : 'reject'}`, { method: 'POST' })
    setRequests((rs) => rs.map((r) => r.id === id ? { ...r, resolved: { decision, at: Date.now() } } : r))
  }

  return (
    <div className="approval-panel">
      <h3>审批待办 ({requests.filter((r) => !r.resolved).length})</h3>
      {requests.map((r) => {
        const remaining = r.timeoutMs - (now - r.createdAt)
        return (
          <div key={r.id} className={`approval-item level-${r.level}`}>
            <div><b>{r.level}</b> {r.nodeId}</div>
            <div>{r.reason}</div>
            {!r.resolved ? (
              <>
                <div>剩余 {Math.max(0, Math.round(remaining / 1000))}s</div>
                <button onClick={() => decide(r.id, 'approved')}>批准</button>
                <button onClick={() => decide(r.id, 'rejected')}>拒绝</button>
              </>
            ) : (
              <div>已{r.resolved.decision === 'approved' ? '批准' : '拒绝'}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

### P4.C.6 SignalPanel（2d）

```tsx
// src/client/dashboard/SignalPanel.tsx
import { useEffect, useState } from 'react'

export function SignalPanel({ graphId }: { graphId: string | null }) {
  const [signals, setSignals] = useState<ObserverSignal[]>([])

  useEffect(() => {
    if (!graphId) return
    const es = new EventSource(`/api/weave/graph/${graphId}/stream`)
    es.onmessage = (msg) => {
      const evt = JSON.parse(msg.data)
      if (evt.event_type === 'observer-signal') {
        setSignals((s) => [evt.data as ObserverSignal, ...s].slice(0, 100))
      }
    }
    return () => es.close()
  }, [graphId])

  const byNode = signals.reduce<Record<string, number>>((acc, s) => {
    acc[s.observed_node] = (acc[s.observed_node] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="signal-panel">
      <h3>观察者信号</h3>
      <div className="heatmap">
        {Object.entries(byNode).map(([node, count]) => (
          <div key={node} style={{ background: heatColor(count) }}>{node} ({count})</div>
        ))}
      </div>
      <div className="signal-list">
        {signals.slice(0, 20).map((s) => (
          <div key={s.id} className={`signal ${s.signal_level}`}>
            <b>{s.signal_level.toUpperCase()}</b> {s.observed_node}
            <div>{s.summary}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function heatColor(count: number): string {
  const a = Math.min(count / 10, 1)
  return `rgba(239, 68, 68, ${a * 0.6 + 0.1})`
}
```

### P4.C.7 节点活动详情（1d）

```tsx
// src/client/dashboard/NodeActivityPanel.tsx
import { useEffect, useState } from 'react'

export function NodeActivityPanel({ graphId, nodeId }: { graphId: string | null; nodeId: string | null }) {
  const [lines, setLines] = useState<ActivityLine[]>([])

  useEffect(() => {
    if (!graphId || !nodeId) return
    const fetchData = () => {
      fetch(`/api/weave/graph/${graphId}/node/${nodeId}/activity`)
        .then((r) => r.ok ? r.json() : [])
        .then(setLines)
        .catch(() => {})
    }
    fetchData()
    const t = setInterval(fetchData, 3000)
    return () => clearInterval(t)
  }, [graphId, nodeId])

  return (
    <div className="node-activity">
      <h3>{nodeId} 活动</h3>
      {lines.map((l, i) => (
        <div key={i}>{l.icon} {l.text}</div>
      ))}
    </div>
  )
}
```

### P4.C.8 ControlBar/RunHistory/RestorePanel（2d）

```tsx
// src/client/dashboard/ControlBar.tsx
export function ControlBar({ graphId, onGraphChange }: { graphId: string | null; onGraphChange: (id: string | null) => void }) {
  const [loading, setLoading] = useState(false)

  const call = async (action: 'pause' | 'resume' | 'stop') => {
    if (!graphId) return
    setLoading(true)
    try { await fetch(`/api/weave/graph/${graphId}/${action}`, { method: 'POST' }) }
    finally { setLoading(false) }
  }

  return (
    <div className="control-bar">
      <input placeholder="graphId" value={graphId ?? ''} onChange={(e) => onGraphChange(e.target.value || null)} />
      <button onClick={() => call('pause')} disabled={loading || !graphId}>暂停</button>
      <button onClick={() => call('resume')} disabled={loading || !graphId}>恢复</button>
      <button onClick={() => call('stop')} disabled={loading || !graphId}>终止</button>
    </div>
  )
}

// src/client/dashboard/RunHistoryPanel.tsx
export function RunHistoryPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const [runs, setRuns] = useState<RunHistoryEntry[]>([])
  useEffect(() => {
    fetch('/api/weave/graphs').then((r) => r.json()).then(setRuns).catch(() => {})
  }, [])
  return (
    <div className="run-history">
      <h3>运行历史</h3>
      {runs.map((r) => (
        <div key={r.graphId} onClick={() => onSelect(r.graphId)} style={{ cursor: 'pointer' }}>
          {r.graphId} · {r.status} · {new Date(r.startedAt).toLocaleString('zh-CN')}
        </div>
      ))}
    </div>
  )
}

// src/client/dashboard/RestorePanel.tsx
export function RestorePanel({ graphId }: { graphId: string | null }) {
  const [checkpoints, setCheckpoints] = useState<Array<{ iteration: number; node: string; timestamp: number }>>([])
  useEffect(() => {
    if (!graphId) return
    fetch(`/api/weave/graph/${graphId}/checkpoints`).then((r) => r.json()).then(setCheckpoints).catch(() => {})
  }, [graphId])
  const restore = async (iteration: number, node: string) => {
    await fetch(`/api/weave/graph/${graphId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iteration, node }),
    })
  }
  return (
    <div>
      <h3>恢复点</h3>
      {checkpoints.map((c) => (
        <div key={`${c.iteration}-${c.node}`}>
          iter={c.iteration} · {c.node} · {new Date(c.timestamp).toLocaleString('zh-CN')}
          <button onClick={() => restore(c.iteration, c.node)}>恢复</button>
        </div>
      ))}
    </div>
  )
}
```

### P4.C.9 ErrorBoundary/空态/断线/倒计时（1d）

```tsx
// src/client/components/ErrorBoundary.tsx
import { Component, type ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) { console.error('Weave panel error', error) }
  render() {
    if (this.state.hasError) return <div className="weave-error">组件出错，请刷新页面</div>
    return this.props.children
  }
}
```

### P4.C.10 大图分页/虚拟化（1.5d）

已在 P4.C.2 通过 `onlyRenderVisibleElements` 实现。

### P4.C.11 MessageFlowPanel（1.5d）★ 零 token

```tsx
// src/client/dashboard/MessageFlowPanel.tsx
import { useEffect, useState } from 'react'

interface AgentMessage {
  id: string
  from: string
  to: string
  type: string
  summary: string
  artifact_ref?: string
  timestamp: number
  correlation_id: string
}

export function MessageFlowPanel({ graphId }: { graphId: string | null }) {
  const [messages, setMessages] = useState<AgentMessage[]>([])

  useEffect(() => {
    if (!graphId) return
    const es = new EventSource(`/api/weave/graph/${graphId}/stream`)
    es.onmessage = (msg) => {
      const evt = JSON.parse(msg.data)
      if (evt.event_type === 'agent-message') {
        setMessages((m) => [evt.data as AgentMessage, ...m].slice(0, 100))
      }
    }
    return () => es.close()
  }, [graphId])

  return (
    <div className="message-flow">
      <h3>Agent 消息流（零 token）</h3>
      {messages.map((m) => (
        <div key={m.id} className={`msg msg-${m.type}`}>
          <div><b>{m.from}</b> → <b>{m.to}</b> <span className="msg-type">{m.type}</span></div>
          <div className="msg-summary">{m.summary}</div>
          {m.artifact_ref && <div className="msg-ref">📎 {m.artifact_ref}</div>}
          <div className="msg-time">{new Date(m.timestamp).toLocaleTimeString('zh-CN')}</div>
        </div>
      ))}
    </div>
  )
}
```

---

## Phase D：控制与治理集成（7.5d）

### P4.D.1 图级暂停/恢复/终止（2d）

**StateGraph 节点边界检查**：

```typescript
// state-graph.ts run 主循环内，节点边界检查 PAUSE/STOP 文件
const pauseFlag = join(artifactsRoot ?? '', 'PAUSE')
const stopFlag = join(artifactsRoot ?? '', 'STOP')
if (existsSync(stopFlag)) {
  emit({ type: 'graph/end', graphId, timestamp: Date.now(), data: { stopped: true } })
  return { graphId, success: true, finalState: state, trajectory, iterations: iteration }
}
if (existsSync(pauseFlag)) {
  // 进入暂停等待循环
  // ...
}
```

### P4.D.2 审批策略接入（1.5d）

见 P1-3。

### P4.D.3 观察者 L2 真实接入（1.5d）

见 P1-4 / P4.B.7。

### P4.D.4 RunLedger/token-collector 端到端（1.5d）

见 P4.0.1 / P4.0.19。

### P4.D.5 多图模式落地（1d）

**单图方案**：`shared-bus.ts` 只维护活跃 bus；运行历史另存 `run-history.ts`。

---

## Phase E：集成测试与验收（8.5d）

### P4.E.1 单测矩阵（2d）

新增：
- `tests/l4-visual/shared-bus.spec.ts`
- `tests/l4-visual/sse-broker.spec.ts`
- `tests/l4-visual/approval-service.spec.ts`
- `tests/l4-visual/artifacts-root.spec.ts`
- `tests/l4-visual/run-history.spec.ts`
- `tests/l5-observability/token-collector.spec.ts`
- `tests/l2-engine/message-bus-ledger.spec.ts`（零 token 桥接验证）

### P4.E.2 E2E Playwright（1.5d）

```typescript
// tests/e2e/dashboard.spec.ts
import { test, expect } from '@playwright/test'

test('Weave 看板 D1+D3 端到端', async ({ page }) => {
  await page.goto('http://127.0.0.1:3081/?token=...')
  // D1：页头按钮
  await expect(page.locator('button:has-text("Weave 看板")')).toBeVisible()
  await page.click('button:has-text("Weave 看板")')
  // D3：主区切换
  await expect(page.locator('.weave-dashboard')).toBeVisible()
  await page.fill('input[placeholder*="graphId"]', 'graph-test-1')
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
  await page.click('button:has-text("暂停")')
  await expect(page.locator('.status-paused')).toBeVisible()
})
```

### P4.E.3 一键验收脚本（1d）

```powershell
# test-env/verify-mvp4.ps1
$ErrorActionPreference = 'Stop'
Set-Location D:\dsharness\agentDev\softwareEngnieering\3pluginCode
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'

Write-Host "`n[1/8] 类型检查..." -ForegroundColor Yellow
pnpm typecheck
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "`n[2/8] 单元测试..." -ForegroundColor Yellow
pnpm test
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "`n[3/8] 构建..." -ForegroundColor Yellow
pnpm build
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "`n[4/8] 打包..." -ForegroundColor Yellow
pnpm pack --pack-destination ./dist
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "`n[5/8] 重启 DSH web..." -ForegroundColor Yellow
Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*weave-test*" } |
  Stop-Process -Force
Start-Process -FilePath "node" -ArgumentList "$dshBin --profile weave-test --port 3081 --no-open" -WindowStyle Hidden
Start-Sleep -Seconds 5

Write-Host "`n[6/8] 验证 REST 端点..." -ForegroundColor Yellow
$status = curl.exe -s http://127.0.0.1:3081/api/weave/graphs
if ($LASTEXITCODE -ne 0) { Write-Host "❌ REST 不可用" -ForegroundColor Red; exit 1 }

Write-Host "`n[7/8] 验证 SSE 通道..." -ForegroundColor Yellow
$sse = curl.exe -s -N --max-time 2 http://127.0.0.1:3081/api/weave/graph/test/stream
if ($sse -notmatch "connected") { Write-Host "⚠ SSE 未返回心跳" -ForegroundColor Yellow }

Write-Host "`n[8/8] 验证看板挂载（D1+D3）..." -ForegroundColor Yellow
Write-Host "请手动打开 http://127.0.0.1:3081 检查 Weave 看板入口" -ForegroundColor Cyan

Write-Host "`n✅ MVP-4 自动化验收完成" -ForegroundColor Green
```

### P4.E.4 真实环境回归（2d）

跑通：
- 真实 LLM 端到端
- 暂停/恢复
- sendMessage（**验证零额外 token**）
- 观察者 L2
- 审批分级

### P4.E.5 文档/门禁报告（1d）

新建：
- `docs/MVP-4/MVP-4验收操作指南.md`
- `docs/MVP-4/MVP-4阶段总结.md`
- `docs/MVP-4/事件流契约.md`
- `docs/MVP-4/消息流零token验证报告.md`

### P4.E.6 构建发布配置（1d）

**改** `package.json`：
```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json && tsc -p tsconfig.client.json && tsdown",
    "build:host": "tsc -p tsconfig.json",
    "build:client": "tsc -p tsconfig.client.json && tsdown"
  }
}
```

---

# 六、总工时与里程碑

| 阶段 | 任务数 | 预估 |
|---|---|---|
| 阶段 0 修复与地基 | 20 | 9d |
| 预研 | 7 | 4.5d |
| Phase A 事件流契约 | 5 | 5.5d |
| Phase B Host 推送层 | 12 | 15.5d |
| Phase C Client 看板 | 11 | 16d |
| Phase D 控制与治理 | 5 | 7.5d |
| Phase E 集成验收 | 6 | 8.5d |
| **合计** | **66** | **~66.5d** |

**建议 9-11 周**，关键里程碑：

| 周 | 里程碑 |
|---|---|
| 第 1 周末 | 阶段 0 + 预研完成 |
| 第 3 周末 | Phase A + B 完成（REST/SSE 可用） |
| 第 6 周末 | Phase C 完成（**D1+D3 看板可用**） |
| 第 8 周末 | Phase D 完成（控制/审批/观察者闭环） |
| 第 11 周末 | Phase E 门禁通过（真实环境回归） |

---

# 七、门禁汇总

## G0'（阶段 0 结束）
- typecheck 0 error
- test ≥ 240
- `weave_run_graph` 后 `weave_graph_status` 显示真实进度
- 产物落 `exec.workspace`
- `artifactName` / `initial_state` 生效
- 热重载无泄漏

## G-A（Phase A 结束）
- 事件契约文档归档
- SSE broker 最小可行，`curl -N` 能看到事件流
- `weave_run_graph` 后 bus 有完整 node 事件

## G-B（Phase B 结束）
- 11 个 REST 端点可用
- SSE 断线重连 + 心跳 + 事件 ID
- 审批 approve/reject 能唤醒等待
- pause/resume/stop 对图执行生效
- observer-signal 能从 Host 到 SSE
- **agent-message 能从 Host 到 SSE（零 token）**
- `/tokens` 返回真实数值

## G-C（Phase C 结束）
- D1 页头按钮可见
- D3 主区看板可用
- 图节点实时染色
- 审批可批准/拒绝
- 观察者信号可见
- Token 分账真实
- **消息流可见（零 token）**
- 点击节点看到活动
- ErrorBoundary 不拖垮看板

## G-D（Phase D 结束）
- 暂停/恢复/终止按钮生效
- 从 checkpoint 恢复可用
- 观察者 L2 真实文件观察可用
- RunLedger 可查
- Token 按角色/节点分账

## G-FINAL（Phase E 结束）
- D1+D3 端到端跑通
- 一次多角色循环全程图节点实时染色
- 观察者信号可见
- Token 消耗可分账
- 审批面板可用
- 消息流可见（**零额外 token 验证通过**）
- 暂停/恢复/终止可从 Web 触发
- 运行历史可查
- 一键验收脚本全绿
- 真实环境回归通过

---

# 八、MVP-5 演进预留

MVP-4 结束后，MVP-5 可平滑演进：

| 演进项 | 实现 | 依赖 |
|---|---|---|
| **D2 侧栏常驻** | `ctx.slots?.inject('sidebar.bottom', () => <WeaveDashboardCompact />)` | MVP-4 组件复用 |
| **D4 对话流内嵌卡片** | 参考 `ui-workflow-run`，SSE 事件折叠成 chat 卡片 | MVP-4 事件流 |
| 画布拖拽编辑 | React Flow 双向绑定 | MVP-4 GraphCanvas |
| 角色 YAML 导入 | 复用 `role-loader.ts` | 已有 |
| 流程包导入/导出 | 复用 `workflow-package.ts` | 已有 |
| Gallery 画廊 | 新增 L6 模块 | MVP-4 spec-registry |
| 自定义节点插件 | DSH 插件机制 | MVP-4 事件流 |
| 沙箱隔离 | Docker/seccomp | MVP-4 审批闭环 |

---

# 九、一句话总结

**MVP-4 = D1 页头按钮 + D3 主区切换的 Web 看板**，能看（图染色/活动/Token/审批/观察者/消息流）能控（暂停/恢复/终止/审批/恢复点），**消息流零额外 token**，**MVP-5 平滑演进到 D2 侧栏常驻 + 画布编辑**。

---

**文档版本**：v2（2026-09-24）
**权威源**：`docs/04-MVP与设计契约.md`、`docs/00-开发计划.md`
**关联**：`docs/MVP-4/MVP-4task.md`（本文件）、`docs/MVP-4/事件流契约.md`、`docs/MVP-4/消息流零token验证报告.md`