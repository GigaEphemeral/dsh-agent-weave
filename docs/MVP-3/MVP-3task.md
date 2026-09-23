# MVP-3 待办清单（含必须处理的问题修复规范 · v3）

> 版本：v3（2026-09-23）｜基线：DSH 0.1.5-rc.2 + Windows 11 + Node 22
> 前置：MVP-2 + MVP-2.5 已完成
> 本版变更：**A4（S10）从"超时终止"改为"超时暂停 + 可配置"**；同步更新规范 R9/R10 与 P3.0.4 任务
> 用途：MVP-3 执行者的唯一待办来源


# 第一部分：必须处理的问题（修复建议 + 规范）

## 零、问题分类速查

| 类别 | 数量 | 是否阻塞 MVP-3 | 处理位置 |
|---|---|---|---|
| **A. MVP-2.5 遗留** | 6 | 是 | Phase 0 |
| **B. MVP-3 前置新发现** | 10 | 部分阻塞 | Phase 0 |
| **C. 全局规范约束** | 41 条 | — | 持续遵守 |

**处理原则**：
- 🔴 严重 → 必须在 MVP-3 启动前修复
- 🟡 中等 → MVP-3 Phase 0 内修复
- 🟢 轻微 → MVP-3 内修，可延后到 Phase F

---

## A. MVP-2.5 遗留问题（6 项）

### A1. S2：`chain-runner` signal 假中止 + STOP 边界

**问题**：`chain-runner.ts` L222 用 `new AbortController().signal`，每次创建但从不 `abort()`。STOP 只在阶段边界检查，正在跑的 LLM 请求无法中止。

**根因**：MVP-1 用最简单实现，未建立 signal 与 STOP 文件的关联。

**影响**：用户创建 STOP 后要等当前角色跑完（R6 曾 650s），期间持续烧 token。

**修复建议**：

```typescript
// chain-runner.ts：controller 在 effect 外创建，effect 只注册清理
const ctrl = new AbortController()
const stopWatcher = setInterval(() => {
  if (existsSync(stopFlagPath(productionsRoot))) {
    ctrl.abort(new Error('用户 STOP'))
  }
}, 1000)

// 用 ctx.effect 注册插件级兜底（不是每次 runChain 都注册新 effect）
const dispose = ctx.effect(() => () => {
  clearInterval(stopWatcher)
  if (!ctrl.signal.aborted) ctrl.abort()
})

try {
  for (const step of steps) {
    if (ctrl.signal.aborted) break
    const run = await ctx.subagents.start(step.roleId, {
      prompt: [{ type: 'text', text: prompt }],
      parent: parent as never,
      signal: ctrl.signal,   // ← 真实 signal
      label: `${step.phase}（${step.roleId}）`,
    })
    result = await run.result
  }
} finally {
  clearInterval(stopWatcher)
  dispose()
}
```

**规范**：

| # | 规范 |
|---|---|
| R1 | **禁止 `new AbortController().signal`** 出现在任何信号传播点；controller 必须在外部创建并可被触发 |
| R2 | STOP 检查**不是阶段边界唯一手段**——必须通过 signal 实时传播 |
| R3 | STOP watcher 用 `setInterval(1000)` 轮询，配合 `ctx.effect` 清理；不用 fs.watch（Windows 兼容差） |

---

### A2. S3：`chain-runner` `setInterval` 未用 `ctx.effect`

**问题**：`chain-runner.ts` L216 的 heartbeat 用普通 `setInterval` + `finally clearInterval`。热重载时旧 fiber 被 dispose，但 heartbeat 定时器继续跑。

**根因**：MVP-1 写这段时还没有资源生命周期契约。

**影响**：热重载后心跳定时器累积泄漏。

**修复建议**：

```typescript
// 方式：保留 finally clearInterval（覆盖正常路径）+ 插件级兜底集合（覆盖热重载）

// src/index.ts（插件入口）：
const activeHeartbeats = new Set<NodeJS.Timeout>()
ctx.effect(() => () => {
  for (const t of activeHeartbeats) clearInterval(t)
  activeHeartbeats.clear()
})

// chain-runner.ts：接受一个 heartbeat 注册器
export interface ChainOptions {
  registerHeartbeat?: (t: NodeJS.Timeout) => void
  unregisterHeartbeat?: (t: NodeJS.Timeout) => void
}

// 使用：
const heartbeat = setInterval(...)
options.registerHeartbeat?.(heartbeat)
try { ... } finally {
  clearInterval(heartbeat)
  options.unregisterHeartbeat?.(heartbeat)
}
```

**规范**：

| # | 规范 |
|---|---|
| R4 | **禁止在循环/函数内每次 `ctx.effect`**——effect 是插件级生命周期，会累积 |
| R5 | 执行级资源用 `try/finally` 清理；插件级兜底用**一个 effect + 集合**统一管理 |
| R6 | 每次新增资源类型（timer / handle / watcher）必须评估：执行级还是插件级？ |

---

### A3. S5：`resolveNextNode` 未被引擎复用

**问题**：`condition-edge.ts` 提供了完整的 `resolveNextNode`，但 `state-graph.ts` 内联了另一套类似逻辑。

**根因**：T7 和 T9 是独立任务，T9 实现引擎时未复用 T7 的成果。

**影响**：两套逻辑逐渐分叉，修改一处不同步。

**修复建议**：

```typescript
// state-graph.ts：删除内联逻辑，统一调用 resolveNextNode

import { resolveNextNode } from './condition-edge.js'

// 条件边（函数式）先跑：
let next: string | undefined
for (const ce of conditional.filter(e => e.from === current)) {
  if (ce.used >= ce.maxIter) continue
  const result = await ce.condition(state, nodeCtx, options.signal)
  const resolved = Array.isArray(result) ? result[0] : result
  if (resolved !== undefined && resolved !== END && resolved !== SKIP) {
    ce.used++
    next = resolved
    break
  }
}

// 函数式未命中 → 声明式（用 resolveNextNode）
if (next === undefined) {
  const usage = Object.fromEntries(loopUsed)
  next = resolveNextNode(current, edges as never, state, usage)
  const key = `${current}->${next}`
  if (next !== END && edges.some(e => e.from === current && e.type === 'loop' && e.to === next)) {
    loopUsed.set(key, (loopUsed.get(key) ?? 0) + 1)
  }
}
```

**规范**：

| # | 规范 |
|---|---|
| R7 | **禁止在多个模块内重复实现同语义逻辑**——`resolveNextNode` 是条件边决策的**唯一实现** |
| R8 | 引擎内联逻辑前必须检查已有工具函数是否满足需求；不满足则**扩展工具函数**而非复制 |

---

### A4. S10：`runChain` 无整体超时（**改为暂停机制 + 可配置**）

**问题**：只有 STOP 检查（阶段边界），无总超时机制。用户希望有**可控的、不丢任务的暂停机制**，且超时时间可配置。

**根因**：MVP-1 只考虑"跑通 + 可观测"，未设计运行状态管理。

**影响**：
- 无超时：用户启动链后去开会，卡在慢请求时无法感知
- **不想要"超时删除任务"**：用户明确要求**超时进入暂停而非终止**，避免已执行的工作丢失

**设计原则**：
- **超时 → 暂停**（不终止、不丢已完成步骤）
- **暂停状态可恢复**（进程重启后能从暂停点续跑）
- **超时时间可配置**（全局 + 每步 + 运行时）
- **暂停点是阶段边界**（保证正在执行的节点能完整完成）

**修复建议**：

#### 1. 状态机

```typescript
export type ChainState = 'running' | 'paused' | 'stopped'

export interface ChainResult {
  steps: ChainResultStep[]
  productionsRoot: string
  /** 是否因用户 STOP 而终止 */
  stopped: boolean
  /** 是否进入暂停（可恢复） */
  paused: boolean
  /** 暂停原因（超时 / 用户暂停 / 外部信号） */
  pauseReason?: string
  /** 恢复信息（暂停时记录，供后续续跑） */
  resumeInfo?: {
    /** 已完成的步骤数 */
    completedSteps: number
    /** 下一个要执行的 roleId */
    nextRoleId: string
    /** upstream 快照（已完成步骤的摘要 + 路径） */
    upstream: ChainPromptContext['upstream']
    /** 暂停时间戳 */
    pausedAt: number
  }
}
```

#### 2. 可配置选项

```typescript
export interface ChainOptions {
  /** 整体超时（毫秒）；未配置则无超时。默认 undefined（不超时） */
  totalTimeoutMs?: number
  /** 超时触发行为；默认 'pause'（暂停，不丢任务） */
  onTimeout?: 'pause' | 'stop'
  /** 每步超时（毫秒），按 roleId 配置；未配置则用 totalTimeoutMs 兜底 */
  stepTimeoutMs?: Record<string, number>
  /** 用户主动暂停标志文件（默认 <productionsRoot>/PAUSE） */
  pauseFlagPath?: string
  /** 恢复标志文件（默认 <productionsRoot>/RESUME） */
  resumeFlagPath?: string
  /** 暂停检查间隔（毫秒，默认 2000） */
  pauseCheckIntervalMs?: number
  /** 心跳注册器（与 A2 联动） */
  registerHeartbeat?: (t: NodeJS.Timeout) => void
  unregisterHeartbeat?: (t: NodeJS.Timeout) => void
}
```

#### 3. 主循环集成

```typescript
export async function runChain(
  ctx: Context,
  parent: unknown,
  steps: readonly ChainStep[],
  userInput: string,
  productionsRoot = join(process.cwd(), 'productions'),
  options: ChainOptions = {},
): Promise<ChainResult> {
  const results: ChainResult['steps'] = []
  let upstream: ChainPromptContext['upstream'] = []
  const chainStart = Date.now()
  
  // 状态机
  let state: ChainState = 'running'
  let pauseReason: string | undefined
  
  // 路径
  const pauseFlag = options.pauseFlagPath ?? join(productionsRoot, 'PAUSE')
  const resumeFlag = options.resumeFlagPath ?? join(productionsRoot, 'RESUME')
  const stopFlag = stopFlagPath(productionsRoot)
  const pauseStateFile = join(productionsRoot, 'pause-state.json')
  
  // 超时触发器：触发后进入暂停（不是 abort）
  let timeoutHandle: NodeJS.Timeout | null = null
  if (options.totalTimeoutMs && options.onTimeout !== 'stop') {
    timeoutHandle = setTimeout(() => {
      state = 'paused'
      pauseReason = `整体超时（${options.totalTimeoutMs}ms）`
      chainLog(productionsRoot, 'warn', '超时触发暂停', {
        pause_reason: pauseReason,
        completed_steps: results.length,
        total_steps: steps.length,
      })
    }, options.totalTimeoutMs)
  } else if (options.totalTimeoutMs && options.onTimeout === 'stop') {
    // 兼容旧的"超时终止"语义（默认不用）
    const ctrl = new AbortController()
    timeoutHandle = setTimeout(() => {
      ctrl.abort(new Error(`链整体超时（${options.totalTimeoutMs}ms）`))
    }, options.totalTimeoutMs)
  }
  
  // STOP / PAUSE 监听（2 秒轮询）
  const pauseCheckMs = options.pauseCheckIntervalMs ?? 2000
  const watcher = setInterval(() => {
    if (existsSync(stopFlag)) {
      state = 'stopped'
    } else if (existsSync(pauseFlag) && state === 'running') {
      state = 'paused'
      pauseReason = '用户主动暂停'
      chainLog(productionsRoot, 'info', '检测到 PAUSE 标志，进入暂停', {
        completed_steps: results.length,
      })
    }
  }, pauseCheckMs)
  options.registerHeartbeat?.(watcher)
  
  // 插件级兜底
  const dispose = ctx.effect(() => () => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    clearInterval(watcher)
  })
  
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      
      // 1) 停止检查
      if (state === 'stopped') {
        chainLog(productionsRoot, 'warn', '检测到 STOP 标志，链终止', {
          stopped_before: step.roleId,
          completed_steps: results.length,
        })
        break
      }
      
      // 2) 暂停检查（阶段边界）—— 进入等待恢复循环
      if (state === 'paused') {
        // 写暂停状态（可恢复）
        const resumeInfo = {
          completedSteps: results.length,
          nextRoleId: step.roleId,
          upstream,
          pausedAt: Date.now(),
        }
        writePauseState(pauseStateFile, {
          pauseReason: pauseReason ?? 'unknown',
          resumeInfo,
        })
        
        chainLog(productionsRoot, 'info', '链进入暂停', {
          pause_reason: pauseReason,
          next_role: step.roleId,
          completed_steps: results.length,
          resume_hint: `创建 ${resumeFlag} 恢复；创建 ${stopFlag} 终止`,
        })
        
        // 等待恢复信号（不退出函数）
        const resumed = await waitForResume(resumeFlag, stopFlag, pauseCheckMs)
        if (!resumed) {
          state = 'stopped'
          break
        }
        
        // 恢复：清理标志
        state = 'running'
        pauseReason = undefined
        removePauseState(pauseStateFile)
        chainLog(productionsRoot, 'info', '链从暂停恢复', {
          from_role: step.roleId,
          elapsed_total_ms: Date.now() - chainStart,
        })
      }
      
      // 3) 执行当前步骤（同原逻辑）
      const stepStart = Date.now()
      const stepDir = join(productionsRoot, step.roleId)
      mkdirSync(stepDir, { recursive: true })
      const artifactPath = join(stepDir, step.artifactName)
      
      const prompt = step.prompt({ userInput, upstream })
      
      // 每步超时（可选；触发只记录警告，不改状态）
      const stepTimeout = options.stepTimeoutMs?.[step.roleId]
      let stepTimeoutHandle: NodeJS.Timeout | null = null
      if (stepTimeout) {
        stepTimeoutHandle = setTimeout(() => {
          chainLog(productionsRoot, 'warn', '单步超时', {
            role_id: step.roleId,
            step_timeout_ms: stepTimeout,
            elapsed_s: Math.round((Date.now() - stepStart) / 1000),
          })
        }, stepTimeout)
      }
      
      chainLog(productionsRoot, 'info', `阶段开始：${step.phase}`, {
        step: i + 1,
        total_steps: steps.length,
        role_id: step.roleId,
        prompt_len: prompt.length,
        upstream_count: upstream.length,
      })
      
      // 心跳（A2 修复：用 registerHeartbeat）
      const heartbeat = setInterval(() => {
        chainLog(productionsRoot, 'info', `心跳：${step.phase} 仍在执行`, {
          role_id: step.roleId,
          elapsed_s: Math.round((Date.now() - stepStart) / 1000),
        })
      }, HEARTBEAT_INTERVAL_MS)
      options.registerHeartbeat?.(heartbeat)
      
      try {
        const run = await ctx.subagents.start(step.roleId, {
          prompt: [{ type: 'text', text: prompt }],
          parent: parent as never,
          signal: ctrl.signal,   // 与 A1 联动
          label: `${step.phase}（${step.roleId}）`,
        })
        const result = await run.result
        
        const elapsedMs = Date.now() - stepStart
        const rawOutput = resultToText(result)
        const output = isCodeArtifact(step.artifactName) ? stripCodeFence(rawOutput) : rawOutput
        
        writeFileSync(artifactPath, output, 'utf8')
        
        chainLog(productionsRoot, 'info', `阶段完成：${step.phase}`, {
          role_id: step.roleId,
          stop_reason: result.stopReason,
          elapsed_s: Math.round(elapsedMs / 1000),
          output_len: output.length,
          artifact: artifactPath,
        })
        
        const summary = truncate(output, 500)
        results.push({ roleId: step.roleId, artifactPath, output, stopReason: result.stopReason })
        upstream = [...upstream, { roleId: step.roleId, artifactName: step.artifactName, summary, path: artifactPath }]
      } finally {
        clearInterval(heartbeat)
        options.unregisterHeartbeat?.(heartbeat)
        if (stepTimeoutHandle) clearTimeout(stepTimeoutHandle)
      }
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    clearInterval(watcher)
    options.unregisterHeartbeat?.(watcher)
    dispose()
  }
  
  const finalState: ChainState = state === 'stopped' ? 'stopped' : (results.length === steps.length ? 'running' : 'paused')
  
  chainLog(productionsRoot, 'info', 
    finalState === 'stopped' ? '链已终止' : (finalState === 'paused' ? '链已暂停（可恢复）' : '链结束'), 
    {
      completed_steps: results.length,
      total_steps: steps.length,
      stopped: finalState === 'stopped',
      paused: finalState === 'paused',
      pause_reason: pauseReason,
      total_elapsed_s: Math.round((Date.now() - chainStart) / 1000),
    }
  )
  
  return {
    steps: results,
    productionsRoot,
    stopped: finalState === 'stopped',
    paused: finalState === 'paused',
    ...(pauseReason !== undefined ? { pauseReason } : {}),
    ...(finalState === 'paused' ? {
      resumeInfo: {
        completedSteps: results.length,
        nextRoleId: steps[results.length]?.roleId ?? '',
        upstream,
        pausedAt: Date.now(),
      },
    } : {}),
  }
}
```

#### 4. 暂停状态持久化

```typescript
interface PauseStateFile {
  pauseReason: string
  resumeInfo: {
    completedSteps: number
    nextRoleId: string
    upstream: Array<{ roleId: string; artifactName: string; summary: string; path: string }>
    pausedAt: number
  }
}

function writePauseState(file: string, state: PauseStateFile): void {
  try {
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // 写失败不阻塞
  }
}

function removePauseState(file: string): void {
  try { unlinkSync(file) } catch { /* 忽略 */ }
}
```

#### 5. 恢复等待

```typescript
async function waitForResume(
  resumeFlag: string,
  stopFlag: string,
  checkIntervalMs: number,
): Promise<boolean> {
  while (true) {
    if (existsSync(stopFlag)) return false       // 期间用户想终止
    if (existsSync(resumeFlag)) {
      try { unlinkSync(resumeFlag) } catch { /* 忽略 */ }
      return true
    }
    await new Promise((r) => setTimeout(r, checkIntervalMs))
  }
}
```

#### 6. 用户操作接口

| 操作 | 命令 | 效果 |
|---|---|---|
| 主动暂停 | `New-Item productions\PAUSE` | 当前步骤跑完后进入暂停 |
| 恢复 | `New-Item productions\RESUME` | 从暂停点继续执行 |
| 终止 | `New-Item productions\STOP` | 立即（阶段边界）终止 |
| 查看暂停状态 | `Get-Content productions\pause-state.json` | 查看暂停原因 + 进度 |

#### 7. 配置方式

**A. 代码配置**：

```typescript
runChain(ctx, parent, steps, userInput, productionsRoot, {
  totalTimeoutMs: 60 * 60 * 1000,   // 1 小时超时 → 暂停
  onTimeout: 'pause',                // 默认就是 pause
  stepTimeoutMs: {
    'R6-developer': 20 * 60 * 1000,  // R6 单步 20 分钟超时（只记警告）
  },
})
```

**B. 配置文件**（`<productionsRoot>/chain-config.json`）：

```json
{
  "totalTimeoutMs": 3600000,
  "onTimeout": "pause",
  "stepTimeoutMs": {
    "R6-developer": 1200000
  },
  "pauseCheckIntervalMs": 2000
}
```

**C. 环境变量**（优先级最低）：

```
WEAVE_CHAIN_TIMEOUT_MS=3600000
WEAVE_CHAIN_ON_TIMEOUT=pause
```

**优先级**：代码 > 配置文件 > 环境变量 > 默认

#### 8. 与 STOP 的区别

| 机制 | 语义 | 触发方式 | 已完成任务 | 可恢复 |
|---|---|---|---|---|
| **STOP** | 终止 | 用户创建 STOP 文件 | 保留 | ❌ 不回退 |
| **PAUSE（用户）** | 暂停 | 用户创建 PAUSE 文件 | 保留 | ✅ 创建 RESUME 恢复 |
| **PAUSE（超时）** | 暂停 | totalTimeoutMs 触发 | 保留 | ✅ 创建 RESUME 恢复 |
| **单步超时** | 警告 | stepTimeoutMs 触发 | 保留 | 不改变状态（仅记录） |

**规范**：

| # | 规范 |
|---|---|
| R9 | **长时任务必须有"暂停"机制**——暂停不丢已完成工作；终止才丢弃后续 |
| R10 | **超时默认进入暂停**（onTimeout: 'pause'），而非终止；用户可显式选 `'stop'` |
| R11 | **超时时间必须可配置**（代码 > 配置文件 > 环境变量 > 默认），三层回退 |
| R12 | **暂停点在阶段边界**——正在执行的节点允许完整跑完，保证原子性 |
| R13 | **暂停状态必须落盘**（`pause-state.json`），进程重启后可从暂停点续跑 |
| R14 | **恢复通过 RESUME 文件触发**；不自动恢复（用户显式操作） |
| R15 | **单步超时与整体超时语义不同**——单步超时只记警告（不改变状态）；整体超时进入暂停 |
| R16 | **STOP 与 PAUSE 是两种机制**——STOP 终止，PAUSE 可恢复；二者都保留已完成步骤 |
| R17 | **暂停状态必须能在 web UI / CLI 查询**（`weave_chain_status` 工具暴露 `pause-state.json`） |

---

### A5. M12：`checkpoint.read` 静默吞错

**问题**：`FsCheckpointStore.read` 用 `try { ... } catch { return null }`，无法区分"文件不存在"和"文件损坏"。

**根因**：catch 吞掉所有错误。

**影响**：checkpoint 文件损坏时静默返回 null，恢复逻辑会误判"无 checkpoint"。

**修复建议**：

```typescript
read(fullPath: string): CheckpointRecord | null {
  let text: string
  try {
    text = readFileSync(fullPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null  // 文件不存在 → 明确的"无 checkpoint"
    }
    throw error   // 其他 IO 错误（权限/磁盘）→ 暴露
  }
  try {
    return JSON.parse(text) as CheckpointRecord
  } catch (error) {
    throw new Error(
      `checkpoint 反序列化失败: ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
```

**规范**：

| # | 规范 |
|---|---|
| R18 | **catch 必须分类处理**——文件不存在（ENOENT）返回 null；其他错误（解析/权限/磁盘）必须抛出 |
| R19 | 恢复逻辑的"无数据"和"数据损坏"是两种语义，禁止混为一谈 |

---

### A6. L9：`terminal-view` 时间语义不一致

**问题**：`terminal-view.formatTime` 用 `Date.now() - timestamp`（相对现在）；`html-report.formatRel` 用 `ts - snap.startedAt`（相对图开始）。

**根因**：两个模块独立实现。

**影响**：用户在终端看到 `[00:15]`，在 HTML 看到 `[00:15]`，但含义不同。

**修复建议**：

```typescript
// terminal-view.ts：接受 startedAt 参数，语义与 html-report 对齐
function formatTime(ts: number, startedAt: number): string {
  const s = Math.max(0, Math.floor((ts - startedAt) / 1000))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

function handle(event: TrajectoryEvent): void {
  const snap = bus.getSnapshot()
  const ts = formatTime(event.timestamp, snap.startedAt)
  // ...
}
```

**规范**：

| # | 规范 |
|---|---|
| R20 | **时间语义必须全项目统一**——所有显示用"相对图开始的秒数（mm:ss）" |
| R21 | 若使用相对时间，起点必须写入 `ExecutionSnapshot.startedAt`，所有视图从快照读取 |

---

## B. MVP-3 前置新发现问题（10 项）

### B1. 🔴 NEW-1：`deepMergeObjects` 深层原型污染

**问题**：`atomic-merge.ts` 的 `deepMergeObjects` 在递归时 `out[key] = patchValue` **未过滤 `__proto__`**。顶层 `mergeState` 用 `Object.create(null)` 保护，但深合并的 `{ ...prev }` 会用 `Object.prototype`。

**代码位置**：

```typescript
function deepMergeObjects(prev, patch) {
  const out = { ...prev }   // ← spread 产生的对象有 Object.prototype
  for (const [key, patchValue] of Object.entries(patch)) {
    // ...无 DANGEROUS_KEYS 检查
    out[key] = patchValue   // ← key === '__proto__' 时污染 out 的原型
  }
  return out
}
```

**根因**：顶层加了防护，深合并漏掉。

**影响**：`patch.artifacts = { __proto__: { polluted: true } }` 会污染 `out` 的原型。

**修复建议**：

```typescript
function deepMergeObjects(
  prev: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  // 用 Object.create(null) 而非 spread —— 从源头断掉原型链
  const out: Record<string, unknown> = Object.assign(Object.create(null), prev)
  for (const [key, patchValue] of Object.entries(patch)) {
    if (DANGEROUS_KEYS.has(key)) continue   // ← 加这行
    const prevValue = out[key]
    if (isPlainObject(prevValue) && isPlainObject(patchValue)) {
      out[key] = deepMergeObjects(prevValue, patchValue)
    } else {
      out[key] = patchValue
    }
  }
  return out
}
```

**验证**：

```typescript
it('深合并拒绝 __proto__ 污染', () => {
  const prev = { artifacts: { a: { x: 1 } } }
  const patch = { artifacts: { __proto__: { polluted: true }, a: { y: 2 } } } as any
  const result = mergeState(prev, patch)
  expect(({} as any).polluted).toBeUndefined()
  expect(result.state?.artifacts.a).toEqual({ x: 1, y: 2 })
})
```

**规范**：

| # | 规范 |
|---|---|
| R22 | **所有对象递归合并必须检查 `DANGEROUS_KEYS`**——不只在顶层 |
| R23 | 合并产生的新对象**首选 `Object.create(null)`**，避免污染原型链 |
| R24 | 单测必须覆盖：`__proto__` / `constructor` / `prototype` 三种危险键（顶层 + 嵌套） |

---

### B2. 🟡 NEW-2：loopUsage 恢复未接通

**问题**：S4 修复让 checkpoint 落盘了 `loopUsage`，但 `run()` **没有读取** `options` 里的 loopUsage 来初始化 `loopUsed`。

**修复建议**：

```typescript
// types.ts：RunOptions 增加字段
export interface RunOptions<T> {
  // ...
  /** 恢复场景：从最近 checkpoint 读回的 loopUsage */
  initialLoopUsage?: Record<string, number>
}

// state-graph.ts：run() 初始化
let loopUsed = options.initialLoopUsage
  ? new Map(Object.entries(options.initialLoopUsage))
  : new Map<string, number>()
```

**调用方**：

```typescript
const restored = await restoreFromLatestCheckpoint(store, graphId, currentGraphVersion)
if (restored && !('error' in restored)) {
  const result = await graph.run(restored.state, {
    checkpoint,
    graphVersion,
    graphSchemaHash,
    initialIteration: restored.iteration,
    initialLoopUsage: restored.loopUsage,   // ← 读回
  })
}
```

**规范**：

| # | 规范 |
|---|---|
| R25 | **状态持久化必须成对**——"写什么"和"读什么"必须一一对应 |
| R26 | `CheckpointPayload` 里每个字段都要问："恢复时它用在哪？" |

---

### B3. 🟡 NEW-3：cond handler 未 try/catch

**问题**：`graph-service.ts` 合成的 cond handler 内 `evaluateCondition(edge.when, state)` 抛错时，异常会冒泡到节点执行层。

**修复建议**：

```typescript
graph.addConditionalEdge(
  from,
  async (state) => {
    for (const edge of condEdges) {
      try {
        if (evaluateCondition(edge.when, state as Record<string, unknown>)) {
          return edge.to
        }
      } catch (error) {
        this.ctx.logger.warn('graph', `条件求值失败，跳过`, {
          from, to: edge.to, when: edge.when,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return SKIP   // 见 NEW-4
  },
  maxIter,
)
```

**规范**：

| # | 规范 |
|---|---|
| R27 | **多条件短路求值时，单个条件失败不应阻塞整条链**——记日志 + 继续 |
| R28 | 条件求值失败属"配置错误"，应在**静态验证阶段**捕获大部分 |

---

### B4. 🟡 NEW-4：cond 全不满足语义

**问题**：合成的 cond handler 在所有条件都不满足时返回 `END`。用户可能期望"继续走静态边"。

**修复建议**：

引入 `SKIP` 常量（显式语义）：

```typescript
// types.ts
export const END = '__END__'
export const SKIP = '__SKIP__'   // 新增：显式跳过本条件，让引擎尝试下一条或静态边

// state-graph.ts：
for (const ce of conditional) {
  if (ce.used >= ce.maxIter) continue
  const resolved = /* ... */
  if (resolved === SKIP) continue    // 显式跳过
  if (resolved !== undefined && resolved !== END) {
    next = resolved
    break
  }
}

// graph-service.ts 的 cond handler：
return SKIP   // 所有条件都不满足 → 让引擎尝试静态边
```

**规范**：

| # | 规范 |
|---|---|
| R29 | **多条件路由的"全不满足"语义必须文档化** |
| R30 | 若语义隐晦（返回 END 却不终止），必须**引入显式常量**（如 `SKIP`）表达意图 |

---

### B5. 🟡 NEW-5：字段不存在时 `JSON.stringify(undefined)` 返回 `undefined`

**问题**：`evaluateCondition` 里 `JSON.stringify(undefined)` 返回 `undefined`（非字符串），拼接后含字母 `undefined`，白名单校验拒绝。

**修复建议**：

```typescript
export function evaluateCondition(expr: string, state: Record<string, unknown>): boolean {
  const replaced = expr.replace(/state\.(\w+)/g, (_, field: string) => {
    const value = state[field]
    if (value === undefined) return 'null'
    if (value === null) return 'null'
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
    if (typeof value === 'boolean') return String(value)
    if (typeof value === 'string') {
      if (value.length > 10000) {
        throw new ConditionEvalError(`字段 ${field} 字符串过长（${value.length} > 10000）`)
      }
      return JSON.stringify(value)
    }
    throw new ConditionEvalError(
      `条件表达式不支持字段 ${field} 的类型: ${typeof value}（只支持 string/number/boolean/null）`
    )
  })
  // ...
}
```

**规范**：

| # | 规范 |
|---|---|
| R31 | **表达式求值禁止直接用 `JSON.stringify`**——必须先做类型白名单 + 边界检查 |
| R32 | 字段不存在时应明确返回 `null`，让表达式自然求值为 false |

---

### B6. 🟡 NEW-6：`new Function` 注入风险

**问题**：`evaluateCondition` 用 `new Function` 求值。对特殊值（如含 `\u2028`/`\u2029`、超长字符串）存在风险。

**修复建议**：

配合 NEW-5 的类型白名单（已限制 string/number/boolean/null + 长度），加：

```typescript
// 表达式长度限制
if (replaced.length > 2000) {
  throw new ConditionEvalError(`条件表达式过长: ${replaced.length} > 2000`)
}

// 白名单校验
const checkable = replaced.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '"0"')
if (!/^[\s\d+\-*/<>=!&|(),.'"]*$/.test(checkable)) {
  throw new ConditionEvalError(`条件表达式包含非法字符: ${expr}`)
}
```

**未来可选方案**（不阻塞 MVP-3）：引入 `jsep` / `expr-eval` 做 AST 解析。

**规范**：

| # | 规范 |
|---|---|
| R33 | **`new Function` 只在严格白名单 + 类型白名单 + 长度限制下使用** |
| R34 | 表达式求值输入上限 **2000 字符**；单字段字符串上限 **10000 字符** |
| R35 | 禁止在表达式里做**函数调用**——白名单不含 `(` 后的标识符 |

---

### B7. 🟢 NEW-7：`graphVersion` 参数重复

**问题**：`createCheckpointCallback(store, graphId, graphVersion, graphSchemaHash, logger)` 已传 graphVersion，但 `CheckpointPayload` 里也有。用户需传两次。

**修复建议**：

```typescript
// checkpoint.ts：从 payload 读取，去掉冗余参数
export function createCheckpointCallback<T>(
  store: CheckpointStore,
  graphId: string,
  logger?: CheckpointLogger,
): CheckpointCallback<T> {
  return async (payload) => {
    // ...
    const record: CheckpointRecord = {
      graphId,
      graphVersion: payload.graphVersion,        // ← 从 payload 读
      graphSchemaHash: payload.graphSchemaHash,  // ← 从 payload 读
      node: payload.node,
      state: serialized,
      iteration: payload.iteration,
      timestamp: payload.timestamp,
    }
    // ...
  }
}
```

**规范**：

| # | 规范 |
|---|---|
| R36 | **同一数据只应有一个来源**——`payload.graphVersion` 是权威来源 |
| R37 | 重构时优先删除**冗余参数**而非增加文档说明 |

---

### B8. 🟢 NEW-8：mock 未同步 S13 接口

**问题**：`graph-visual-commands.ts` 的 `runGraphMock` 里 mock handler 直接返回 `retry_count`，未调用 S13 新增的 `ctx.reportTokenUsage` / `ctx.reportRetry`。

**修复建议**：

```typescript
graph.addNode(nodeId, async (state, nodeCtx) => {
  await new Promise((r) => setTimeout(r, MOCK_NODE_DELAY_MS))
  const inputTokens = Math.floor(Math.random() * 400) + 200
  const outputTokens = Math.floor(Math.random() * 300) + 100
  nodeCtx.reportTokenUsage?.({ input: inputTokens, output: outputTokens, cacheRead: 0 })
  nodeCtx.reportRetry?.((state.retry_count as number | undefined) ?? 0)
  return {
    messages: [{ role: 'mock', node: nodeId, at: Date.now() }],
    retry_count: 1,   // 增量
    active_agent: role,
  }
})
```

**规范**：

| # | 规范 |
|---|---|
| R38 | **接口变更必须同步所有实现**——mock / 生产实现 / 测试桩，一处不落 |
| R39 | `reportTokenUsage` / `reportRetry` 是节点→引擎的标准上报通道 |

---

### B9. 🟢 NEW-9：`terminal-view` 订阅泄漏

**问题**：`createTerminalView.start()` 调用 `bus.subscribe(handle)` 但**不保存返回的 unsubscribe 函数**。

**修复建议**：

```typescript
export function createTerminalView(bus, output): { start(): void; stop(): void } {
  let stopped = false
  let unsubscribe: (() => void) | null = null
  
  function handle(event: TrajectoryEvent): void {
    if (stopped) return
    // ...
  }
  
  return {
    start() {
      unsubscribe = bus.subscribe(handle)   // ← 保存
      // ...
    },
    stop() {
      stopped = true
      unsubscribe?.()                       // ← 解除订阅
      unsubscribe = null
      // ...
    },
  }
}
```

**规范**：

| # | 规范 |
|---|---|
| R40 | **订阅（subscribe/on/addListener）必须保存返回的注销函数，并在 stop/dispose 时调用** |

---

### B10. 🟢 NEW-10：`currentRole` 未接通

**问题**：`event-bus.ts` L91 从 `event.data.role` 提取 `currentRole`，但 `state-graph.ts` 的 `node-start` 事件**未设置** `data.role`。

**修复建议**：

**方案 A**：给 `addNode` 加 meta 参数

```typescript
// state-graph.ts：
export interface NodeMeta {
  role?: string
}

addNode(name: string, handler: NodeHandler<T>, meta?: NodeMeta): this

// emit node-start 时：
emit({
  type: 'graph/node-start',
  graphId,
  node: current,
  timestamp: Date.now(),
  data: { role: nodeMetas.get(current)?.role ?? '' },
})

// graph-service.ts 里注册时传：
graph.addNode(node.id, handler, { role: node.roleRef ?? node.nodeType })
```

**规范**：

| # | 规范 |
|---|---|
| R41 | **事件契约的字段必须有明确的数据来源**——不能只在消费者侧定义；新增字段同步更新类型注释和测试 |

---

## C. 全局规范约束（从 A/B 提炼，MVP-3 强制）

### C.1 代码规范（41 条，R1-R41 见上文）

### C.2 环境规范

| # | 规范 |
|---|---|
| E1 | 隔离 `DSH_HOME`（`test-env/dsh-home`），主环境零写入 |
| E2 | 路径用 `path.join`/`path.dirname`；文件读 `-Encoding UTF8` |
| E3 | DSH 0.1.5-rc.2 不升级 |

### C.3 测试规范

| # | 规范 |
|---|---|
| T1 | 单测零 LLM（不调 `ctx.llm`） |
| T2 | 热重载测试入门禁 |
| T3 | 契约冻结（GA 后 `RunOptions` / `Message` / `CheckpointPayload` 冻结） |
| T4 | 核心模块覆盖率 > 80% |

### C.4 文档规范

| # | 规范 |
|---|---|
| D1 | 每个任务归档 `docs/acceptance/A<N>-verify.md` |
| D2 | Stage Gate 报告归档 `docs/gates/G<N>-report.md` |
| D3 | 遗留问题清单 `docs/MVP-3/issues.md` |


# 第二部分：MVP-3 目标与任务拆解

## 一、目标拆解

### 一句话目标

**让 subagent 之间能真正协作（消息传递 + 等待唤醒 + 中断传播），并让整个执行过程可持久化、可恢复、可按角色分账。**

### 六个硬目标

| # | 目标 | 验收标准 |
|---|---|---|
| G1 | 遗留 + 新发现问题全部修复 | 代码审查清单清零 |
| G2 | 真实子代理接入（`startContinuable`） | 图节点执行真实 LLM，输出映射回 State |
| G3 | 消息总线 + 等待唤醒 | A 发消息给 B，B 回复后唤醒 A；死锁检测生效 |
| G4 | 任务树持久化 + handoff 四字段 | 中断后从 checkpoint 恢复，交接可追溯 |
| G5 | RunLedger + Token 分账 | 执行轨迹可查，Token 按节点/角色分账 |
| G6 | 中断实时传播 | 用户 STOP 时，正在跑的 LLM 请求立即中止 |
| **G7** | **暂停/恢复机制** | **超时进入暂停；用户可主动暂停；不丢已完成工作；可恢复** |

### 明确不做

画布编辑器 / 观察者 L3 / 记忆压缩 / 对抗评审 / 社区分发 / 自进化 / 角色 Skill 优化

---

## 二、任务总览（31 任务，~50d，~8 周）

| Phase | 任务数 | 预估 | 核心 | 门禁 |
|---|---|---|---|---|
| **0. 修复** | 17 | 6.0d | 遗留 6 + 新发现 10 + 文档 | G0 |
| **A. 真实子代理** | 3 | 6d | startContinuable + 生命周期 + 中断 | GA |
| **B. 消息总线与唤醒** | 3 | 8d | sendMessage + waitFor + 死锁检测 | GB |
| **C. 持久化与分账** | 4 | 10d | 任务树 + handoff + RunLedger + 分账 | GC |
| **D. 治理与配置** | 4 | 9d | 观察者 L2 + 审批分级 + 生命周期 + 并发 | GD |
| **E. 对外配置** | 3 | 6d | 角色包 + 流程包 + 重启 | GE |
| **F. 可视化与端到端** | 3 | 6d | 可视化扩展 + 端到端测试 + 收口 | GF |

---

## 三、Phase 0：修复阶段

### 3.1 任务清单

| # | 任务 | 交付物 | 预估 | 阻塞 | 严重度 |
|---|---|---|---|---|---|
| P3.0.1 | **A1 S2** signal 假中止 + STOP 边界 | controller 外部创建 + STOP watcher | 1.0d | ✅ | 🔴 |
| P3.0.2 | **A2 S3** setInterval 未 ctx.effect | 插件级 heartbeat 集合 | 0.5d | ✅ | 🔴 |
| P3.0.3 | A3 S5 resolveNextNode 未复用 | 删除内联逻辑，统一调用 | 0.5d | ⚠️ | 🔴 |
| **P3.0.4** | **A4 S10 暂停机制 + 可配置超时** | **状态机 + 暂停/恢复 + 三层配置** | **1.2d** | ✅ | 🔴 |
| P3.0.5 | A5 M12 checkpoint.read 吞错 | 分类处理 ENOENT / 解析错误 | 0.3d | ❌ | 🟡 |
| P3.0.6 | A6 L9 时间语义不一致 | terminal-view 用 startedAt | 0.2d | ❌ | 🟢 |
| P3.0.7 | **B1 NEW-1** 深层原型污染 | `deepMergeObjects` 加 DANGEROUS_KEYS | 0.3d | ✅ | 🔴 |
| P3.0.8 | **B2 NEW-2** loopUsage 恢复未接通 | `RunOptions.initialLoopUsage` + 初始化 | 0.3d | ✅ | 🟡 |
| P3.0.9 | **B3 NEW-3** cond handler 未 try/catch | handler 内包 try/catch + 记日志 | 0.3d | ✅ | 🟡 |
| P3.0.10 | B4 NEW-4 cond 全不满足语义 | 引入 SKIP 常量 | 0.3d | ⚠️ | 🟡 |
| P3.0.11 | **B5 NEW-5** 字段不存在报错不直观 | 类型白名单 + 显式处理 undefined | 0.2d | ❌ | 🟡 |
| P3.0.12 | **B6 NEW-6** new Function 注入风险 | 类型白名单 + 长度限制 | 0.5d | ✅ | 🟡 |
| P3.0.13 | B7 NEW-7 graphVersion 参数重复 | createCheckpointCallback 从 payload 读 | 0.3d | ❌ | 🟢 |
| P3.0.14 | B8 NEW-8 mock 未同步 S13 接口 | mock handler 调 reportTokenUsage | 0.2d | ❌ | 🟢 |
| P3.0.15 | B9 NEW-9 terminal-view 订阅泄漏 | 保存 unsubscribe 并调用 | 0.2d | ❌ | 🟢 |
| P3.0.16 | B10 NEW-10 currentRole 未接通 | addNode 加 meta 参数 + node-start 带 role | 0.3d | ❌ | 🟢 |
| P3.0.17 | 全局规范归档 | `docs/MVP-3/规范约束.md`（R1-R41） | 0.3d | ❌ | — |

**合计**：17 项，**~6.7d**。

### 3.2 执行顺序

**第 1 批（🔴 阻塞，约 3.0d）**：
- P3.0.1（S2）
- P3.0.2（S3）
- **P3.0.4（A4 暂停机制，重点）**
- P3.0.7（NEW-1）

**第 2 批（🟡 中等，约 2.4d）**：
- P3.0.3（S5）
- P3.0.5（M12）
- P3.0.8（NEW-2）
- P3.0.9（NEW-3）
- P3.0.10（NEW-4）
- P3.0.11（NEW-5）
- P3.0.12（NEW-6）

**第 3 批（🟢 轻微，约 1.3d）**：
- P3.0.6（L9）
- P3.0.13（NEW-7）
- P3.0.14（NEW-8）
- P3.0.15（NEW-9）
- P3.0.16（NEW-10）
- P3.0.17（规范归档）

### 3.3 G0 门禁

**检查命令**：

```powershell
cd D:\dsharness\agentDev\softwareEngnieering\3pluginCode
pnpm typecheck
pnpm test
```

**检查清单**：

| # | 检查项 | 通过标准 | 证据 | 签署 |
|---|---|---|---|---|
| 1 | 17 项修复全部完成 | 任务表全部 ✅ | `docs/acceptance/` | ☐ |
| 2 | `pnpm typecheck` | 0 error | 命令输出 | ☐ |
| 3 | `pnpm test` | ≥ 188 用例全绿（178 + 新增 10） | 命令输出 | ☐ |
| 4 | 终端视图 Token/retry 非 0 | 实机验证 | 截图/输出 | ☐ |
| 5 | 热重载无泄漏 | S3 修复验证 | 测试输出 | ☐ |
| 6 | 深层原型污染防护 | NEW-1 单测通过 | `tests/` | ☐ |
| **7** | **暂停机制生效** | **创建 PAUSE 文件 → 暂停 → 创建 RESUME → 恢复** | **实机验证** | ☐ |
| **8** | **超时可配置** | **配置 `totalTimeoutMs: 5000` → 5s 后进入暂停；配置 `onTimeout: 'stop'` → 5s 后终止** | **实机验证** | ☐ |

**未通过：禁止启动 Phase A**

---

## 四、Phase A：真实子代理接入

### 4.1 任务清单

| # | 任务 | 交付物 | 预估 |
|---|---|---|---|
| P3.A.1 | `addSubagent` 接入真实子代理 | `src/l2-engine/subagent-node.ts` + `state-graph.ts` 扩展（用 `startContinuable()`） | 3d |
| P3.A.2 | 子代理生命周期管理 | `src/l3-roles/lifecycle-manager.ts`（resident / on-demand / hybrid） | 2d |
| P3.A.3 | 中断实时传播 | signal 从 `run()` 贯通到 `ctx.subagents.start()` → LLM 请求 | 1d |

### 4.2 GA 门禁

- [ ] 真实子代理跑通（一句话需求 → 图执行 → 真实产出）
- [ ] 生命周期三模式验证
- [ ] STOP 后 1-2s 内中止
- [ ] 暂停/恢复在真实子代理上生效

**未通过：禁止启动 Phase B**

---

## 五、Phase B：消息总线与唤醒（★ 核心）

### 5.1 任务清单

| # | 任务 | 交付物 | 预估 |
|---|---|---|---|
| P3.B.1 | 消息总线实现 | `src/l2-engine/message-bus.ts`（封装 `sendMessage`；含 correlation_id / deadline / priority） | 3d |
| P3.B.2 | 等待唤醒机制 ★ | `src/l2-engine/wait-for.ts`（`waitFor` + `wakeUp`；不用轮询） | 3d |
| P3.B.3 | 防死锁分级恢复 | 单条超时重试 ≤2 / 同 Agent 同链路 ≥3 次强制终止 / 工作流超时降级审批 | 2d |

### 5.2 GB 门禁

- [ ] 消息中转 A→父→B 可达
- [ ] 等待唤醒：A 挂起，B 完成后 A 被唤醒
- [ ] 死锁检测：A 等 B、B 等 A 被检测并恢复

**未通过：禁止启动 Phase C**

---

## 六、Phase C：持久化与分账

### 6.1 任务清单

| # | 任务 | 交付物 | 预估 |
|---|---|---|---|
| P3.C.1 | 任务树持久化 | `src/l2-engine/task-tree.ts` | 3d |
| P3.C.2 | handoff 四字段交接协议 | `src/l2-engine/handoff.ts`（summary / artifacts / openIssues / provenance） | 2d |
| P3.C.3 | RunLedger 审计账本 | `src/l5-observability/run-ledger.ts`（SQLite + OTel 对齐） | 3d |
| P3.C.4 | Token 分账 | `src/l5-observability/token-collector.ts`（读 session `data.usage`） | 2d |

### 6.2 GC 门禁

- [ ] 中断后从 checkpoint 恢复，State 一致
- [ ] handoff 四字段落盘，可追溯
- [ ] RunLedger 完整轨迹可查
- [ ] Token 按节点/角色分账，真实数值非 0
- [ ] 暂停状态落盘（`pause-state.json`），进程重启后可续跑

**未通过：禁止启动 Phase D**

---

## 七、Phase D：治理与配置

### 7.1 任务清单

| # | 任务 | 交付物 | 预估 |
|---|---|---|---|
| P3.D.1 | 观察者 L2 静默观察 | `src/observers/observer-l2.ts`（文件观察 + GREEN/YELLOW/RED） | 4d |
| P3.D.2 | 人工审批分级 | L1 异步 / L2 同步 / L3 同步+告警；超时策略 | 2d |
| P3.D.3 | 生命周期管理 | 安装 `dsh-session-pruner` + 配置 | 2d |
| P3.D.4 | 并发多层防护 | 改用 `createQueueingCounter` | 1d |

### 7.2 GD 门禁

- [ ] 观察者 L2 信号正确
- [ ] 三级审批分级验证
- [ ] session 不膨胀
- [ ] 并发排队生效
- [ ] 审批超时行为符合规范（L1: 10min 自动继续；L2: 30min 升级 L3；L3: 无超时）

**未通过：禁止启动 Phase E**

---

## 八、Phase E：对外配置

### 8.1 任务清单

| # | 任务 | 交付物 | 预估 |
|---|---|---|---|
| P3.E.1 | 角色包加载器 | `src/l3-roles/role-package.ts`（YAML + Zod + 版本兼容性） | 2d |
| P3.E.2 | 流程包加载器 | `src/l3-roles/workflow-package.ts`（依赖校验 + graphSchemaHash） | 2d |
| P3.E.3 | 重启与目标复用 | `src/l2-engine/restart.ts`（`ctx.jobs` + `ctx.goals`） | 2d |

### 8.2 GE 门禁

- [ ] 角色包导入并执行
- [ ] 流程包导入并执行
- [ ] 重启后任务恢复（包括暂停状态的任务）

**未通过：禁止启动 Phase F**

---

## 九、Phase F：可视化扩展与端到端

### 9.1 任务清单

| # | 任务 | 交付物 | 预估 |
|---|---|---|---|
| P3.F.1 | 可视化扩展 | 终端视图加消息流；HTML 报告加分账 + 恢复点 + **暂停状态** | 2d |
| P3.F.2 | 端到端测试 | 四场景：中断恢复 / 消息对话 / 分账 / **暂停恢复** | 3d |
| P3.F.3 | 阶段收口 | `docs/MVP-3/MVP-3阶段总结.md` + 门禁报告 | 1d |

### 9.2 GF 门禁（8 项）

- [ ] 中断可恢复
- [ ] 交接可追溯
- [ ] 按角色分账
- [ ] 跨角色对话可达
- [ ] session 不膨胀
- [ ] 中断实时传播
- [ ] 等待唤醒生效
- [ ] **暂停/恢复机制生效**（主动暂停 + 超时暂停 + 可配置超时）

---

## 十、待决策（MVP-3 动工前需定）

| # | 决策点 | 建议 | 状态 |
|---|---|---|---|
| 1 | RunLedger 存储格式 | SQLite（查询快） | 待确认 |
| 2 | 消息总线 payload 传递 | `art://` 引用（控上下文） | 待确认 |
| 3 | 观察者 L2 触发阈值 | 按复杂度（省 Token） | 待确认 |
| 4 | 角色包版本格式 | semver | 待确认 |
| **5** | **审批分级超时** | **L1: 10min** / L2: 30min / L3: 无超时 | **已定** |
| 6 | 并行分支 Join 语义 | 全部完成（最直观） | 待确认 |
| 7 | 是否做"真正的协作" | 是（本待办默认） | 待确认 |
| **8** | **超时默认行为** | **默认进入暂停（非终止）** | **已定（A4 修复）** |
| **9** | **暂停状态的持久化位置** | **`<productionsRoot>/pause-state.json`** | **已定（A4 修复）** |

### 10.1 审批分级超时细节（第 5 点展开）

| 等级 | 触发条件 | 超时 | 超时行为 |
|---|---|---|---|
| **L1 轻量** | 质量审核连续 2 次不通过 | **10 分钟** | 超时自动继续（异步通知，不阻塞） |
| **L2 标准** | `retry_count` 达上限、Token 超硬阈值 | 30 分钟 | 超时降级到 L3（升级人工） |
| **L3 紧急** | 安全策略违规、跨角色死锁 | 无超时 | 同步阻塞 + 告警，等待人工介入 |

**规范补充**：

| # | 规范 |
|---|---|
| R42 | L1 审批超时自动继续；L2 超时升级到 L3；L3 无超时（阻塞到人工介入） |
| R43 | 每级审批的超时行为必须写入 RunLedger（可审计） |

### 10.2 暂停机制细节（第 8/9 点展开）

| 机制 | 语义 | 触发方式 | 已完成任务 | 可恢复 |
|---|---|---|---|---|
| **STOP** | 终止 | 创建 STOP 文件 | 保留 | ❌ |
| **PAUSE（用户）** | 暂停 | 创建 PAUSE 文件 | 保留 | ✅ 创建 RESUME 恢复 |
| **PAUSE（超时）** | 暂停 | `totalTimeoutMs` 触发 | 保留 | ✅ 创建 RESUME 恢复 |
| **单步超时** | 警告 | `stepTimeoutMs` 触发 | 保留 | 不改变状态 |

**用户操作**：

| 操作 | 命令 |
|---|---|
| 主动暂停 | `New-Item productions\PAUSE` |
| 恢复 | `New-Item productions\RESUME` |
| 终止 | `New-Item productions\STOP` |
| 查看暂停状态 | `Get-Content productions\pause-state.json` |

**配置优先级**：代码 > 配置文件 > 环境变量 > 默认

---

## 十一、验收人可视化

| 通道 | 内容 |
|---|---|
| 终端视图 | 扩展：消息流 + handoff 追溯 + Token 分账 + 恢复点 + **暂停状态** |
| HTML 报告 | 扩展：消息流 section + 分账表 + 恢复点标记 + **暂停时间线** |
| CLI 新命令 | `weave_graph_trace` / `weave_graph_restore` / `weave_graph_messages` / **`weave_chain_status`（暂停状态）** |
| 一键脚本 | `test-env/verify-mvp3.ps1`（12+ 项检查，含暂停/恢复） |
| 进度观测 | `Get-ChildItem productions\traces\graph-*.jsonl \| Get-Content -Wait` |
| 暂停观测 | `Get-Content productions\pause-state.json`（暂停原因 + 进度 + nextRoleId） |

---

## 十二、下一步

**立即做（今天）**：

1. 修 **P3.0.4（A4 暂停机制）** + **P3.0.7（NEW-1 深层原型污染）** + **P3.0.16（NEW-10 currentRole）**—— 约 1.8d
2. 用 mock 模式完成 MVP-2 可视化验收（避开 S13）

**MVP-3 动工前**：

1. 完成 Phase 0 的 17 个任务（~6.7d）
2. 通过 G0 门禁（8 项，含新增的暂停/超时可配置验证）
3. 决策 §十 的 9 项（第 5/8/9 点已定）

**然后**：按 Phase A → B → C → D → E → F 顺序推进，每个 Phase 有独立门禁，未过不推进。