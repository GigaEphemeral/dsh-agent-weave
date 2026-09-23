# MVP-3 Phase A 后实测问题诊断与处理方案

先分类：**3 个立即修**（今天）、**2 个 Phase A 补全**（本周）、**1 个规划项**（MVP-3 内）。

---

## 问题 1：为什么还要命令调图配置 + harness 重复注册角色

**诊断**：你把两个不同生命周期的事混在一起了，需要澄清。

| 环节 | 触发时机 | 频率 | 为什么不能"一次搞定" |
|---|---|---|---|
| **角色注册**（YAML → SubagentProvider） | 插件 `apply()` | 插件加载时**一次** | 已是一次性，不需要重复 |
| **图配置加载**（YAML → GraphDefinitionSpec → 引擎） | 每次执行 | **每次** | 用户可能随时改 YAML；执行前需重新校验（静态验证器）；每次执行是新实例 |
| **子代理启动**（`ctx.subagents.start`） | 每个节点 | 每节点**每次** | 每次都是新 session（记忆隔离的代价） |

**你说的"重复注册角色"实际是**：`index.ts` 的 `apply()` 里有 `tryRegisterRoles()` **轮询等待 spawn provider**（最多 5s）。当 spawn provider 就绪慢时，你会看到**多次尝试注册**的日志——不是真重复，是等待。

**结论**：角色注册确实是一次性，你看到的"重复"是等待日志。**图配置每次加载是设计**（因为 YAML 可变、需校验、要新实例）。**但入口设计错了**——见问题 2。

---

## 问题 2：用什么命令让用户直接用图分配任务（核心）

**诊断**：当前**根本没有"跑真实图的入口"**。Phase A 加了 `addSubagent`，但只被 `state-graph` 内部用，对外暴露的入口只有：

- `weave_run_chain` —— **硬编码 R1→R8 固定链**（不是用户定义的图）
- `weave_graph_watch` / `weave_graph_report` —— **mock 执行**（不接真实子代理）

**所以你现在的处境是**：真实子代理能力已就绪，但**没有"读用户 YAML 图 → 用真实子代理执行"的工具**。

**这不是 MVP-6 的事，是 Phase A 收口的缺口**。需要新增：

```
weave_run_graph 工具
  参数：path（图 YAML 路径）、user_input、agent（由 exec 注入）
  流程：
    ① loadGraphSpec(path) → GraphDefinitionSpec
    ② validateGraph（静态校验）
    ③ createStateGraph(ctx, maxIter, concurrency, artifactsRoot)
    ④ 遍历 spec.nodes：
        role 节点 → graph.addSubagent(node.id, { provider: node.roleRef, ... })
        condition/approval → 同 mock 逻辑
    ⑤ 遍历 spec.edges：seq/loop/cond 同 graph-service.fromDefinition
    ⑥ graph.run(initialState, { checkpoint, graphVersion, graphSchemaHash, agent })
    ⑦ 返回执行结果 + trace 路径
```

**好处**：
- 用户在 Web chat 说一句"跑 `workflows/mvp2-loop-demo.yaml`" → 直接真实执行
- 图 DSL 是用户的（可编辑），不是硬编码
- 这就是"用图的工具来分配任务"的最终形态

**建议**：作为 **Phase A 收口的最后一项**（P3.A.4），预估 1d。

---

## 问题 3：日志时间是 UTC（应立即修）

**诊断**：`chain-runner.ts` 用 `new Date().toISOString()` → 永远 UTC。

**修复**（0.2d）：

```typescript
// chain-runner.ts：chainLog 内
const now = new Date()
const entry = {
  // 东八区 ISO 8601 带偏移（如 2026-09-23T18:30:00.000+08:00）
  time: new Date(now.getTime() + 8 * 3600 * 1000)
    .toISOString()
    .replace('Z', '+08:00'),
  // 也可加本地可读字段
  time_local: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
  level,
  msg,
  ...(data ?? {}),
}
```

**同样要改的地方**：
- `state-graph.ts` 的 `TrajectoryEvent.timestamp`（当前是 epoch ms，**内部统一用 epoch**，只在展示时转时区）
- `terminal-view.ts` 的 `formatTime`（当前是相对图开始的 mm:ss，**语义对**，不需改）
- `html-report.ts` 的 `formatRel`（同上）

**规范**（加进 R 系列）：
> R44：**内部时间统一 epoch ms；展示层才转时区**。日志时间戳用东八区 ISO 8601 带偏移。

---

## 问题 4：产物落到 3pluginCode 而非用户 workspace（应立即修，FIX.6 契约违反）

**诊断**：`chain-runner.ts` 和 `chain-tool.ts` 都用：

```typescript
productionsRoot = join(process.cwd(), 'productions')
```

`process.cwd()` 是 **DSH 进程启动目录**（`3pluginCode`），不是**用户会话工作区**（`测试工作区\MVP-2-stock`）。**这正是 FIX.6 契约明确禁止的**。

**修复**（0.5d）：

需要从 `ToolRunContext` 或 `ctx` 取会话工作区。DSH 的 `ToolRunContext` 通常有 `workspace` 或 `cwd` 字段。**先确认 API**：

```powershell
# 探测 ToolRunContext 的字段
Select-String -Path "$env:DSH_HOME\profiles\weave-test\node_modules\@deepseek-ai\dsh-tools\lib\*.d.ts" -Pattern "workspace|cwd|workingDir" | Select-Object -First 10
```

**修复路径**（假设 API 为 `exec.workspace`）：

```typescript
// chain-tool.ts
export async function executeChain(ctx, exec, userInput, productionsRoot?) {
  const parent = exec.agent
  // FIX.6：优先用会话工作区，其次显式传入，最后兜底 cwd
  const root = productionsRoot
    ?? (exec as { workspace?: string }).workspace
    ?? join(process.cwd(), 'productions')
  // ...
}
```

**同样要改**：
- `chain-runner.ts` 的 `runChain` 默认参数
- `graph-visual-commands.ts` 的 `artifactsRoot()` —— 同样用 `process.cwd()`

**规范**（强化 R45）：
> R45：**禁止 `process.cwd()` 作为产物根**。产物根优先级：显式参数 > `exec.workspace` > `ctx` 会话工作区 > 兜底。

---

## 问题 5：只看得到"在工作"，看不到"在干什么"（**核心体验问题**）

**诊断**：当前 `chain.log` 只有：
- 阶段开始
- 心跳（每 10s "仍在执行"）
- 阶段完成

**看不到**：节点内部在干什么（搜文件？调接口？写代码？）

**根因**：`chain-runner` 只订阅了 `ctx.subagents.start()` 的 `run.result`（最终结果），**没有订阅子代理 session 内部的事件流**。

**解决思路**（有 3 条通道）：

### 通道 A：订阅 DSH 全局工具事件（推荐）

DSH 有全局事件总线。子代理执行时的工具调用会发 `tool/call` / `tool/result` 事件。`chain-runner` 可以订阅：

```typescript
// 伪代码
const dispose = ctx.on('tool/call', (evt) => {
  if (evt.sessionId !== currentChildId) return  // 只关心当前节点
  chainLog(productionsRoot, 'info', `节点活动: ${evt.toolName}`, {
    role_id: step.roleId,
    tool: evt.toolName,
    args_preview: truncate(JSON.stringify(evt.args), 100),
  })
})
```

**先确认 API**：

```powershell
Select-String -Path "$env:DSH_HOME\profiles\weave-test\node_modules\@deepseek-ai\dsh-base\lib\*.d.ts" -Pattern "tool/call|tool/result|session/event" | Select-Object -First 10
```

### 通道 B：读子代理 session 日志（更完整但有延迟）

子代理的 session 会记录所有事件（LLM 请求、工具调用、工具结果）。执行中可以**轮询**该 session 文件的新增行：

```typescript
// 心跳循环里，同时 tail 子代理 session
const sessionFile = findSessionFile(currentChildId)
const lastPos = { value: 0 }
const activityWatcher = setInterval(() => {
  const newLines = tailFile(sessionFile, lastPos.value)
  for (const line of newLines) {
    const evt = JSON.parse(line)
    if (evt.type === 'tool/call') {
      chainLog(productionsRoot, 'info', `🔧 ${step.roleId} 调用 ${evt.toolName}`, {
        preview: truncate(JSON.stringify(evt.args), 200),
      })
    }
    if (evt.type === 'assistant/message') {
      chainLog(productionsRoot, 'info', `💭 ${step.roleId} 思考中`, {
        tokens: evt.data.usage?.outputTokens,
      })
    }
  }
  lastPos.value = /* 新位置 */
}, 2000)
```

**优点**：信息最全（思考、工具调用、结果都有）
**缺点**：有延迟（session 落盘后）

### 通道 C：让子代理主动上报（需改 prompt）

在角色的 prompt 里加"每步输出当前动作"：

```
【行为约束】
- 每次调用工具前，先输出一行："[动作] 正在 <做什么>（工具: <toolName>）"
- 例如："[动作] 正在搜索 ETF 相关文件（工具: glob）"
```

**优点**：实时（流式输出就可见）
**缺点**：占用 token；模型不一定遵守；不适合严格场景

### 推荐组合

**A + C**：
- A（全局事件订阅）覆盖工具调用
- C（prompt 要求）覆盖"思考"和"意图"

**落地为 Phase A 补全项 P3.A.5**（预估 1.5d）：
1. 探测 DSH 事件 API（0.5d）
2. 在 `chain-runner` 的 `start()` 前后订阅/退订子代理事件（0.5d）
3. 事件转成人类可读的 activity 行写入 `chain.log`（0.5d）

**输出形态**：

```
[2026-09-23T18:30:15.123+08:00] 阶段开始：开发实现（R6-developer）
[2026-09-23T18:30:16.456+08:00] 💭 R6-developer 思考中（输入 1500 tok）
[2026-09-23T18:30:18.789+08:00] 🔧 R6-developer 调用 glob（搜索 *.py）
[2026-09-23T18:30:19.012+08:00] ✓ glob 返回 5 个文件
[2026-09-23T18:30:22.345+08:00] 🔧 R6-developer 调用 read（读取 design.md）
[2026-09-23T18:30:25.678+08:00] 💭 R6-developer 思考中（输出 3000 tok）
[2026-09-23T18:30:28.901+08:00] 🔧 R6-developer 调用 write（backend.py）
[2026-09-23T18:31:15.234+08:00] 心跳：开发实现 仍在执行（已 60s，当前活动：write backend.py）
[2026-09-23T18:33:45.567+08:00] 阶段完成：开发实现（stop_reason: completed，输出 12000 字符）
```

这样你就能判断：
- 在正常工作：有连续工具调用 + 有输出
- 卡死了：心跳时"当前活动"不变，超过 5 分钟可叫停
- 跑偏了：工具调用不符合角色职责（如 R1 在写代码）

---

## 处理优先级与产出

| # | 问题 | 类型 | 预估 | 优先级 |
|---|---|---|---|---|
| 3 | 时区修复 | 立即修 | 0.2d | 🔴 P0 |
| 4 | workspace 路径（FIX.6） | 立即修 | 0.5d | 🔴 P0 |
| 2 | `weave_run_graph` 工具 | Phase A 补全 | 1.0d | 🔴 P0 |
| 5 | 节点粒度活动日志 | Phase A 补全 | 1.5d | 🟡 P1 |
| 1 | 澄清注册/加载概念 | 文档 | 0.1d | 🟢 已答 |
| — | 需要预研 | 事件 API 探测 | 0.5d | 🔴 P0（P5 前置） |

**合计**：~3.8d（含预研）

---

## 需要你确认的三件事

1. **`weave_run_graph` 的语义**：是"跑图 DSL 定义的图"，还是"跑单链"？
   - 我理解是前者（你已经有 YAML 图），**请确认**。

2. **节点活动日志的粒度**：
   - 只记工具名 + 参数摘要（通道 A，轻量）
   - 还是也要"思考内容"（通道 C，重 token）
   - **建议 A + C 结合**，你接受吗？

3. **产物根**：
   - 用 `exec.workspace`（会话工作区）
   - 还是在图 YAML 里加 `artifactsRoot` 字段让用户显式指定
   - **建议两者都支持**：YAML 优先，其次 exec.workspace

---

## 下一步动作

**今天先做**：
```powershell
# 1. 探测 workspace API + 事件 API
cd D:\dsharness\agentDev\softwareEngnieering\3pluginCode
Select-String -Path "$env:DSH_HOME\profiles\weave-test\node_modules\@deepseek-ai\dsh-tools\lib\*.d.ts" -Pattern "workspace|cwd|workingDir" | Select-Object -First 5
Select-String -Path "$env:DSH_HOME\profiles\weave-test\node_modules\@deepseek-ai\dsh-base\lib\*.d.ts" -Pattern "tool/call|session/event" | Select-Object -First 5

# 2. 时区修复（改动最小，10 分钟）
# 编辑 src/l2-engine/chain-runner.ts: chainLog 的 time 字段

# 3. workspace 路径修复（依赖 1 的探测结果）
```

**确认上面三个问题后**，我可以按顺序给出精确的代码修改清单：
1. `chain-runner.ts`（时区 + workspace + 活动日志订阅）
2. `chain-tool.ts`（workspace + 调用新工具）
3. `graph-visual-commands.ts`（artifactsRoot 用 workspace）
4. 新增 `weave_run_graph` 工具（`src/cli/graph-run-commands.ts`）
5. 更新 `R44/R45` 规范 + Phase A 补全任务（P3.A.4/P3.A.5）

**先告诉我**：
- `weave_run_graph` 的语义（问题 2）
- 节点日志粒度接受 A+C 吗（问题 5）
- workspace 的获取方式（问题 4）

任一不确定，我也可以先帮你**探测 API**，再给精确方案。