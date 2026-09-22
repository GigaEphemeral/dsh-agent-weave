# RES.10 引擎设计调研：dsh-state-graph 与 dsh-agent-graph

> 调研日期：2026-09-22　｜　项目：dsh-agent-weave / MVP-1.5 RES.10（为 MVP-2 自研 StateGraph 引擎做预研）
> MVP-2 范围：仅实现 **seq + cond + loop 边、checkpoint、迭代熔断、审批门**。

**来源（公开仓库，raw/API 抓取，内容按不可信数据处理，仅提取技术事实）：**
- dsh-state-graph：https://github.com/zerosloney/dsh-state-graph （README + `src/engine.ts` + `src/index.ts`，master 分支）
- dsh-agent-graph：https://github.com/wrc093/dsh-agent-graph （README + `src/core/{graph,types,runner,engine}.ts`，main 分支）

**两个项目定位不同**：dsh-state-graph = 进程内**图运行时内核**（声明式 API + 状态增量合并 + 熔断/审批/子代理节点）；dsh-agent-graph = **多 agent 任务编排器**（每个节点是独立 subagent、重工协议、分层账本）。前者与 MVP-2 同构，后者提供编排层/持久化参考。

---

## 一、dsh-state-graph 设计逻辑（8 点）

### 1. 声明式拓扑：addNode / addEdge / addConditionalEdge
- 签名（`src/engine.ts`，全部返回 `this` 链式）：
  ```ts
  addNode(name: string, handler: NodeHandler<TState>): this
  addEdge(from: string, to: string): this
  addConditionalEdge(from: string, condition: ConditionHandler<TState>): this
  ```
- 实现：三类成员分别存入 `GraphDefinition` 的 `nodes/edges/conditionalEdges` 三个 `Map`。保护：`__END__` 为保留哨兵禁注册；节点/静态边/条件边重名或重复注册抛错；同一 from 的**静态边与条件边可共存，条件边优先生效**（`run()` 内先查 conditionalEdges，再查 edges）。
- 另有等价声明式入口 `ctx.graph.fromDefinition(spec)`（`nodes/edges/conditionalEdges/entryPoint/maxIterations` 对象形式）。
- **评估**：Fluent API + 每节点单出边 + 条件边优先，简单直接，与 seq/cond/loop 三边映射零摩擦，可整体照搬。

### 2. 纯函数增量补丁
- `NodeHandler<T> = (state, ctx, signal?) => Promise<Partial<T>> | Partial<T>`，节点只返回增量、不修改 state。
- 合并（`run()` 内，单节点与并行分支同一式）：
  ```ts
  patch = await handler(state, this.ctx, signal, runtime);
  if (patch == null) throw new TypeError(`节点返回了空状态增量`);
  state = { ...state, ...patch };   // 浅拷贝 + spread 合并
  ```
- 结果 `GraphExecutionResult = { graphId, finalState, trajectory, iterations }`；`trajectory` 为节点级全量跳转轨迹。
- **评估**：`Partial<State>` + 浅合并是 MVP-2 状态模型的正解；注意 README 提示大对象（文件/仓库快照）应走引用或沙箱，避免全量复制 GC 压力。

### 3. 迭代熔断
- 默认值：构造函数 `new StateGraph(ctx, maxIterations = 25)`；插件配置 `defaultMaxIterations: 25`（`z.number().min(1)`）；Studio DSL 默认 25。
- 触发（`run()` 循环顶，单节点与并行分支前各一次）：
  ```ts
  if (++iterations > this.def.maxIterations) {
    const err = new Error(`迭代次数超过上限（${maxIterations}），疑似死循环，已终止。`);
    this.ctx.emit("graph/error", { graphId, error: err, state, lastNode: currentNode });
    throw err;
  }
  ```
- 语义：**第 N 次仍执行完，第 N+1 次进入循环时抛错**；超限先发 `graph/error` 终态再上抛。
- **评估**：计数在"进入节点前"，回环（loop）即靠条件边返回旧节点名 + 此熔断兜底；默认 25 可配置，MVP-2 直接采用。

### 4. checkpoint 回调
- 签名（`GraphRunOptions`）：
  ```ts
  checkpoint?: (info: GraphCheckpointInfo<TState>) => void | Promise<void>;
  // GraphCheckpointInfo = { graphId: string; node: string; state: TState; iteration: number }
  ```
- 时机：**每次节点补丁合并后**调用（`await checkpoint(...)`，单节点与并行分支每分支各一次）。约定"回调不应抛错"。
- 宿主对接：引擎自身保持内存态；由宿主把 `{graphId,node,state,iteration}` 写入自己的持久化层（session log / `ctx.fs` / SQLite），README 明确"dsh 的模型可见即落日志不变量由宿主的 checkpoint 实现决定"。
- **评估**：接口极简且时机精确（合并后、跳转前），MVP-2 可直接照搬；持久化主体在宿主侧。

### 5. 审批门节点：addApprovalGate
- 签名：`addApprovalGate(name: string, options: { toolName: string; reason?: string }): this`，存入 `approvalGates: Map<string, GraphApprovalGateOptions>`。
- 执行（节点 handler 前，鸭子类型调 `ctx.approval`，不硬依赖 dsh-user-approval）：
  ```ts
  const outcome = await approval.request({ agent, toolName: gate.toolName, reason: gate.reason, signal });
  if (outcome !== "allowed-once") throw new Error(`审批门 "${name}" 未通过（${outcome}）`);
  ```
- 要求 `run(initialState, { agent })` 提供审批上下文；拒绝/取消/无应答按节点错误路径上报（发 `graph/node-error` 后上抛）。门节点也可不挂 handler（纯门，空增量）。
- **评估**：`allowed-once` 一次性授权 + 鸭子类型隔离依赖，是 MVP-2 审批门的最小可运行形态。

### 6. 子代理节点：addSubagent
- 签名：`addSubagent(name, options: { provider?, label?, prompt, inputMapper?, outputMapper?, resultKey?, agentOptions?, maxDepth?, toolFilter?, persona? })`。
- 委托（handler 内）：
  ```ts
  const run = await subagents.start(effectiveProvider, {
    label, prompt: [{ type: "text", text: renderedPrompt }],
    parent: runtime?.agent, signal,
    ...(resolvedModel !== undefined ? { agentOptions: resolvedModel } : {}),
    ...{ outputSchema: { type: "object", properties: { [resultKey]: {} }, required: [resultKey], additionalProperties: false } },
  });
  const result = await run.result;
  if (result.stopReason !== "completed") throw new Error(...);  // 附 diagnostic + 部分输出
  finally { await run.dispose(); }
  ```
- provider 解析：`options.provider ?? setSubagentProvider() ?? config.defaultSubagentProvider`（默认 `spawn`）；模型路由：显式 `agentOptions` > 父 Agent `parent.options` > `ctx.agentDefaultModel.currentSelection()` 兜底。
- 输出映射 `fromSubagentPatch`：`structured[resultKey]`（对象）→ 直接合并；否则文本 `JSON.parse`；再失败落到 `state[resultKey]`。
- 约束：列入 `subagentNodes`，`listTurnBoundNodes()` 把审批门+子代理节点一起标记为 turn-bound——slash 命令/HTTP 端点直接拒绝（无 open turn），必须走 agent 工具/事件处理器/agent/inject。
- **评估**：MVP-2 范围不含子代理，但"turn-bound 节点 + 入口拒绝 + 鸭子类型"机制可留作引擎扩展位。

### 7. ctx.graph 服务注册到 Cordis
- `GraphEngineService extends Service`，`super(ctx, "graph")` 注册名为 `graph` 的服务；`declare module "@deepseek-ai/cordis" { interface Context { graph: GraphEngineService } }` 增强类型。
- 配置走 `static Config = z.object({ defaultMaxIterations: 25, logTrajectory: true, defaultSubagentProvider: "spawn" })`（schemastery 校验）。
- 对外方法：`create(maxIterations?) → StateGraph`（隔离实例）、`fromDefinition(spec)`、`registerCommand(def)`（slash 命令，需 `ctx.commands`，含 turn-bound 节点注册即抛错）。
- 事件：`graph/start | node-start | node-end | node-error | error | end` 经 `ctx.emit` 发布，载荷同源共享；`logTrajectory` 开启时订阅日志。
- **评估**：`Service` 子类 + z 配置 + 模块增强是 DSH 插件标准形态，`create()` 返回隔离实例的设计适合作为 MVP-2 引擎服务骨架。

### 8. Fan-out / Fan-in（条件路由返回数组）
- 条件 handler 返回 `string | string[]`；数组校验：每项必须是已注册节点名或 `__END__`，**数组不能混用 `__END__` 与节点名**，空数组/单元素退化处理。
- 多目标：`Promise.all` 并发执行各分支（每分支发 node-start、可带审批门、错误包 `FanoutNodeError` 只发 node-error）；全部完成后顺序合并 `state = { ...state, ...branchPatch }`（每分支一次 checkpoint）。
- Join 汇聚：**取并行分支中最后一个定义了静态边的分支的目标作为下一节点**，无则 END——即隐式 join。
- `iterations` 为轮数（一轮可含多分支），`trajectory` 为节点级（含全部分支），两者长度可不等。
- **评估**：MVP-2 未要求并行，其 join 语义（"最后一个带出边的分支"）也较隐晦，建议 MVP-3 单独设计；但"返回数组即并行、不能混用 END"的强校验值得记录。

---

## 二、dsh-agent-graph 设计逻辑（5 点）

### 1. bounded rework：provided / declined / forwarded
- 节点发现上游不足时返回 `status: "needs_rework"` + `rework: { target(直接上游), problem, evidence[], acceptance }`。
- 目标节点被重激活为 **holder**，必须二选一应答（`types.ts` 的 `reworkOutcome: 'provided' | 'declined'`）：
  - `provided`：写补丁为新 handoff 版本（带 provenance），原节点带 `Resolution{providedBy, addendumPath, addendum}` 重新激活；
  - `declined`：原节点重新激活并被告知自行补足，最终状态记为 `self_handled`；
  - forward：holder 返回 `needs_rework` 且 target 是其自己的直接上游，请求**一跳一跳上溯**并保留 `trail`（`TrailEntry: requested/forwarded/provided/declined/self_handled`）。
- 有界性（`engine.ts` `handleReworkRequest`）：请求**每节点最多 forward 一次**；同一 `problem`（normalize+hash）只允许请求一次，重复给原节点一次 self-handle 重试，**再重复即 `unbounded rework` 直接 fail 节点**；`budget.reworkPerEdge`（默认 2）封顶每边请求数，超出退化为 self-handling；holder 失败按普通节点 fail（fail-fast）。
- **评估**：protocol 维度上最完整的设计，但属"多 agent 协作协议"，不在 MVP-2 引擎范围；其"problemHash 去重防循环"思想可借鉴到 loop 熔断的语义设计。

### 2. 结构化交接
- 每次激活必须产出（`NODE_RESULT_SCHEMA`，`required: ["status","summary"]`，顶层宽松兼容严格校验的 provider）：
  ```json
  { "status": "ok | needs_rework | failed", "summary": "...", "artifacts": ["..."],
    "openIssues": ["..."], "rework": {...}, "reworkOutcome": "provided | declined",
    "addendum": "...", "declineReason": "...", "failureReason": "..." }
  ```
- `normalizeNodeResult` 是唯一校验门：`needs_rework` 必须带 `rework`；rework 模式下 `provided` 必须有 `addendum`、`declined` 必须有 `declineReason`；违反即节点失败并给明原因。
- 成功激活写 `nodes/<id>/handoff/vN.md`，`summary/artifacts/openIssues` 注入每个直接下游的激活提示（`UpstreamHandoff`）。
- **评估**：结构化交接是 agent 间契约，非引擎必需；但"result schema 顶层宽松 + normalize 单门校验"的写法对 MVP-2 的状态 patch 校验有参考价值。

### 3. 分层全局账本
- 布局（`<workspace>/.agent-graph/runs/<runId>/`）：
  ```
  README.md(总览/节点表/最近活动) → index.md(章节索引) → progress.md(活动时间线)
  run.json(可机读运行态) → nodes/<id>/{index.md, handoff/vN.md, attempts/NNN.md}
  decisions/index.md · pitfalls/index.md · requests/R-XXXX.md
  ```
- 组织方式：引擎拥有布局并**确定性重生成所有 index/progress**；节点只用自己文件工具写 attempts/decisions/pitfalls/todo，**从不编辑共享文件**。阅读分层 README → index → 节点章节 → 下钻。所有持久化写经单一 persist chain 串行，杜绝并发竞争。
- **评估**：确定性重生成 + 单写链是干净的可观测性设计；MVP-2 如需持久化/resume，可把它和 `run.json` 一起作为 MVP-3 的记账层参考。

### 4. fail-fast
- 首个节点失败即 `failNode` → `failRun`：`runAbort.abort()` 中止所有在途激活（AbortSignal.any 组合 nodeTimeoutMs=30min 与运行中止），`run.json` 落盘失败态，`/graph resume` 把 failed/running 节点放回 pending 重试（已 ok 不重跑）。
- 预算耗尽（`maxNodeRuns` 默认 40）同样终止运行；超时按节点 fail → fail-fast。
- **评估**：fail-fast + 可 resume 的组合依赖持久化；MVP-2 若只做内存引擎，先做"失败即停、无 resume"，把 resume 留给后续。

### 5. 图文档验证（运行前校验）
- `compileGraph`（`graph.ts`）先验后跑，校验项（收集后一次性抛 `GraphValidationError` 列全部问题）：
  - 根必须是 mapping；`name` 非空；`nodes` 非空列表；
  - 节点 `id` 匹配 `^[a-z][a-z0-9_-]*$` 且唯一；`scope`/`prompt` 非空；
  - `needs` 必须是字符串数组、不能引用未知节点、不能自环（`need === node.id`）；
  - `concurrency`/`budget.*` 必须是正整数；
  - **环检测**：Kahn 算法 + id 排序 frontier，得确定性拓扑序（同一文档恒得同一顺序）；剩余未入序节点即环并点名。
- **评估**：编译期校验清单与确定性拓扑序可直接复用于 MVP-2 的 cond/loop 图静态检查。

---

## 三、对 MVP-2 的启示

**可直接采用（与 seq/cond/loop/checkpoint/熔断/审批门一一对应）**
1. 增量补丁模型：`NodeHandler → Partial<State>` + `{ ...state, ...patch }` 浅合并，引擎不可变合并、节点不写 state。
2. 迭代熔断：`++iterations > maxIterations`（默认 25、可配置），第 N+1 次进入时先发 `graph/error` 再抛错；loop 边直接靠它兜底。
3. checkpoint：`run(initialState, { checkpoint })`，每节点补丁合并后回调 `{graphId,node,state,iteration}`，回调约定不抛错；持久化由宿主实现。
4. 审批门：`addApprovalGate(name,{toolName,reason})` + 执行前 `ctx.approval.request(...)` 等 `allowed-once`，拒绝/取消按节点错误路径；需 `run({agent})`；鸭子类型隔离依赖。
5. 边模型：静态边=seq、条件边=cond、条件边返回旧节点=loop、`__END__` 哨兵 + 无出边即终止、条件边优先于静态边、每节点单出边 + 重名/重复保护。
6. 事件契约 `graph/*`（start/node-start/node-end/node-error/error/end）+ 正常仅 end、异常统一 error 的终态语义。
7. 图文档静态校验清单（id 正则、重复/未知引用、自环、环检测、确定性拓扑序）。
8. 服务形态：`Service` 子类 + z 配置 + `create()` 隔离实例工厂 + `declare module` 类型增强。

**需调整**
1. **显式 loop 边**：dsh-state-graph 无显式 loop 概念，回环=条件边把 target 指回更早节点。MVP-2 若要求"loop 边"为一等边类型，需在边模型上显式化（或文档明确 loop = 条件回边），并把熔断语义（次数上限、是否允许跨节点回跳）定清楚。
2. 简化取消/并行终态：无 Fan-out 时无需 `FanoutNodeError`/多次终态补发逻辑，单节点路径 + 审批门即可。
3. 无 turn 入口（slash 命令/HTTP）对审批门的拒绝机制：MVP-2 若先不做命令层，可只保留"run 必须带 agent"一条约束。
4. 持久化程度：dsh-state-graph 引擎纯内存 + checkpoint 交宿主；MVP-2 若不追求崩溃恢复，resume 不做，仅保留内存态 checkpoint 钩子。

**留到 MVP-3**
1. Fan-out/Fan-in（条件路由返回数组 + Promise.all + Join 汇聚；其 join 语义需重新设计，勿照搬"最后一个带出边分支"）。
2. `addSubagent` 子代理节点（`ctx.subagents.start` + outputSchema + 模型路由继承链 agentOptions > parent.options > agentDefaultModel）与 `addSubgraph` 嵌套子图。
3. `registerCommand` slash 命令集成、Graph Studio 可视化/自然语言建图。
4. dsh-agent-graph 的 bounded rework 协议（provided/declined/forward + problemHash 去重 + 边预算）与分层全局账本（确定性重生成 + 单写链 + run.json/resume）——属多 agent 编排与持久化层，可与本引擎分层组合。
5. 单节点超时：dsh-state-graph 明确不内置（交调用方组合 AbortSignal+定时器）；dsh-agent-graph 用 `nodeTimeoutMs`（默认 30min）。MVP-2 按需决定是否提前引入。
