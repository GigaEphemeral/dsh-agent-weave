# dsh-state-graph

把 **StateGraph 有向状态图编排引擎**移植为 **DeepSeek Harness (dsh) 插件**：用声明式的节点 / 静态边 / 条件边把 Harness 单向线性的 ReAct 调度提升为支持多分支条件路由、循环重试与迭代熔断的图编排运行时（子图嵌套可经 `addSubgraph` 或节点内调用 `ctx.graph.create()` 组合实现；并行分支 Fan-out / Fan-in 已内置）。

```text
addNode / addEdge / addConditionalEdge → 纯函数增量补丁 → 迭代熔断 → 轨迹事件流
```

## 这是什么

`dsh-state-graph` 是一个 **dsh bundle 包**：导出一个 cordis 插件（`state-graph`），提供 `ctx.graph` 服务。插件的核心是设计文档《状态图（StateGraph）编排引擎技术方案与架构设计》中的有向状态图运行时内核：

| 能力 | 落点 |
| --- | --- |
| 声明式拓扑构造（Fluent API：addNode / addEdge / addConditionalEdge） | `StateGraph` |
| 声明式图定义（`GraphDefinitionSpec`，配置驱动 / 命令集成） | `ctx.graph.fromDefinition()` |
| 纯函数增量补丁：节点只返回 `Partial<State>`，引擎不可变合并 | `StateGraph.run` |
| 防死循环熔断（默认 25 次迭代，超限抛错） | `StateGraph` 内置 |
| 并行分支 Fan-out / Fan-in（条件路由返回目标数组，join 汇聚） | `StateGraph.run` |
| 双向事件流观测（`graph/*` 事件，追加式轨迹） | `ctx.emit` 事件总线 |
| 节点级 checkpoint 回调（宿主可接 dsh 持久化） | `StateGraph.run` |
| 审批门节点（执行前请求 `ctx.approval` 一次性授权） | `StateGraph.addApprovalGate` |
| dsh slash 命令集成（图直接注册为命令） | `ctx.graph.registerCommand()` |
| 隔离的状态图实例工厂 | `ctx.graph.create()` |
| **子代理节点（节点委托给真实 dsh 子代理）** | `StateGraph.addSubagent` |

## 核心接口

| 接口 / 类型 | 签名 | 说明 |
| --- | --- | --- |
| `NodeHandler<T>` | `(state: T, ctx: Context, signal?: AbortSignal) => Promise<Partial<T>> \| Partial<T>` | 节点业务执行体，返回需合并的状态增量；第二参数仍为 `ctx`，第三参数接收本次运行的取消信号 |
| `ConditionHandler<T>` | `(state: T, ctx: Context, signal?: AbortSignal) => string \| string[] \| Promise<string \| string[]>` | 动态路由，返回下一个 NodeName、并行目标数组或 `"__END__"`；第二参数仍为 `ctx`，第三参数接收本次运行的取消信号 |
| `GraphExecutionResult<T>` | `{ graphId: string; finalState: T; trajectory: string[]; iterations: number }` | 每次执行的 graphId（区分重复/并发轨迹）、最终状态、全量跳转轨迹、迭代次数 |
| `ctx.graph.create<T>(maxIterations?)` | → `StateGraph<T>` | 创建隔离的图实例 |
| `ctx.graph.fromDefinition<T>(spec)` | → `StateGraph<T>` | 从声明式定义构建图（与链式 API 等价） |
| `ctx.graph.registerCommand<T>(def)` | → `() => void` | 把图注册为 dsh slash 命令（需 `ctx.commands`），返回注销函数 |
| `StateGraph.addApprovalGate(name, options)` | → `this` | 注册审批门：执行前请求 `ctx.approval` 一次性授权 |
| `StateGraph.addSubagent(name, options)` | → `this` | 注册子代理节点：执行时经 `ctx.subagents.start(provider, …)` 委托给真实 dsh 子代理，输出映射回父状态 |
| `StateGraph.setSubagentProvider(provider)` | → `this` | 设置本图子代理节点的默认 provider 名（未在 `addSubagent` 显式指定时生效） |
| `GraphRunOptions` | `{ signal?, agent?, checkpoint? }` | `agent` 供审批门透传与子代理节点作为父 Agent；`checkpoint` 每次节点合并后回调 |

一次运行可通过 `run(initialState, { signal })` 传入 `AbortSignal`；不传第二参数时保持原有调用方式。引擎会在节点执行、节点结果合并、条件路由以及跳转边界检查取消状态，并把同一个 signal 作为 `NodeHandler` / `ConditionHandler` 的第三参数传入。

`checkpoint` 回调在每次节点补丁合并后调用（载荷 `{ graphId, node, state, iteration }`），适合把状态快照写入 dsh 持久化（session log / `ctx.fs` 由宿主决定）；回调不应抛错。`agent` 仅在存在审批门节点时需要（透传给 `ctx.approval.request`）。

### 事件（`ctx.on("graph/…")` 订阅）

| 事件 | 载荷 | 时机 |
| --- | --- | --- |
| `graph/start` | `{ graphId, initialState, entryPoint }` | 图开始执行 |
| `graph/node-start` | `{ graphId, node, state, iteration }` | 每个节点执行前 |
| `graph/node-end` | `{ graphId, node, state }` | 节点补丁合并后 |
| `graph/node-error` | `{ graphId, node, error }` | 节点抛错或被取消中断（随后上抛；取消还会补发 `graph/error`） |
| `graph/error` | `{ graphId, error, state, lastNode }` | 迭代熔断 / 目标节点缺失 / 路由抛错 / 取消（`graph/start` 之后） |
| `graph/end` | `{ graphId, finalState, trajectory, iterations }` | 仅正常终止（END 或无出边） |

`graphId` 标识每次执行（同一图实例的重复/并发运行各自独立生成），用于区分并发图之间可能重名的节点轨迹。`graph/end` 只在正常终止时发出；**所有异常终止统一发 `graph/error` 后上抛**——包括迭代熔断、条件路由返回未注册节点名/非字符串/混用哨兵的并行数组、路由函数抛错，以及 `graph/start` 之后的取消（节点执行中的取消先发 `graph/node-error` 过程诊断、再发 `graph/error` 终态；并行分支的取消会为每个失败分支各发一次 `graph/node-error` 过程诊断，但 `graph/error` 终态仅一次；`graph/start` 之前的预取消无任何事件）。节点自身业务抛错仅发 `graph/node-error` 后上抛（并行分支同规则）。`graph/*` 监听器同步执行且异常会传播进引擎（cordis `emit` 语义），订阅方不应在监听器中抛错。

`logTrajectory` 开启时，插件订阅 `node-start`（debug 级）与 `end`（info 级）把轨迹写入 `ctx.logger("graph")`。

## 安装

npm registry 当前发布的是 `dsh-state-graph@0.2.0`；本仓库的 `0.3.0` 功能仍待发布，不能通过 `@latest` 安装。发布前，如需试用当前源码，请在本地构建后以本地包路径安装。发布完成后，`dsh plugin add` 会安装依赖并自动把包名追加到 profile 的 `dsh.profile.bundles`：

```sh
dsh plugin add --profile web ./dsh-state-graph
dsh --profile web --dump-config          # 确认 state-graph 行已组合
```

profile 的 `dsh.profile.bundles` 需要包含 `dsh-state-graph`（与 `@deepseek-ai/dsh-base` 一起）。插件无其他注入依赖，任何 profile 均可加载。待 `0.3.0` 发布后，可用 `dsh plugin add --profile web dsh-state-graph@latest` 升级。

## 配置（`cordis.patch.yml` 的 `config`）

```yaml
- insert:
    - id: state-graph
      name: 'dsh-state-graph'
      config:
        defaultMaxIterations: 25       # 防死循环单次执行最大迭代上限
        logTrajectory: true            # 输出路由轨迹到日志总线
        defaultSubagentProvider: spawn # 子代理节点未显式指定 provider 时的默认值
```

## Graph Studio（可视化配置与执行）

安装到 web profile 后，浏览器 half 随包发布（`dsh.client` 声明 + `lib/client.js`），提供**全屏抽屉**入口：

- **打开方式（三选一）**：
  1. **侧边栏底部按钮**：左侧栏底部（Settings 旁）出现「Graph Studio」入口按钮，点击即打开全屏抽屉（web profile 推荐）。
  2. **深链接**：访问 `http://<dsh-host>/#graph-studio-open`（或 `/graph-studio-open`）即铺满主界面——左侧 480px 配置列，右侧 SVG DAG 独占剩余画布；可分享、可书签。
  3. **独立全屏页**：访问 `http://<dsh-host>/graph-studio`（宿主 webserver 直接 serve，TUI / headless / 未装浏览器 half 时可用）。
- 点「✕ 关闭」或「← 返回」收起，并清空 hash 深链接。

主界面的全屏抽屉通过 iframe 承载独立 `/graph-studio` 页面，因此与其他 web 插件的全局 CSS 隔离；Graph Studio 的样式不会被同页插件覆盖。

设计器与单个会话无关，因此不占会话视图 tab。

- **画布可视化设计**：右侧 SVG 画布即主设计面——拖动节点调整布局、拖空白处平移视图、双击空白添加节点；点节点右侧端口后再点目标节点即可建静态边；点静态连线选中后可用工具栏或 Delete 删除，点虚线条件边会跳到源节点规则编辑。工具栏提供缩放、比例显示与适应画布；入口节点带「▶ 起点」标记，点选节点后左侧卡片编辑（类型、白话摘要、节点名、以及「设为起点」一键入口）。静态边实线、条件边虚线、回环绕行。
- **配置极简（简约模式默认开启）**：默认隐藏 JSON 导入/导出、顶部校验面板与初始状态 JSON 编辑器，只留「节点卡片 + 画布 + 运行」三块；点顶栏「高级模式」即可切回完整控件，偏好存 localStorage。空图提供模板与内置示例一键起步。
- **可视化执行 + 两种运行方式**：`▶ 运行` 提供「浏览器模拟」与「宿主真实运行」两种模式——
  - **浏览器模拟**：在浏览器内用**与宿主同一份 StateGraph 引擎**执行（引擎零 Node 依赖，单源内联进 client bundle）：当前节点高亮、已执行节点计数、逐步轨迹（耗时 + 状态增量 patch）、终态与错误详情，`■ 停止` 随时取消（AbortSignal）。`subagent` / `gate` 这类 host-only 节点在浏览器里只会报教学错误。
  - **宿主真实运行**：把图 POST 到 dsh 进程里的 `/graph-studio/run` 端点，用同一份引擎在宿主侧真实执行，graph/* 事件随结果一并返回、复用同一套轨迹渲染。**仅支持纯业务节点（`patch` / `counter`）**——含审批门 / 子代理的图需要 dsh turn 上下文，会直接报错并提示改用「在会话中运行」。（`/graph-studio/run`、`/graph-studio/register-command`、`/graph-studio/generate` 三个 Studio 端点仅在本地 localhost 提供、无任何鉴权与速率限制，且会按 spec 在 dsh 进程内执行图，**切勿绑定到不可信网络或公网暴露**；远程访问请走 dsh 自身的鉴权隧道。）
- **发布为 slash 命令**：点「发布为命令」经 `/graph-studio/register-command` 把当前图注册为 dsh slash 命令（需 dsh-commands 插件），之后在会话里输入 `/<图名>` 即可运行；同样仅支持纯业务节点，含 host-only 节点的图会被拒绝并提示。
- **host-only 节点**：`subagent` / `gate` 节点带 ▲ 徽标——需要 dsh-subagent / dsh-user-approval 运行时与 turn 上下文，浏览器模拟与宿主直接运行都不支持，需经「在会话中运行」路径（agent 工具 / 事件处理器 / `agent/inject`），或导出 JSON 后在宿主侧用 `studioBuildGraph` 执行。
- **自然语言生成图**：设计器顶部「AI 生成图」输入框——用一句话描述流程（如「写代码并跑测试，不通过就改，最多重试 3 次」），后端经 `/graph-studio/generate` 调用默认模型生成 `StudioGraphSpec`，前端以「预览（节点/边数 + JSON）+ 应用到画布」形式让你确认，无需懂 DSL。仅用 `patch` / `counter` 节点（host-only 节点需 turn 上下文，无法在此独立生成）；需要 dsh-llm 模型服务与已选默认模型。
- 图定义以本地工作区保存：支持新建、重命名、复制、切换与删除多张图，并自动迁移旧版单图 localStorage；`导入 JSON` / `导出 JSON` 双向互通；内置三个示例（代码生成质量门回环 / 并行展开汇聚 / 子代理委托）。

导出的图定义 JSON（DSL）形状：

```jsonc
{
  "entryPoint": "generate_code",
  "maxIterations": 25,
  "nodes": [
    { "name": "generate_code", "kind": "patch",
      "patch": { "rev": { "$inc": 1 }, "code": "fn_draft" } },
    { "name": "static_analyze", "kind": "patch",
      "patch": { "lintOk": { "$test": { "field": "rev", "op": "gte", "value": 2 } } } }
  ],
  "edges": [{ "from": "generate_code", "to": "static_analyze" }],
  "conditionalEdges": [
    { "from": "static_analyze",
      "rules": [{ "field": "lintOk", "op": "eq", "value": true, "to": "__END__" }],
      "fallback": "generate_code" }
  ]
}
```

- patch 值支持 `{"$inc": n}`（数值自增）与 `{"$test": {field, op, value}}`（布尔判定，`eq/ne/gt/gte/lt/lte/exists`），均基于节点执行前的状态快照；其余为字面量。
- `counter` 节点：`{ field, limit, then? }` 自增字段，新值达到 `limit` 时额外合并 `then`。
- 条件规则的目标支持数组（`"to": ["a", "b"]` 即 Fan-out，不可与 `"__END__"` 混用）；缺省 `field` 的规则恒命中；全部未命中走 `fallback`（默认 `"__END__"`）。
- 宿主侧复用：`import { studioValidate, studioBuildGraph, studioExamples } from "dsh-state-graph"`。

## 用法示例：代码生成与双向对齐检查图

```ts
import { Context } from "@deepseek-ai/cordis";

// 在其他插件 / 工具 / 命令中：
export function buildGraph(ctx: Context) {
  return ctx.graph
    .create() // 隔离实例，maxIterations 默认取插件配置
    .addNode("generate_code", async (s, ctx, signal) => {
      const code = await llmGenerate(ctx, s.task, signal); // 业务函数自行遵守 signal
      return { code, rev: s.rev + 1 };
    })
    .addNode("static_analyze", (s) => ({ lintOk: lint(s.code).ok }))
    .addNode("run_unit_test", async (s, ctx) => ({
      testOk: (await runTests(ctx, s.code)).passed,
    }))
    .addEdge("generate_code", "static_analyze")
    .addEdge("static_analyze", "run_unit_test")
    .addConditionalEdge("static_analyze", (s, _ctx, signal) => {
      signal?.throwIfAborted();
      return s.lintOk ? "run_unit_test" : "generate_code";
    })
    .addConditionalEdge("run_unit_test", (s) =>
      s.testOk ? "__END__" : "generate_code",
    )
    .setEntryPoint("generate_code");
}

// 使用：
const graph = buildGraph(ctx);
const controller = new AbortController();
const { finalState, trajectory, iterations } = await graph.run(
  { rev: 0, task },
  { signal: controller.signal },
);
ctx.logger("app").info(`route: ${trajectory.join(" -> ")} (${iterations} steps)`);
```

条件边优先于静态边；无出边或条件路由返回 `"__END__"` 即终止。`addEdge` / `addConditionalEdge` 对同一 `from` 重复注册会抛错（与 `addNode` 的重名检查一致）；静态边与条件边可挂在同一节点上，条件边优先生效。**条件路由返回未注册节点名、非字符串或 `undefined`（如忘写 return）时抛错并发 `graph/error`**（熔断语义同上，非静默终止）。
条件路由返回字符串数组时并行执行各目标（Fan-out），所有分支补丁合并后汇聚：取分支中定义静态边的最后一个分支的出边作为 Join 节点，无出边则终止。**并行数组不能混用 `"__END__"` 与节点名**（混用抛错并发 `graph/error`）。并行路径下 `iterations` 为执行轮数（一轮可执行多个分支节点），`trajectory` 为节点级轨迹（含全部分支），二者长度可不一致。

## 与 dsh harness 集成

### 图注册为 slash 命令（`ctx.graph.registerCommand`）

需要 dsh-commands 插件（`ctx.commands`）。命令的 `rawInput` 默认按 JSON 解析为初始状态，执行后以轨迹文本作为 `CommandResult` 返回；`parseInput` 可自定义解析。

**支持范围：命令图仅支持纯业务节点 + 条件路由**（含 `addSubgraph` 内联子图）。命令执行不在 dsh turn 内（log-only appends，无 open turn），因此图中含 **审批门节点（`addApprovalGate` / Studio `gate` 节点）或子代理节点（`addSubagent` / Studio `subagent` 节点）时，`registerCommand` 在注册时直接抛错**——审批请求会被 dsh 以 idle ask 拒绝，子代理需要真实父 Agent 推导会话/谱系/委托深度。这类图请改用 agent 工具路径或 `agent/inject` 执行（图内节点能力不受影响）：

```ts
export function registerPipelineCommand(ctx: Context) {
  ctx.graph.registerCommand({
    name: "pipeline",
    description: "运行代码生成质量门流水线",
    inputHint: '{"task":"..."}',
    graph: {
      entryPoint: "generate_code",
      nodes: {
        generate_code: async (s, ctx) => ({ code: await llmGenerate(ctx, s.task) }),
        static_analyze: (s) => ({ lintOk: lint(s.code).ok }),
        run_unit_test: async (s, ctx) => ({ testOk: (await runTests(ctx, s.code)).passed }),
      },
      edges: [
        { from: "generate_code", to: "static_analyze" },
        { from: "static_analyze", to: "run_unit_test" },
      ],
      conditionalEdges: [
        { from: "static_analyze", condition: (s) => (s.lintOk ? "run_unit_test" : "generate_code") },
        { from: "run_unit_test", condition: (s) => (s.testOk ? "__END__" : "generate_code") },
      ],
    },
  });
}
```

### 持久化：节点级 checkpoint

`run(initialState, { checkpoint })` 在每次节点补丁合并后回调，宿主把 `{ graphId, node, state, iteration }` 写入自己的持久化层（session log、`ctx.fs`、SQLite 等）。图引擎本身保持内存态——dsh 的"模型可见即落日志"不变量由宿主的 checkpoint 实现决定。

### 审批门（`addApprovalGate`）

需要 dsh-user-approval 插件（`ctx.approval`）。节点执行前请求一次性授权，`allowed-once` 放行，拒绝 / 取消 / 无应答按节点错误路径上报：

```ts
graph
  .addNode("deploy", deployHandler)
  .addApprovalGate("deploy", {
    toolName: "graph.deploy",
    reason: "部署到生产环境需要人工确认",
  })
  .setEntryPoint("deploy");

await graph.run(state, { agent }); // agent 为审批上下文（如命令 invocation.agent）
```

**限制**：`ctx.approval.request` 要求会话处于 open turn 内（dsh 持久化日志的提交边界），因此审批门应在 turn 上下文（agent 工具 / 事件处理器）中使用；无 turn 的 slash 命令场景审批请求会被 dsh 拒绝——需要审批的命令图应改用 agent 工具或 `agent/inject` 路径执行。

### 子代理节点（`addSubagent`）：子图 = 真实 dsh 子代理

`addSubgraph` 是把一张**进程内**状态机嵌套进父图（复用同一 ctx，节点 handler 直接跑）。`addSubagent` 则把节点委托给一个**真实的 dsh 子代理**——独立的 Agent、独立会话、可走 LLM 与工具，通过 `ctx.subagents.start(provider, …)`（需要 dsh-subagent 运行时，如 `dsh-subagent-spawn-in-process` 提供的 `spawn` / `dsh-subagent-fork-in-process` 提供的 `fork`）。

```ts
graph
  .addSubagent("research", {
    provider: "spawn",            // 默认取插件配置 defaultSubagentProvider
    prompt: "研究任务：{{state}}，返回 JSON：{ \"result\": { \"summary\": \"…\" } }",
    inputMapper: (s) => ({ task: s.task }),
    // outputMapper 默认 fromSubagentPatch：
    //   structured.result → 直接作为对象增量合并；否则尝试 JSON.parse(文本)；
    //   仍失败则落到 state[resultKey]（默认 "result"）字段
  })
  .addEdge("research", "write_report")
  .setEntryPoint("research");

// run 需提供父 Agent 上下文（子代理的 parent）：
await graph.run({ task }, { agent: invocation.agent, signal });
```

要点：

- **父 Agent**：`run(initialState, { agent })` 注入的 `agent` 作为子代理的 `parent`（dsh 需要真实父 Agent 推导会话、谱系与委托深度）。**必须在 turn 上下文（agent 工具 / 事件处理器）中执行**——无 `agent` 或 `ctx.subagents` 缺失时节点抛错，按节点错误路径（`graph/node-error`）上报。
- **输入映射**：`inputMapper` 把父状态投影为子代理初始输入，默认透传整个 state；`prompt` 支持 `{{node}}`（节点名）与 `{{state}}`（JSON 序列化后的输入）模板变量。
- **模型路由（自动继承，可覆盖）**：子代理默认**自动继承父 Agent 的模型路由**（dsh `resolveChildAgentOptions` 从 `parent.options` 继承 provider/model/maxTokens）。若父 Agent 的 `options` 缺失 provider 或 model（例如父会话实际走 `agent/request` waterfall 或每步选模型），插件会用 `ctx.agentDefaultModel.currentSelection()` **补齐缺失字段**（保留父已有的）。显式传 `agentOptions: { provider, model, maxTokens }` 则**完全覆盖**自动解析结果，优先级：显式 `agentOptions` > 父 `parent.options` > `agentDefaultModel` 兜底。实测教训：子代理继承的模型可能路由失败（如 `PI_AI_ERROR: all model candidates failed`），此时用 `agentOptions` 显式指定可用模型即可。
- **结构化输出**：节点默认请求 `outputSchema`（`{ type: "object", properties: { [resultKey]: {} }, required: [resultKey], additionalProperties: false }`），子代理返回 `structured[resultKey]` 即作为父状态增量合并；不请求结构化时文本输出先试 `JSON.parse`，失败则落到 `state[resultKey]`。
- **失败与取消**：`stopReason !== "completed"`（aborted / error / max-tokens / refusal）抛错并附 `diagnostic` 与部分输出；父图 signal 透传给子代理请求（`SubagentStartRequest.signal`），取消按节点错误路径上报（先 `graph/node-error`，若取消则补发 `graph/error` 终态）。结果收集后 `run.dispose()` 释放子代理。
- **透传**：`agentOptions`（model / maxTokens）、`maxDepth`（需 provider 支持 `depthLimit`）、`toolFilter`、`persona` 均可透传；provider 缺能力时 dsh 会 `fail loud` 拒绝。
- **provider 默认值**：节点级 `options.provider` → 图级 `setSubagentProvider` → 插件配置 `defaultSubagentProvider`（默认 `spawn`）。
- **与并行 Fan-out 组合**：条件路由返回数组时各分支可含子代理节点，并发委托；取消为每个失败分支各发一次 `graph/node-error`，`graph/error` 终态仅一次。

## 运维与性能考量

1. **状态合并策略**：默认浅拷贝 + 结构补丁合并（`{ ...state, ...patch }`）。大对象（文件内容、仓库快照）建议经引用路径或沙箱虚拟文件系统管理，避免全量复制造成 GC 压力。
2. **取消与异步超时控制**：`run(initialState, { signal })` 是合作式取消。引擎只在节点、路由和图遍历边界检查 signal，不会强杀忽略 signal 的普通 Promise；NodeHandler / ConditionHandler 也应把第三参数传给所调用的 LLM、工具或外部服务。取消的终态事件语义见上文事件表：`graph/start` 之后的取消一律补发 `graph/error`。引擎不内置单节点超时，单节点超时仍由调用方或 handler 自行组合 `AbortSignal` 与定时器。
3. **观测**：节点级耗时分析 = 同一节点相邻 `node-start` / `node-end` 事件时间差；执行流回放 = 按序消费 `graph/*` 事件。

## 开发

```sh
npm install
npm run build        # tsc → lib/ + 引擎 CJS（.client-build/）+ 组装 lib/client.js（Graph Studio 浏览器 bundle）
npm run typecheck
npm run smoke        # build + 冒烟测试（设计文档 §5 工作流 + 熔断/入口校验/事件流）
npm test             # build + node --test（StateGraph.run 全流程/事件契约/Studio DSL/客户端 bundle 装载）
```

## 许可

MIT。实现遵循《DeepSeek Harness (dsh) 状态图（StateGraph）编排引擎技术方案与架构设计》。
