# 完整修复方案（定稿）

> **决策锁定**：
> - 问题1：4 个修法**全做**
> - 问题2：**方案B**（引擎默认模板）+ **修法2**（工具描述）；**不做修法3**（role_boundary 注入）
> - 问题3：5 处日志**全做**
> - 问题4：3 个修法**全做**
> - 问题5：UI 删 2 行
>
> **涉及文件：8 个**（比按问题拆分少，因为多个修法落在同一文件）

---

## 〇、改动总览（按文件）

| # | 文件 | 涉及问题 | 改动量 |
|---|---|---|---|
| 1 | `src/l2-engine/graph-control.ts` | 1 | +30 行 |
| 2 | `src/l4-visual/host/routes.ts` | 1, 3 | +20 行 |
| 3 | `src/l4-visual/host/graph-control.ts` | 3 | +6 行 |
| 4 | `src/l2-engine/subagent-waiter.ts` | 1, 3, 4 | +50 行 |
| 5 | `src/l2-engine/state-graph.ts` | 1, 2, 3, 4 | +80 行 |
| 6 | `src/l2-engine/error-classifier.ts` | 4 | +15 行 |
| 7 | `src/cli/graph-run-commands.ts` | 2 | +10 行 |
| 8 | `src/client/dashboard/WeaveDashboardView.tsx` | 5 | -2 行 |

**总工时：1.8 天**

---

## 一、`src/l2-engine/graph-control.ts`

**涉及**：问题1 修法1（AbortController）+ 问题3 修法2（状态变化日志）

### 改动

```typescript
/**
 * 内存化图控制（MVP-4 问题四修复 3 + v2 修复：abort 链路贯通）。
 *
 * ★ v2 变更：pause/stop 触发 AbortController.abort → 打断正在跑的 subagent。
 */
import { logger } from '../shared/logger.js'
import { PauseError } from './subagent-waiter.js'

export interface GraphControl {
  pause(): void
  resume(): void
  stop(): void
  isPaused(): boolean
  isStopped(): boolean
  /** ★ v2 新增：图级控制信号（供引擎传给 subagent）。 */
  getSignal(): AbortSignal
  waitForResume(): Promise<void>
}

interface ControlState {
  paused: boolean
  stopped: boolean
  controller: AbortController       // ★ v2 新增
  waiters: Array<() => void>
}

const controls = new Map<string, GraphControl>()

export function getGraphControl(graphId: string): GraphControl {
  let ctrl = controls.get(graphId)
  if (!ctrl) {
    const state: ControlState = {
      paused: false,
      stopped: false,
      controller: new AbortController(),    // ★ v2
      waiters: [],
    }
    ctrl = {
      pause: () => {
        if (state.paused || state.stopped) {
          logger.info('weave-control', 'pause 忽略（已暂停/已终止）', {
            graphId, paused: state.paused, stopped: state.stopped,
          })
          return
        }
        state.paused = true
        // ★ v2 关键：abort 触发 subagent interrupt
        state.controller.abort(new PauseError('user-pause'))
        logger.info('weave-control', '⏸ pause 已触发（abort 已发出）', { graphId })
      },
      resume: () => {
        if (state.stopped) {
          logger.info('weave-control', 'resume 忽略（已终止）', { graphId })
          return
        }
        state.paused = false
        // ★ v2 关键：重置 controller（允许下次 pause）
        state.controller = new AbortController()
        const n = state.waiters.length
        for (const w of state.waiters) w()
        state.waiters.length = 0
        logger.info('weave-control', '▶ resume 已触发', { graphId, releasedWaiters: n })
      },
      stop: () => {
        if (state.stopped) {
          logger.info('weave-control', 'stop 忽略（已终止）', { graphId })
          return
        }
        state.stopped = true
        state.paused = false
        state.controller.abort(new Error('user-stop'))
        for (const w of state.waiters) w()
        state.waiters.length = 0
        logger.info('weave-control', '⏹ stop 已触发（abort 已发出）', { graphId })
      },
      isPaused: () => state.paused,
      isStopped: () => state.stopped,
      getSignal: () => state.controller.signal,   // ★ v2
      waitForResume: () => new Promise((resolve) => {
        if (!state.paused) resolve()
        else state.waiters.push(resolve)
      }),
    }
    controls.set(graphId, ctrl)
  }
  return ctrl
}

export function clearGraphControl(graphId: string): void {
  controls.delete(graphId)
  logger.info('weave-control', 'clearGraphControl', { graphId })
}

export function controlActiveGraph(action: 'pause' | 'resume' | 'stop', graphId: string): boolean {
  logger.info('weave-control', `controlActiveGraph: ${action}`, { graphId })
  const ctrl = getGraphControl(graphId)
  if (action === 'pause') ctrl.pause()
  else if (action === 'resume') ctrl.resume()
  else ctrl.stop()
  return true
}
```

**关键点**：
- `controller.abort(new PauseError('user-pause'))` —— abort reason 用 `PauseError`，让 waiter 能区分
- `resume()` 重置 controller —— 否则第二次 pause 无法触发（signal 只能 abort 一次）
- 所有分支都有日志

---

## 二、`src/l4-visual/host/routes.ts`

**涉及**：问题1 修法2（只走内存控制）+ 问题3 修法1（HTTP 请求日志）

### 改动 1：pause/resume/stop 分支

```typescript
// POST /graph/:graphId/pause|resume|stop
if (tail.length === 1 && ['pause', 'resume', 'stop'].includes(tail[0] ?? '')) {
  if (method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
  const action = tail[0] as 'pause' | 'resume' | 'stop'

  // ★ v2：只走内存控制（触发 abort）
  controlActiveGraph(action, graphId)

  // 文件层保留（chain-runner 兼容）：只做 unlink 清理，不再依赖
  const root = entry?.artifactsRoot ?? resolveArtifactsRoot({})
  if (action === 'resume') {
    try { unlinkSync(join(root, 'PAUSE')) } catch { /* 忽略 */ }
  }

  json(res, 200, { ok: true, action })
  return
}
```

### 改动 2：handle 入口加请求日志

```typescript
const handle = (rest: string, req: Req, res: Res): void => {
  const method = req.method ?? 'GET'

  // ★ v2：每个请求一行 log
  logger.info('weave-routes', `${method} ${rest}`, { path: rest })

  if (!requireAuth(req)) {
    logger.warn('weave-routes', '鉴权失败', { path: rest })
    json(res, 401, { error: 'unauthorized' })
    return
  }

  // ... 原分派逻辑
}
```

### 改动 3：SSE 订阅日志

```typescript
// GET /graph/:graphId/stream
if (tail[0] === 'stream' && tail.length === 1) {
  if (method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
  const lastEventId = req.headers?.['last-event-id']
  const raw = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId
  const subId = broker.subscribe(graphId, res as never, raw)
  logger.info('weave-routes', 'SSE 订阅建立', { graphId, subId })
  req.on?.('close', () => {
    broker.unsubscribe(subId)
    logger.info('weave-routes', 'SSE 订阅断开', { graphId, subId })
  })
  return
}
```

### 顶部 import 补充

```typescript
import { logger } from '../../shared/logger.js'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
```

---

## 三、`src/l4-visual/host/graph-control.ts`

**涉及**：问题3 修法4（PAUSE/STOP 文件写入日志）

### 改动

```typescript
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../../shared/logger.js'

export async function pauseGraph(_graphId: string, productionsRoot: string): Promise<void> {
  const path = join(productionsRoot, 'PAUSE')
  writeFileSync(path, '', 'utf8')
  logger.info('weave-control', '写入 PAUSE 文件', { path })
}

export async function resumeGraph(_graphId: string, productionsRoot: string): Promise<void> {
  const resumePath = join(productionsRoot, 'RESUME')
  const pausePath = join(productionsRoot, 'PAUSE')
  writeFileSync(resumePath, '', 'utf8')
  // ★ v2：删除 PAUSE 文件（否则引擎文件层永远等待）
  try {
    unlinkSync(pausePath)
    logger.info('weave-control', 'resume 清理 PAUSE 文件', { pausePath })
  } catch { /* 忽略 */ }
  logger.info('weave-control', '写入 RESUME 文件', { resumePath })
}

export async function stopGraph(_graphId: string, productionsRoot: string): Promise<void> {
  const path = join(productionsRoot, 'STOP')
  writeFileSync(path, '', 'utf8')
  logger.info('weave-control', '写入 STOP 文件', { path })
}
```

---

## 四、`src/l2-engine/subagent-waiter.ts`

**涉及**：问题1 修法4（abort 处理）+ 问题3 修法3（abort 日志）+ 问题4 修法2（reject 非 completed）

### 改动

```typescript
export function waitForSubagentEnd(
  ctx: Context,
  childId: string,
  opts: WaitOptions = {},
): Promise<SubagentEndPayload> {
  return new Promise((resolve, reject) => {
    let lastActivityAt = Date.now()
    let idleWarningFired = false
    let idleCheckTimer: NodeJS.Timeout | null = null
    let loopDetected = false
    const recentCalls: Array<{ key: string; at: number }> = []
    let settled = false
    let abortHandler: (() => void) | null = null   // ★ v2

    logger.info('weave-subagent-waiter', '开始等待', {
      childId,
      hasSignal: !!opts.signal,
      idleWarningMs: opts.idleWarningMs ?? 600_000,
    })

    function settle(fn: () => void): void {
      if (settled) return
      settled = true
      if (idleCheckTimer) clearInterval(idleCheckTimer)
      dispose()
      // ★ v2：摘 abort listener（防泄漏）
      if (abortHandler && opts.signal) {
        opts.signal.removeEventListener('abort', abortHandler)
        abortHandler = null
      }
      fn()
    }

    // ...（idleCheck / handleActivity 保持原样）

    // ─── 订阅事件 ───
    const dispose = subscribeSubagentEvents(ctx, childId, {
      onActivity: handleActivity,
      // ★ v2 问题4 修法2：stopReason 非 completed 时 reject（不 resolve）
      onEnd: (payload) => {
        if (payload.stopReason !== 'completed') {
          logger.warn('weave-subagent-waiter', '子代理非正常结束', {
            childId, stopReason: payload.stopReason,
            outputBlocks: payload.output.length,
            textLen: payload.output.map((b) => b.text ?? '').join('').length,
          })
          settle(() => reject(new Error(
            `子代理异常结束: stopReason=${payload.stopReason}（输出 ${payload.output.length} 块）`
          )))
          return
        }
        logger.info('weave-subagent-waiter', '子代理正常完成', {
          childId, outputBlocks: payload.output.length,
        })
        settle(() => resolve(payload))
      },
      onError: (error) => {
        logger.warn('weave-subagent-waiter', '子代理错误', { childId, error: String(error) })
        settle(() => reject(error))
      },
    })

    // ★ v2 问题1 修法4：处理 abort
    if (opts.signal) {
      abortHandler = () => {
        const reason = opts.signal!.reason
        const reasonStr = reason instanceof Error
          ? `${reason.constructor.name}: ${reason.message}`
          : String(reason)
        logger.info('weave-subagent-waiter', '⚡ 收到 abort 信号', { childId, reason: reasonStr })

        const parent = opts.parentAgent
        if (parent !== undefined) {
          interruptSubagent(ctx, childId, parent)
            .then(() => logger.info('weave-subagent-waiter', 'interrupt 已调用', { childId }))
            .catch((err) => logger.warn('weave-subagent-waiter', 'interrupt 失败', {
              childId, error: err instanceof Error ? err.message : String(err),
            }))
        } else {
          logger.warn('weave-subagent-waiter', '无 parentAgent，无法 interrupt', { childId })
        }

        // ★ 分流：PauseError → 暂停；其他 → 终止
        if (reason instanceof PauseError) {
          settle(() => reject(reason))
        } else {
          settle(() => reject(new Error(
            `用户终止: ${reason instanceof Error ? reason.message : String(reason)}`
          )))
        }
      }
      opts.signal.addEventListener('abort', abortHandler)
    } else {
      logger.warn('weave-subagent-waiter', '无 signal（无法暂停/终止此节点）', { childId })
    }

    scheduleIdleCheck()
  })
}
```

**关键点**：
- `onEnd` 里 `stopReason !== 'completed'` → reject（问题4 修法2）
- `abortHandler` 保存引用 + `settle` 里摘除（防泄漏）
- abort 时按 `reason instanceof PauseError` 分流

---

## 五、`src/l2-engine/state-graph.ts`

**涉及**：问题1 修法3（graphSignal 传递）+ 问题2 方案B（默认模板）+ 问题3 修法5（stopReason 日志）+ 问题4 修法1（检查 stopReason）

### 改动 1：`types.ts` 加 `graphSignal`

先改 `src/l2-engine/types.ts`：

```typescript
export interface GraphNodeContext<T> {
  // ... 现有字段
  /** ★ v2 新增：图级控制信号（来自 GraphControl）。 */
  graphSignal?: AbortSignal
}
```

### 改动 2：`run` 循环内注入 graphSignal

```typescript
// state-graph.ts run 循环内
const ctrl = getGraphControl(graphId)
// ...（保留 ctrl.isStopped() / ctrl.isPaused() 边界检查）

const nodeCtx: GraphNodeContext<T> = {
  ctx,
  graphId,
  graphVersion: options.graphVersion,
  emit,
  logger: ctx.logger,
  checkpoint: options.checkpoint,
  iteration,
  ...(options.agent !== undefined ? { agent: options.agent } : {}),
  graphSignal: ctrl.getSignal(),    // ★ v2 关键：注入图级信号
  reportTokenUsage(usage) { pending.usage = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0 } },
  reportRetry(count) { pending.retry = count },
}
```

### 改动 3：`addSubagent` 默认模板（问题2 方案B）

```typescript
// addSubagent 内，原 prompt 构建处替换
const defaultTemplate = `你是 {{provider}}，请完成下列**单一职责**任务。

【用户原始需求】（这是整个工作流的输入，不是你一个人的任务）
{{user_input}}

【上游产物】（你只需基于这些内容工作）
{{upstream}}

【你的任务】
仅完成 {{provider}} 角色职责范围内的产出。**不要越权做其他角色的工作**。
例如：你是需求分析师时，只写需求文档，**不要写代码/架构/测试文档**。

【你的产出】
文件名：{{artifactName}}
写完即结束，不要在产物外附加说明性文字。

【行为约束】
每次调用工具前，先输出一行 "[动作] 正在 <做什么>（工具: <toolName>）"。`

const prompt = (options.promptTemplate ?? defaultTemplate)
  .replaceAll('{{provider}}', options.provider)
  .replaceAll('{{user_input}}', String((state.user_input as string | undefined) ?? ''))
  .replaceAll('{{upstream}}', upstreamSummary)
  .replaceAll('{{artifactName}}', options.artifactName ?? `${name}.md`)
```

**关键**：
- 明确"**单一职责**"、"**不要越权**"
- 给出反例（"你是需求分析师时，只写需求文档，不要写代码/架构"）
- `{{user_input}}` 明确标注"不是你一个人的任务"

### 改动 4：`addSubagent` 用 graphSignal + 检查 stopReason（问题1 修法3 + 问题4 修法1）

```typescript
// addSubagent 内
const existingChildId = childIdByNode.get(name)
let result: { output: Array<{ type: string; text?: string }>; stopReason: string }

// ★ v2 关键：优先用 graphSignal（暂停/终止信号）
const effectiveSignal = nodeCtx.graphSignal ?? options.signal

try {
  let activeChildId: string
  if (!existingChildId) {
    const started = await nodeCtx.ctx.subagents.startContinuable({
      provider: options.provider,
      label: `${name}（${options.provider}）`,
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent: agent as never,
      },
      signal: effectiveSignal ?? new AbortController().signal,   // ★ v2
    })
    childIdByNode.set(name, started.childId)
    activeChildId = started.childId
    logger.info('weave-addsubagent', 'startContinuable 返回', {
      node: name, provider: options.provider, childId: activeChildId,
      elapsedMs: Date.now() - startAt,
    })
  } else {
    const feedback = buildFeedbackFromState(state, name)
    await nodeCtx.ctx.subagents.sendMessage(
      agent as never,
      existingChildId as never,
      [{ type: 'text', text: feedback }],
      { signal: effectiveSignal ?? new AbortController().signal },   // ★ v2
    )
    activeChildId = existingChildId
    logger.info('weave-addsubagent', 'sendMessage 反馈已投递', { node: name, childId: existingChildId })
  }

  result = await waitForSubagentEnd(nodeCtx.ctx, activeChildId, {
    ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),   // ★ v2
    parentAgent: agent,
    onActivity: (activity) => { /* ... 原样 */ },
    onIdleWarning: (idleMs) => { /* ... 原样 */ },
    onLoopDetected: (tool, repeatCount) => { /* ... 原样 */ },
  })
} catch (error) {
  logger.error('weave-addsubagent', '子代理启动/执行抛错', error instanceof Error ? error : new Error(String(error)), {
    node: name, provider: options.provider, elapsedMs: Date.now() - startAt,
  })
  throw error
}

// ★ v2 问题4 修法1：双重保险（waitForSubagentEnd 已 reject，但这里再确认）
if (result.stopReason !== 'completed') {
  const err = new Error(`子代理 ${name} 异常结束: stopReason=${result.stopReason}`)
  logger.warn('weave-addsubagent', '子代理非正常结束，节点失败', {
    node: name, stopReason: result.stopReason, childId: childIdByNode.get(name) ?? '',
  })
  throw err
}

const text = result.output.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim()

// ★ v2 问题3 修法5：返回日志增强（含 stopReason / textLen 已有）
logger.info('weave-addsubagent', '子代理执行返回', {
  node: name, provider: options.provider,
  childId: childIdByNode.get(name) ?? '',
  stopReason: result.stopReason,
  outputBlocks: result.output.length,
  textLen: text.length,
  elapsedMs: Date.now() - startAt,
})
```

### 改动 5：`run` 的 catch 分支处理 PauseError

```typescript
// run 循环的 catch 分支
catch (error) {
  const err = error instanceof Error ? error : new Error(String(error))

  // ★ v2：用户暂停（PauseError）→ 写快照 + graph/paused
  if (error instanceof PauseError) {
    logger.info('weave', '图暂停（用户暂停）', { graphId, node: current })
    if (artifactsRoot) {
      const snapshot: PauseSnapshot<T> = {
        graphId, graphVersion: options.graphVersion, graphSchemaHash: options.graphSchemaHash,
        pausedNode: current, pausedAt: Date.now(), iteration, resumeFrom: current,
        pauseReason: 'user-pause',
        pauseDetails: { suggestedAction: '点恢复继续，或用 weave_graph_resume 恢复' },
        state, loopUsage: Object.fromEntries(loopUsed),
        childSessions: Object.fromEntries(childIdByNode),
        completedNodes: [...completedNodes],
      }
      writePauseSnapshot(artifactsRoot, snapshot)
    }
    emit({ type: 'graph/paused', graphId, node: current, timestamp: Date.now(),
      data: { reason: 'user-pause', childId: error.childId, resumeFrom: current } })
    // ★ 不 clearGraphControl（保留状态等 resume）
    return { graphId, success: true, finalState: state, trajectory, iterations: iteration,
      data: { paused: true, reason: 'user-pause', resumeFrom: current } }
  }

  // ★ v2：用户终止（stop 分支已 abort，signal.reason 为 Error 非 PauseError）
  if (ctrl.isStopped()) {
    logger.info('weave', '图终止（用户停止）', { graphId, node: current })
    emit({ type: 'graph/end', graphId, node: current, timestamp: Date.now(), data: { stopped: true } })
    clearGraphControl(graphId)
    return { graphId, success: true, finalState: state, trajectory, iterations: iteration,
      data: { stopped: true } }
  }

  // ...（其他错误走 classifyError 分支，保持原样）
}
```

### 顶部 import 补充

```typescript
import { PauseError } from './subagent-waiter.js'   // 已有
import { logger } from '../shared/logger.js'         // 已有
```

---

## 六、`src/l2-engine/error-classifier.ts`

**涉及**：问题4 修法3（识别 aborted）

### 改动

在 `classifyError` 函数开头加入：

```typescript
export function classifyError(error: Error): ErrorClassification {
  const msg = error.message.toLowerCase()

  // ★ v2 问题4 修法3：子代理被 abort（stopReason=aborted 或"异常结束"）
  if (msg.includes('aborted') || msg.includes('子代理异常结束')) {
    return {
      reason: 'tool-error-fatal',
      needsUserIntervention: true,
      details: {
        error: error.message,
        suggestedAction: '子代理被中断（可能因用户暂停/系统超时）。检查后 resume 恢复，或重跑本节点。',
      },
    }
  }

  // ...（原逻辑）
}
```

---

## 七、`src/cli/graph-run-commands.ts`

**涉及**：问题2 修法2（工具描述规范）

### 改动

```typescript
ctx.tools.register(defineTool({
  name: 'weave_run_graph',
  description:
    '启动图执行（**异步**）：读用户 YAML 图 DSL → 按 roleRef 流转真实子代理 → **立即返回 graphId**。' +
    '图在后台跑，前端看板经 graphId 订阅实时进展。' +
    '参数 path=图YAML, user_input=需求, output_dir=可选产物目录。返回值 status="started" 表示图已启动未完成。' +
    '\n\n★ user_input 传参规范：' +
    '**只传用户需求内容本身**（如"创建一个纯前端五子棋游戏：1. 15×15 棋盘...7. 界面简洁"）。' +
    '**不要传**"请按图链依次完成需求分析、架构设计、开发实现..."之类的执行指令——' +
    '图链的执行逻辑由图 DSL 定义，每个角色只做自己的职责，user_input 只作为原始需求注入。' +
    '若把整链任务写进 user_input，会导致 R1 越权做 R2/R4/R6 的活。' +
    '\n\n注意：① 禁止探测插件源码来理解工具——以 weave_graph_help 与参数描述为准；' +
    '② 图启动后向用户报告 graphId，不要等图跑完；' +
    '③ 若图运行中出错/暂停，先调 weave_graph_help 查看处理办法（weave_graph_resume）。',
  // ...
}))
```

**关键**：工具描述里明确"user_input 传参规范"段落。

---

## 八、`src/client/dashboard/WeaveDashboardView.tsx`

**涉及**：问题5（删审批/观察者面板）

### 改动

```tsx
<div className="weave-panels" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
  <ErrorBoundary><TokenPanel graphId={graphId} /></ErrorBoundary>
  {/* ★ v2：删除审批/观察者面板（后端未接入，永远显示 0） */}
  {/* <ErrorBoundary><ApprovalPanel graphId={graphId} /></ErrorBoundary> */}
  {/* <ErrorBoundary><SignalPanel graphId={graphId} /></ErrorBoundary> */}
  <ErrorBoundary><MessageFlowPanel graphId={graphId} /></ErrorBoundary>
  {selectedNode && (
    <ErrorBoundary><NodeActivityPanel graphId={graphId} nodeId={selectedNode} /></ErrorBoundary>
  )}
  <ErrorBoundary><RunHistoryPanel onSelect={setGraphId} /></ErrorBoundary>
  <ErrorBoundary><RestorePanel graphId={graphId} /></ErrorBoundary>
</div>
```

**同时删 import**：

```typescript
// import { ApprovalPanel } from './ApprovalPanel'    // ★ 删除
// import { SignalPanel } from './SignalPanel'        // ★ 删除
```

**保留文件** `ApprovalPanel.tsx` / `SignalPanel.tsx`（不删，将来接入后端时直接用）。

**可选**：`MessageFlowPanel` 也删（零 token 消息流至今未接入——`createMessageBus` 无调用点）。**建议先保留**，避免一次改动太多。

---

## 九、实施顺序

| Phase | 内容 | 工时 | 依赖 |
|---|---|---|---|
| **A** | `graph-control.ts` + `routes.ts` + `l4-visual/graph-control.ts` | 0.4d | 无 |
| **B** | `subagent-waiter.ts` + `error-classifier.ts` | 0.3d | 无 |
| **C** | `types.ts`（graphSignal）+ `state-graph.ts`（5 处改动） | 0.6d | A + B |
| **D** | `graph-run-commands.ts`（工具描述） | 0.1d | 无 |
| **E** | `WeaveDashboardView.tsx`（UI 删面板） | 0.1d | 无 |
| **F** | 端到端回归 + 日志核对 | 0.3d | 全部 |
| **总** | | **1.8d** | |

**A/B 可并行**（不同文件），C 必须等 A+B（依赖它们的接口）。

---

## 十、验证方法

### V1：暂停 1 秒内生效

**步骤**：
1. 跑一个图（R1 任务简单，R2 用 mock sleep 30s 或真跑长任务）
2. 点 UI"暂停"
3. 检查命令行日志

**预期日志**（1 秒内全部出现）：
```
{"component":"weave-routes","msg":"POST /graph/graph-xxx/pause"}
{"component":"weave-control","msg":"controlActiveGraph: pause","data":{"graphId":"graph-xxx"}}
{"component":"weave-control","msg":"⏸ pause 已触发（abort 已发出）","data":{"graphId":"graph-xxx"}}
{"component":"weave-subagent-waiter","msg":"⚡ 收到 abort 信号","data":{"childId":"5d336aa9...","reason":"PauseError: user-pause"}}
{"component":"weave-subagent-waiter","msg":"interrupt 已调用","data":{"childId":"5d336aa9..."}}
{"component":"weave-addsubagent","msg":"子代理执行返回","data":{"stopReason":"aborted",...}}
{"component":"weave","msg":"图暂停（用户暂停）","data":{"graphId":"graph-xxx","node":"architecture"}}
```

**预期 UI**：架构节点变黄（paused）。

### V2：stopReason=aborted 后不启动下一节点

**步骤**：
1. 跑图
2. R1 期间点"终止"
3. 检查 trace

**预期**：
- trace 无 R2 的 `node-start`
- `pauses/<graphId>.json` 存在（若是 pause）
- 命令行 `图终止（用户停止）`

### V3：R1 只做需求分析

**步骤**：
1. 修复后跑 gomoku-dev.yaml
2. 检查 R1 产物

**预期**：
- `productions/R1-requirement/requirement.md` 存在
- **不写** `productions/R2-architect/architecture.md`
- **不写** `productions/R4-designer/design.md`
- R1 收到的 prompt 含"**单一职责**" / "**不要越权**"

### V4：命令行完整可见

**步骤**：任意跑一次图 + UI 操作

**预期**：所有用户操作（pause/stop/resume）在命令行有对应日志，时间戳连续。

### V5：UI 无冗余面板

**步骤**：打开看板

**预期**：无"审批待办（0）" / "观察者信号（0）"面板。

---

## 十一、需要你提供的代码

要落地以上方案，**请发我这 8 个文件**（按此顺序即可）：

1. `src/l2-engine/graph-control.ts`
2. `src/l4-visual/host/routes.ts`
3. `src/l4-visual/host/graph-control.ts`
4. `src/l2-engine/subagent-waiter.ts`
5. `src/l2-engine/state-graph.ts`
6. `src/l2-engine/error-classifier.ts`
7. `src/cli/graph-run-commands.ts`
8. `src/client/dashboard/WeaveDashboardView.tsx`

发齐后我直接给**逐文件的完整替换代码**（能复制粘贴那种），不需要你再改。

---

## 十二、方案总结

| 问题 | 修法 | 定位 |
|---|---|---|
| **1** 暂停不生效 | graph-control abort + routes 内存控制 + state-graph graphSignal + waiter abort 处理 | 4 环节全做，信号链贯通 |
| **2** R1 干所有活 | 引擎默认模板（单一职责）+ 工具描述（user_input 规范） | 方案 B + 修法2，不做 role_boundary |
| **3** 日志缺失 | routes / graph-control×2 / waiter / state-graph 五处日志 | 5 处全做，成本 20 行 |
| **4** aborted 后继续 | waiter reject 非 completed + addSubagent 检查 + classifyError 补 aborted | 3 个全做，分层防御 |
| **5** UI 冗余 | 删 ApprovalPanel / SignalPanel 渲染 | 2 行，无风险 |

**总改动：约 210 行**（8 文件），**总工时 1.8 天**。

**发我 8 个文件，我给完整 patch。**