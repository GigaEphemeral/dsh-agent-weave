# 可视化 Agent 任务编排工具

> **一句话目标**：实现一个可视化的 Agent 任务编排工具——用户输入一句话需求，自动拆解为工作流任务图，多角色 subagent 按图协作（含循环与条件回退），激活状态全程可视化，每个 Agent 独立记忆防污染，可互相对话，角色支持导入文件创建与画布连线。

[![Status](https://img.shields.io/badge/status-MVP--4%20%E5%B7%B2%E5%AE%8C%E6%88%90-brightgreen)]()
[![DSH](https://img.shields.io/badge/DSH-0.1.5--rc2-green)]()
[![Node](https://img.shields.io/badge/Node-%5E22.19%20%7C%7C%20%3E%3D24-green)]()
[![License](https://img.shields.io/badge/license-MIT-lightgrey)]()

---

## 目录

- [当前状态](#当前状态)
- [核心逻辑（通读代码整理）](#核心逻辑通读代码整理)
  - [分层架构](#分层架构)
  - [核心对象模型](#核心对象模型)
  - [角色：如何注册 subagent / 配置个性与特性](#角色如何注册-subagent-配置个性与特性)
  - [StateGraph 编排引擎](#stategraph-编排引擎)
  - [记忆隔离机制](#记忆隔离机制)
  - [Agent 间协作与交接](#agent-间协作与交接)
  - [消息总线与防死锁](#消息总线与防死锁)
  - [与主 agent 的关系和通信方式](#与主-agent-的关系和通信方式)
  - [协作流程控制（暂停/恢复/终止/审批/断点）](#协作流程控制暂停恢复终止审批断点)
  - [观察者机制](#观察者机制)
  - [Token 熔断与优化（如何节省 token）](#token-熔断与优化如何节省-token)
- [交互方式](#交互方式)
- [约束与边界](#约束与边界)
- [关键设计决策](#关键设计决策)
- [历史：MVP-1 动工清单](#历史mvp-1-动工清单)
- [依赖与参考](#依赖与参考)
- [开发路线图（MVP）](#开发路线图mvp)
- [后续阶段待办](#后续阶段待办)
- [风险与缓解](#风险与缓解)
- [许可证](#许可证)

---

## 当前状态

| 项 | 状态 |
|---|---|
| **当前阶段** | **MVP-4 已完成 ✅**（阶段0 + 预研 + Phase A/B/C/D/E + 问题 1-5 修复 + **Bugs-V5 `ask_user` 落地**） |
| **插件版本** | `dsh-agent-weave@0.3.2`（Web 看板 + 图引擎 + 断点恢复 + 子代理治理 + ask_user 主动暂停提问） |
| **下一步** | **MVP-5 画布编辑 + D2 侧栏常驻**（即将动工，见[后续阶段待办](#后续阶段待办)） |
| **运行环境** | Windows 11 + DSH **0.1.5-rc.2** + Node 22.23 + pnpm 12.3 |
| **开发路径** | Host CLI（MVP-1/2/3）→ **Web 看板（MVP-4）**：D1 页头按钮 + D3 主区切换 |
| **测试基线** | **307 测试全绿**（50 文件，含 Bugs-V5 ask_user 5 例） |
| **MVP-4 实绩** | 图节点实时染色 / Token 分账 / 审批 / 观察者信号 / 消息流（零 token）/ 暂停-恢复-终止-断点恢复 / **subagent 关键决策点主动暂停问用户** |

**MVP-4 核心使命**：从 CLI 终端视图升级为 **Web 实时看板**——用户点页头"Weave 看板"按钮 → 主区切换为全屏看板 → 实时看到图节点染色、节点活动、Token 分账、审批待办、观察者信号、消息流，并可暂停/恢复/终止/审批/从 checkpoint 恢复。

**MVP-1 要回答的四个问题**（**全部验证通过 ✅**）：

| # | 待验证问题 | 结论 |
|---|---|---|
| Q1 | 角色 YAML 能否编译为可注册的 SubagentProvider？ | ✅ 6 角色编译/注册/执行成功 |
| Q2 | 记忆隔离是否真的生效？ | ✅ `inheritsParentContext=false` + 6 独立 session |
| Q3 | toolFilter 是否真的按角色限定工具？ | ✅ 角色注入 `toolFilter.allow`（v2.0 起主要靠 Prompt 层约束） |
| Q4 | 多角色能否通过 workflowEngine 串行协作？ | ✅ 六阶段串行 completed（改用自写编排，见 D-001） |

> **MVP-1 产出**：插件 `dsh-agent-weave`（角色编译管线 + 单链编排 + 可观测性）、6 角色资产、单测、8 份过程文档。
> **MVP-4 产出**：插件 `dsh-agent-weave@0.3.2`（Web 看板 + 图引擎 + 断点恢复 + 子代理治理 + ask_user），307 单测。

---

## 核心逻辑（通读代码整理）

> 本章按「角色怎么来 → 图怎么跑 → 怎么协作 → 怎么与主 agent 沟通 → 怎么控制流程 → 怎么省钱」整理，全部对照 `src/` 实际代码。

### 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│ L5 可观测性与治理层                                            │
│  执行轨迹追踪 · RunLedger 审计账本 · Token 分账 · 审批分级      │
├──────────────────────────────────────────────────────────────┤
│ L4 可视化层                                                    │
│  Web 看板(REST/SSE) · 实时激活状态 · Token 监控 · 审批待办      │
├──────────────────────────────────────────────────────────────┤
│ L3 角色管理层                                                  │
│  YAML 配置 · 角色编译/注册 · 质量门 · 观察者配置 · 生命周期     │
├──────────────────────────────────────────────────────────────┤
│ L2 编排引擎层（自研 StateGraph）                                │
│  图 DSL · 条件边/循环回退 · 迭代熔断 · checkpoint · 消息总线    │
│  · ask_user 主动暂停                                           │
├──────────────────────────────────────────────────────────────┤
│ L1 执行与记忆层（官方 @deepseek-ai/dsh-subagent）               │
│  startContinuable 子代理 · 独立 Session · 记忆隔离 · 持久化     │
└──────────────────────────────────────────────────────────────┘
```

- **复用层**：L1 直接使用官方 `@deepseek-ai/dsh-subagent`（`startContinuable` / `sendMessage` / `interrupt` / `subagent/end` 事件），无需自研记忆隔离。
- **自建层**：L2 自研 StateGraph 引擎，L3 角色管理，L4 可视化，L5 可观测与治理。

### 核心对象模型

| 对象 | 定义 | 落点 |
|---|---|---|
| **Agent（角色）** | 个性/特质 + 工具 + 模型 + 质量门 + 预算 + 职责边界 + handoff 声明 | `roles/*.yaml`（Zod 校验）+ `skills/*/SKILL.md`（人格） |
| **Workflow（图）** | 节点 = 角色/条件/审批，边 = seq/cond/loop/parallel | 图 DSL（YAML）→ `GraphDefinitionSpec` |
| **Task（任务实例）** | 一句话 → 根任务 → 子任务树（规划，见[待办](#后续阶段待办)） | 任务树（storageDomain） |
| **State（共享状态）** | messages / retry_count / user_input / artifacts{} / max_iterations | 引擎原子合并（`mergeState`） |
| **Memory（角色记忆）** | 每 Agent 独立 context + 交接物 | 独立 subagent session + 工作区文件 |
| **RunLedger（运行账本）** | 不可变事件流：节点事件 + Token 分账 + 合规状态 + 人工介入 + 消息 + 观察者信号 | `l5-observability/run-ledger.ts`（只追加） |

**核心洞察**：**Agent 拆解 Task，Task 驱动 Agent**。Workflow 图定义的是 Agent 之间的协作协议，不是"Task 的容器"。具体交给谁、拆解出什么 Task，是 Agent 在执行时根据 Task 内容和图的条件边动态决定的。

### 角色：如何注册 subagent / 配置个性与特性

#### 注册链路（YAML → 可执行 subagent provider）

```
roles/<角色>.yaml
   │  js-yaml 解析 + RoleDefinitionSchema.safeParse（Zod，失败抛 RoleSchemaError）
   ▼
RoleDefinition（校验后数据模型）
   │  compileRoleProfile → RoleProfile（纯数据画像）
   ▼
compileRoleToProvider → SubagentProvider
   │  注入 persona(SKILL.md 内容) / toolFilter / agentOptions / depthLimit
   │  inheritsParentContext = (memory_scope === 'shared')
   ▼
ctx.subagents.registerProvider(provider)     ← 注册进 DSH 子代理注册表
   │  delegate = ctx.subagents.getProvider('spawn')（底层实际执行器）
   ▼
图节点用 provider 名（= 角色 id）startContinuable 启动
```

- **注册时机**：插件 `apply()` 内 `tryRegisterRoles()`；若 `spawn` provider 未就绪，每 100ms 轮询最多 50 次（5s），超时记 error 跳过（图命令不受影响）；`ctx.effect` 卸载时清定时器。
- **扫描**：`roles/` 目录下 `.yaml`/`.yml` 排序批量加载，编译成角色目录。
- **路径安全**：`system_prompt_ref` 相对 `skillsDir` 解析后，`assertInsideSkillsDir` 强制位于 skillsDir 内，否则 `RoleLoadError`（防路径逃逸）。

#### 个性与特性配置项（`roles/*.yaml`）

| 配置 | 作用 | 说明 |
|---|---|---|
| `system_prompt_ref` | **人格** | 指向 `skills/<角色>/SKILL.md`，其内容作为 subagent 的 persona 注入 |
| `traits` / `capabilities` | 特质/能力声明 | Prompt 层描述（发散、收敛、边界思维…），进 metadata 供看板展示 |
| `model: { provider, model }` | **模型路由** | 完整 `{ provider, model }` 对象，缺一不可（路由完整性约束） |
| `memory_scope: private \| shared` | 记忆 | `private` → `inheritsParentContext=false`（全新隔离 session，默认） |
| `lifecycle: resident \| on-demand \| hybrid` | 生命周期 | 现有角色全部 `on-demand` |
| `capability` | 委派/权限 | `allow_delegation`(默认 false) / `max_depth` / `allowed_children` / `allow_shell` / `allow_write`；`allow_delegation=false` 时注册阶段**自动剥离 spawn 类工具**（subagent/delegate/spawn/fork/create_child/list_subagent_models） |
| `tools?` | 工具白名单 | → `toolFilter.allow`；**空 = 不做工具层控制**（现有角色均未配，靠 Prompt 层 `role_boundary` 约束） |
| `quality_gate[]` | 产物质量门 | `non_empty` / `min_file_size` / `min_artifact_count` / `contains_section` / `no_code_fence` / `forbidden_phrases` / `require_probe_section`；不过 → 节点失败整图停 |
| `token_budget?` | Token 预算 | **当前仅记录/上报，不强制熔断**（硬熔断为后续待办） |
| `role_boundary` | 职责边界 | `responsibilities` / `forbidden` / `artifact{name,type,required_sections}`，编译成 prompt 边界块注入（含禁止行为清单） |
| `handoff` | 交接声明 | `upstream[]` / `downstream[]` / `edge_type(seq\|cond)` |
| `observers?` | 观察者配置 | 关注节点/模式/干预级别/预算（L1/L2 使用） |

#### 角色清单（当前 6 个，全部 `vol186coding/deepseek-v4-flash`、`private`、`on-demand`）

| 角色 id | 名称 | 产物 | 职责 |
|---|---|---|---|
| `R1-requirement` | 需求分析师 | `prd.md` | 需求发散/边界/验收基线（唯一被改写为"主动决策+主动提问"的角色） |
| `R2-architect` | 架构师 | `arch.md` | 技术选型/模块划分/证据等级 |
| `R4-designer` | 详细设计师 | `design.md` | 接口细化/测试方案 |
| `R6-developer` | 开发者 | `develop.md` | 代码实现/单测（**唯一 `allow_shell: true`**） |
| `R7-tester` | 测试员 | `report.md` | 测试执行/回归 |
| `R8-quality` | 质量审核员 | `review.md` | P0/P1/P2 分级 + 门禁判定 |

默认协作链：`R1 → R2 → R4 → R6 → R7 → R8`（全部 `seq`）。

#### 引擎如何把角色变成图节点

`weave_run_graph` 按图 DSL 遍历节点：`role` 节点 → `graph.addSubagent(node.id, { provider: 角色id, artifactName, qualityGate(从角色 YAML 读), roleDefinition(供边界块), inputGate(从 seq 边推导) })`；`approval` 节点 → `addApprovalGate`；`condition` 节点 → `addNode` 占位 + 条件边驱动路由。

### StateGraph 编排引擎

- **构建**：`createStateGraph<T>(ctx, maxIterations, maxConcurrent, artifactsRoot, eventSink?, ledger?, tokenCollector?, observer?)`。
- **节点 API**：
  - `addNode(id, handler)`：纯 handler（condition/占位）。
  - `addSubagent(id, { provider, promptTemplate?, outputSchema?, artifactName?, role?, qualityGate?, inputGate?, roleDefinition?, workspace? })`：真实子代理节点。首次激活 `startContinuable` 建 durable child（childId 记入 `childIdByNode` + 全局 `graphNodeChildren`）；循环回退/恢复时 `sendMessage` 追加 `buildFeedbackFromState` 反馈**复用同一 child**；产物多候选查找（≥100B）复制到 `artifactsRoot/graph-artifacts/<node>/<artifactName>`，缺产物用 output text 兜底；qualityGate 不过 → 抛错整图停。
  - `addEdge(from, to)` / `addLoopEdge(from, to, maxIter)` / `addConditionalEdge(from, condFn, maxIter)` / `addApprovalGate(id, { toolName, reason, required })`。
- **run(initialState, options)**：必需 `checkpoint` / `graphVersion` / `graphSchemaHash`；可选 `agent`（父 Agent）/ `signal` / `graphId` / `startFrom` / `initialIteration` / `initialLoopUsage` / `approvalPolicy` / `restoredChildSessions` / `completedNodes`。返回 `{ graphId, success, finalState, trajectory, iterations, error?, data? }`。
- **图 DSL**（`GraphDefinitionSpec`）：`nodes`（`role`/`condition`/`approval` + `roleRef`/`inputGate`/`artifactName`）、`edges`（`seq`/`cond`/`loop`/`parallel`；**cond 必有 `when`，loop 必有 `maxIter`，自环只允许 loop**）、`checkpoint`、`metadata`、`observers?`。
- **静态验证器**（加载即校验）：roleRef 已注册、cond 字段白名单、BFS 可达性、Kahn 环检测（loop 不算环）、parallel 暂不支持。
- **默认图**：六角色全 `seq`（`requirement→architecture→design→develop→test→quality`），`maxIterations=25`；`weave_run_graph` 不传 `path` 即用它（99% 场景免写 YAML）。
- **checkpoint**：在"补丁合并后、跳转前"落盘（含 loopUsage），`checkpoints/<graphId>/<iter>-<node>.json`；恢复**版本感知**（graphVersion 不符 → `VERSION_MISMATCH`，防旧图恢复错状态）。

### 记忆隔离机制

- **官方能力直接复用**：每个角色 `inheritsParentContext=false`（`memory_scope='private'`）→ 全新隔离上下文，不读取彼此的推理过程。
- **交接双通道**：
  - 产出物 = 文件（durable），落盘共享工作区 `graph-artifacts/<node>/`，经 `state.artifacts` 引用传递。
  - 即时协商 = 消息（transient），经 `sendMessage` 定向发送。
- **循环回退/断点恢复**：复用同一 `childId`（`restoredChildSessions` 预填），`sendMessage` 追加反馈继续，**不重建 session、不丢记忆**。

### Agent 间协作与交接

- **产物交接 + handoff 块**：每个角色在产物末尾写 `<!-- weave-handoff { "probes": [...], "decisions": [...], "openIssues": [...] } -->` 注释块；下游启动时 `buildUpstreamContextBlocks` 把它解析为**【已探测（无需重复）】【已决策】【遗留问题】** + **正文（截断 8000 字符）** 注入 prompt，避免重复探测、防交接失真。
- **共享发现池（findings）**：`publish_finding` 工具把探测结果写入 `_shared/<graphId>-findings.jsonl`（单节点 ≤20 条）；下游注入"其他节点已探测，无需重复"（`reusableFindingsText`，20 条）。
- **ask_user（Bugs-V5）**：subagent 在**关键决策点**调 `ask_user` → 写 `pendingAskUser` + pause trigger `interruptSubagent` → 图暂停 → 审批卡送达主 agent → 用户回答 → `weave_graph_resume additional_context="回答"` → `sendMessage` 给同一 child 继续。双路径（正常流程 / catch）都能捕获，`default` 必填防卡死，每节点最多问 3 次。

### 消息总线与防死锁

- **父代理中转**：A → 父（编排器）→ B，父代理解析目标并经 `ctx.subagents.sendMessage` 转发（`MessageBus` 封装）。
- **消息契约**：`{ id, correlation_id, from, to, type: handoff|query|feedback|escalation, payload:{artifact_ref?, summary, full_content?}, deadline, priority }`，TTL 60s 过期拒发；发送后**只读桥接**到 RunLedger（只存摘要，不存 full_content，防账本膨胀，零 token）。
- **防死锁分级恢复**：
  - 单条消息超时 → 重试（最多 2 次）。
  - 同一 Agent 同链路被触发 ≥3 次 → 强制终止链路 + 诊断写入 RunLedger。
  - 整个工作流超时 → 降级到人工审批节点。

### 与主 agent 的关系和通信方式

主 agent（用户的 DSH 会话）是**外部指挥者**，不进入图；通过 weave 工具集指挥，经 approval 服务接收图的通知：

**主 agent → weave（指挥）**

| 工具 | 用途 |
|---|---|
| `weave_run_graph [path=<yaml>] user_input=<需求> [output_dir=]` | **入口**：秒返回 `graphId`（后台跑），不阻塞主 agent |
| `weave_graph_resume graph_id=<id> [additional_context=]` | 从暂停快照恢复；`additional_context` 承载用户回答/补充上下文，先发给暂停节点子代理 |
| `weave_graph_validate / show / init / help` | 校验/查看 ASCII 图 / 生成模板 / 帮助（内置"暂停处理契约"与"三条铁律"） |
| `weave_graph_status / tail / watch / report` | 最近执行状态 / trace 事件流 / 实时监控 / HTML 报告 |
| `publish_finding` / `ask_user` | 子代理工具（经图注入） |

**weave → 主 agent（通知，双通道）**

1. **approval 卡**（`ctx.get('approval')`）：`toolName` 区分类型——普通暂停 `weave.graph.paused`、ask_user 问答 `weave.ask_user`；卡内含 `reasonText`（暂停位置/原因/主 agent 必读 4 条）。
2. **PAUSED 文件**（fallback）：无 approval 服务时写 `<artifactsRoot>/PAUSED`，主 agent 从文件读取。

**ask_user 问答卡**：`❓ 图 <id> 在节点 <node> 等待你的决策` +【问题】【选项】【默认假设】【影响范围】【如何回答（weave_graph_resume …）】+【主 agent 必读】（原样呈现给用户 / 不自动重跑整图 / 不催用户）。

**Web 看板（L4）**：D1 页头按钮 → D3 主区全屏看板。REST：`GET /api/weave/graphs`、`graph/:id/status|spec|stream|tokens|approvals|checkpoints`、`node/:id/activity`；`POST graph/:id/pause|resume|stop`、`POST approval/:id/approve|reject`。SSE 按 graphId 广播事件流（`graph/start | node-start | node-end | node-error | error | end | checkpoint-written | loop-iteration | observer-signal | node-activity | paused | node-idle-warning | node-loop-detected`）。鉴权：`x-weave-token`（未配 env 时本地放行）。

### 协作流程控制（暂停/恢复/终止/审批/断点）

| 机制 | 实现 |
|---|---|
| **迭代熔断** | 进入节点前 `++iteration > maxIterations` 终止（默认 25）；条件边级 maxIter 缺省 = 全局 |
| **并发闸** | `createQueueingCounter`，超限 FIFO 排队；`acquire/release` 在 `finally` 成对（防死锁） |
| **暂停/恢复/终止** | 内存化 `GraphControl`：pause → `abort(PauseError)` 可恢复；stop → `abort(Error)` 终止；另有 PAUSE/STOP 文件 200ms 轮询兜底 |
| **审批门** | 分级策略：L1 轻量（10min 超时自动继续）/ L2 标准（30min 升级 L3）/ L3 紧急（无超时阻塞）；有 `approvalPolicy` 优先走 policy，否则 `ctx.approval.request` 须 `allowed-once`；缺服务 fail-closed（`required:false` 可跳过） |
| **错误分类 → 暂停** | `classifyError`：permission / dependency / budget / timeout / 子代理 abort → `needsUserIntervention` → 写 `pauses/<graphId>.json` 快照 + approval 通知 |
| **断点恢复** | `weave_graph_resume`：读快照 → 重建图 → `run({ startFrom: resumeFrom, initialIteration, initialLoopUsage, restoredChildSessions, completedNodes })`；恢复成功且未再暂停才删快照 |
| **ask_user 主动暂停** | `pendingAskUser` + pause trigger；`'awaiting-user-input'` 暂停（正常流程 / catch 双路径） |

### 观察者机制

观察者是**正交增强层**，不改变图拓扑，与质量审核节点互补。

| 层级 | 模式 | 触发时机 | 介入方式 | Token 开销 |
|---|---|---|---|---|
| **L1 轻量检查** | 中间件纯函数 | 图校验阶段 | 命名规范 / role 节点必有 roleRef / retry_count 非负，不调用 LLM | 零 |
| **L2 静默观察** | 文件观察 | 节点完成后 | 读产物做关键词/大小检查，按关注级别发 GREEN/YELLOW/RED 信号 | 低（纯函数，不调 LLM） |
| **L3 深度审查** | 流式观察者 | 质量门节点、循环回退前 | 完整 LLM 审查，返回 BLOCK/SANITIZE/FLAG | 高（MVP-6 按需） |

- **观察者原则**：只读、非阻塞、文件观察优先、记忆隔离、分级介入、fail-open。
- **信号分级**：GREEN（继续）/ YELLOW（记录并标记）/ RED（触发早期回退）。信号经 `createObserverSignal`（零 token 结构化）进入 `graph/observer-signal` 事件 → RunLedger + 看板。

### Token 熔断与优化（如何节省 token）

**已实现（代码内真实生效）**：

1. **上游只注入摘要，不全量传**：下游只收到 handoff 的【已探测/已决策/遗留问题】+ 正文截断 8000 字符，不重复携带上游全文。
2. **findings 复用防重复探测**：已探测对象经 `publish_finding` 共享，下游"无需重复"。
3. **记忆隔离 + childId 复用**：循环回退/断点恢复不重建 session，不重复消耗"重新理解上下文"的 token。
4. **消息流零 token**：SSE 看板事件、RunLedger 记账、观察者信号均为结构化数据，不调 LLM。
5. **Token 分账可观测**：`reportTokenUsage`（含 cacheRead）→ `token-collector` 按节点/角色汇总 → 看板 /tokens 展示，先有度量再谈优化。
6. **art:// 工件引用**：产物引用用规范化 `art://` 路径传递，消息只带引用 + 摘要。

**记录/占位（规划，未强制）**：

- `token_budget` 仅记录不熔断；软阈值压缩 / 硬阈值熔断 = 后续待办。
- `dsh-turn-budget`（per-turn 资源治理）**未安装**（社区包未适配 0.1.5-rc.2），cordis.patch.yml 已留配置段。
- Prompt Caching：依赖 DSH 平台能力（未显式实现）。

---

## 交互方式

1. **输入需求**：用户在 Web UI 中输入一句话需求，系统自动生成初始工作流图。
2. **画布编排**：用户可在画布上拖拽角色节点、连线定义交互（顺序/条件/循环），并配置循环退出条件与熔断阈值（MVP-5）。
3. **角色导入**：通过导入 YAML 角色文件，动态创建新角色或修改现有角色元数据（MVP-5）。
4. **实时看板**：节点状态实时染色；每个节点的 Token 消耗、执行时长、产出物引用；观察者信号（GREEN/YELLOW/RED）可视化。
5. **人工审批 + 主动提问**：分级审批（L1 轻量异步 / L2 标准同步 / L3 紧急同步）；subagent 关键决策点可 `ask_user` 主动暂停，用户在主 agent chat 里看到问题、选项、默认假设、影响范围并回答。
6. **运行控制**：启动、暂停、恢复、中断工作流，从最近 checkpoint 恢复执行。

---

## 约束与边界

> 代码/文档中强制或约定的边界，改动时不可违反。

1. **角色禁止委派**：`allow_delegation=false`（默认）时，注册阶段自动剥离 spawn 类工具；角色 SKILL.md 明确"你是终端执行者，禁止委派"。
2. **模型路由必填完整**：`model` 必须是完整 `{ provider, model }` 对象，缺一不可（防路由分裂）。
3. **路径逃逸防护**：`system_prompt_ref` 必须位于 `skillsDir` 内（编译期校验）。
4. **scoped Cordis**：只使用 `@deepseek-ai/cordis`，不保留 unscoped import（防双 Cordis 身份分裂）。
5. **无硬超时**（subagent waiter 核心原则）：只响应 `subagent/end` / `subagent/error` / `signal.abort`；空闲/循环只提示不中止（防误杀慢任务）。
6. **checkpoint 版本感知**：graphVersion 不符禁止恢复（VERSION_MISMATCH）。
7. **暂停契约（主 agent 必读）**：收到暂停禁止自动 `weave_run_graph` 重跑整图、禁止猜意图直接 resume、禁止谎报"图已完成"。
8. **ask_user 纪律**：`default` 必填（否则图会卡死）；每节点最多问 3 次；一次只问一件事；只在关键决策点用。
9. **质量门 fail-closed**：role 产物不过质量门 → 节点失败整图停；审批门缺服务 fail-closed（除非显式 `required:false`）。
10. **Token 分账诚实**：`token_budget` 目前仅记录，不伪装成已熔断；硬熔断在待办。
11. **Windows 环境**：避免 `npx`/`pnpm dlx`（卡死），用全局安装；构建增量损坏时 `pnpm run clean` 后重建。
12. **测试环境隔离**：真实运行在 `test-env/`（D-10），数据不清理、产物对用户可见确认。

---

## 关键设计决策

| 决策点 | 结论 |
|---|---|
| 编排引擎 | ✅ 自研 StateGraph（非 workflowEngine script） |
| 运行时底座 | ✅ 分层复用：subagents（执行）+ 自建（引擎/角色/画布/治理）；**不依赖 experimental agentTeams** |
| 角色定义 | ✅ YAML 元数据 + `system_prompt_ref` 指向 skill 文件；`tools` 空 = 靠 Prompt 层 `role_boundary` 约束 |
| 开发路径 | ✅ 纯 Host CLI 先行（MVP-1/2 不碰 UI） |
| 编排 vs 可视化 | ✅ 编排（MVP-2）前置于可视化（MVP-4） |
| 观察者机制 | ✅ 正交增强层：L1（MVP-2）、L2（MVP-3）、L3（MVP-6 按需） |
| Task 建模 | ✅ **Agent 拆解出 Task，Task 树自然形成**（规划中落地） |
| 用户介入 | ✅ **Bugs-V5**：subagent 关键决策点 `ask_user` 主动暂停问用户；用户不答按 `default` 继续（不卡死） |
| 恢复 | ✅ 断点恢复（PauseSnapshot + checkpoint + restoredChildSessions），`weave_graph_resume` 续跑同一 child |

---

## 历史：MVP-1 动工清单

### 任务总览（12 个任务）

| 任务 ID | 任务名称 | 状态 |
|---|---|---|
| P1.1.0 | Windows 环境验证 | ✅ |
| P1.1.1 | 插件脚手架搭建 | ✅ |
| P1.1.2 | L0-L5 目录骨架 | ✅ |
| P1.1.3 | 共享类型定义 | ✅ |
| P1.1.4 | 结构化日志基础设施 | ✅ |
| P1.1.5 | 角色 YAML Schema | ✅ |
| P1.1.6 | 角色 Provider 编译器 | ✅ |
| P1.1.7 | Cordis 生命周期验证 | ✅ |
| P1.2.1 | 单链编排脚本 | ✅ |
| P1.2.2 | 记忆隔离验证 | ✅ |
| P1.2.3 | toolFilter 验证 | ✅ |
| P1.2.4 | 单链闭环端到端测试 | ✅ |

### MVP-1 门禁（四项，全部通过）

1. **多角色顺序跑通真实小任务**（端到端脚本）
2. **产物落盘**（`productions/<角色ID>/`）
3. **记忆隔离验证通过**（R3 与 R5 的 Session 不共享）
4. **chat 中可见 workflow 节点**（DSH Web 界面检查）

> 详细完成情况与遗留见 `docs/MVP-1/` 过程文档（已归档）。

---

## 依赖与参考

### 官方库（DeepSeek Harness 官方）

| 库名 | 用途 | 来源标注 | 仓库/链接 |
|---|---|---|---|
| `@deepseek-ai/dsh-subagent` | 持久化子代理服务：`startContinuable` / `sendMessage` / `interrupt` / `subagent/end` | **官方稳定版** | [deepseek-harness/packages/subagent](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent) |
| `@deepseek-ai/dsh-tools` | `defineTool` 工具定义 | **官方稳定版** | 同上 |
| `@deepseek-ai/dsh-goal` | 目标跟踪服务（`ctx.goals`，restart 复用） | **官方稳定版** | `deepseek-harness/packages/goal/` |
| `dsh-jobs` / `dsh-jobs-local` | 后台任务注册表（`ctx.jobs`） | **官方稳定版** | `deepseek-harness/packages/jobs/` |
| `@deepseek-ai/cordis` | 插件框架（scoped） | **官方** | — |

> **官方实验性包（不推荐作为核心依赖）**：`@deepseek-ai/dsh-experimental-agent-team`（不支持循环工作流，API 不稳定）。

### 社区库（DSH 生态插件，学习/可选）

> ⚠️ 社区维护，版本兼容性需自行验证（多数未适配 DSH 0.1.5-rc.2）。**仅作设计参考，不直接依赖**。

| 库名 | 学习点 | 仓库/链接 |
|---|---|---|
| `dsh-state-graph` | StateGraph 引擎：条件边、迭代熔断、子图嵌套、审批门 | [zerosloney/dsh-state-graph](https://github.com/zerosloney/dsh-state-graph) |
| `dsh-node-flow` | 可视化画布：拖拽节点、端口连线、If/Switch/Loop/While | [CodermanYHZ/dsh-node-flow](https://github.com/CodermanYHZ/dsh-node-flow) |
| `dsh-agent-team-gui` | Run Center：计划/成员输出/重试/Token 一界面 | [toolclub/dsh-agent-team-gui](https://github.com/toolclub/dsh-agent-team-gui) |
| `dsh-swarm` | 常驻生命周期、`art://` 工件引用、任务账本看门狗 | [wanghj040530/dsh-swarm](https://github.com/wanghj040530/dsh-swarm) |
| `dsh-expert-orchestrator` | Taskboard + 消息总线 + PM-first 规划 | [mario841859784/dsh-expert-orchestrator](https://github.com/mario841859784/dsh-expert-orchestrator) |
| `dsh-session-pruner` | Session 生命周期管理 | [mrzhangkris/dsh-session-pruner](https://github.com/mrzhangkris/dsh-session-pruner) |
| `dsh-turn-budget` | fail-closed per-turn 资源治理（`maxToolCallsPerTurn`） | [Nunchakus888/dsh-turn-budget](https://github.com/Nunchakus888/dsh-turn-budget) |
| `dsh-discipline-guard` | 四道硬闸门（循环熔断、成本熔断、路由监视、计划门） | [haozheou/dsh-discipline-guard](https://github.com/haozheou/dsh-discipline-guard) |
| `dsh-plugin-product-subagents` | 基于角色的子代理 Provider，`maxConcurrentChildren` 限制 | [shaokeyibb/dsh-plugin-product-subagents](https://github.com/shaokeyibb/dsh-plugin-product-subagents) |
| `dsh-token-stats` | Token 消耗统计面板 | [H1a3x/dsh-token-stats](https://github.com/H1a3x/dsh-token-stats) |
| `dsh-agent-graph` | 图编排 + 结构化交接 + bounded rework + layered ledger | [wrc093/dsh-agent-graph](https://github.com/wrc093/dsh-agent-graph) |

### 外部开源参考（非 DSH 插件）

| 项目 | 核心价值 | 仓库/链接 |
|---|---|---|
| **LangGraph** | StateGraph、checkpoint、conditional edges、循环工作流 | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) |
| **DeerFlow** | 字节跳动 SuperAgent 框架，子代理独立 checkpointer + 并行编排 | [bytedance/deer-flow](https://github.com/bytedance/deer-flow) |
| **MetaGPT** | 固定角色 SOP 流水线 + 结构化文档交接防失真 | [geekan/MetaGPT](https://github.com/geekan/MetaGPT) |
| **ChatDev** | ChatChain 双人对话链 + 角色专属阶段循环 | [OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev) |
| **AutoGen Studio** | 拖拽式 Team Builder + Playground 实时消息流可视化 | [microsoft/autogen](https://github.com/microsoft/autogen) |
| **Orchid** | YAML 驱动 Agent 定义 + 滑动窗口历史摘要压缩 | [orchid-ai](https://pypi.org/project/orchid-ai/) |
| **PACT** | 并发审计协议：文件观察优先、GREEN/YELLOW/RED 信号 | 设计模式参考 |
| **AgentGit / CVC** | 工作流版本控制与回滚 | [AgentGit](https://browse-export.arxiv.org) / [CVC](https://pypi.org/project/cvc/) |

---

## 开发路线图（MVP）

| MVP | 名称 | 关键环节 | 状态 |
|---|---|---|---|
| 0 | 角色资产 | R1-R10 skill | ✅ 已完成 |
| 1 | 单链脚本验证 | 角色编译 + 串行编排 R1→R8，验证角色协作 | ✅ 已完成 |
| 2 | 自研 StateGraph 引擎 | 图 DSL + checkpoint + 条件边 + 循环回退 + 熔断 + 测试 | ✅ 已完成 |
| 3 | 状态+交接+消息+恢复 | 任务树 + handoff + 消息总线 + checkpoint 恢复 + 分账 + 生命周期 + Token 熔断 + 观察者 L2 | ✅ 已完成 |
| 4 | 只读激活看板 | **Web 实时看板** + 图染色 + 审批 + 观察者 + 消息流 + 断点恢复 + **ask_user 主动提问** | ✅ 已完成（问题 1-5 + Bugs-V5 已修复） |
| 5 | 角色导入+画布连边 | YAML 导入解析器 + 拖拽连边 → DSL + 端口规则 + 沙箱隔离 | ⏳ 即将动工 |
| 6 | 打磨 | 恢复加固 / 超时降级 / 记忆压缩 / 对抗评审 / 观察者 L3 | ⏳ |

**质变点 = MVP-2（自研 StateGraph）**：从"一堆 skill"到"编排工具"的跨越发生在这里。
**体验质变点 = MVP-4（Web 实时看板）**：从"跑完看结果"到"实时可看可控"。

---

## 后续阶段待办

### MVP-5（即将动工）

1. **角色导入**：YAML 导入解析器，动态创建/修改角色（复用 `role-loader` 管线）。
2. **画布连边 → DSL**：拖拽角色节点、连线（seq/cond/loop）→ 生成图 DSL；端口规则校验。
3. **D2 侧栏常驻**：看板侧栏常驻显示节点/角色/Token/审批状态。
4. **沙箱隔离**：画布编辑与导入角色的产物隔离。

### MVP-6（打磨）

1. **恢复加固**：冷恢复延迟优化（resident/on-demand/hybrid + 活跃窗口 + SLA 降级）。
2. **超时降级**：工作流超时 → 人工审批节点的完整闭环。
3. **记忆压缩**：长会话滑动窗口摘要（参考 Orchid）。
4. **对抗评审 + 观察者 L3**：深度 LLM 审查（BLOCK/SANITIZE/FLAG）。
5. **并行分支**：`parallel` 边真正落地（当前静态验证暂不支持）。

### 遗留 / 规划项（跨阶段）

1. **Token 硬熔断落地**：`token_budget` 目前仅记录 → 软阈值压缩（80%）、硬阈值降级（100%）实际接入引擎。
2. **`dsh-turn-budget` 接入**：per-turn 资源治理兜底（cordis.patch.yml 配置段已留，插件待适配安装）。
3. **消息总线真实注入**：`MessageBus.send` 的 `sendImpl` 在引擎主循环接通（当前为独立模块 + 测试 + ledger 桥接）。
4. **`graph-service.fromDefinition` 的 role 节点切换为 `addSubagent`**：当前 role 节点是占位 handler，真实子代理走 `weave_run_graph` 的 addSubagent 路径。
5. **Task 树落地**：根 → 子 → 孙任务树持久化（`task-tree.ts` 已备）。
6. **跨进程恢复**：`weave_graph_resume` 依赖同进程 spec-registry，重启后需 spec 持久化。
7. **主 agent 侧 skill**：把"收到 `weave.ask_user` 审批卡时"处理段写入主 agent skill/system prompt（外部配置项）。
8. **角色导入 UI 与「各角色 SKILL.md 其他按需」**：R1 已按 ask_user 重写，其余角色按需跟进。

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| **StateGraph 自研复杂度** | 参考 `dsh-state-graph` 逻辑（不抄码）；MVP-2 只做 seq+cond+loop |
| **冷恢复延迟** | 生命周期 resident/on-demand/hybrid + 活跃窗口 + SLA >10s 降级人工 |
| **循环失控 / 成本爆炸** | 迭代熔断 (25) + 硬 Token 预算 + 人工审批 + `dsh-discipline-guard` 兜底 |
| **Cordis 热重载资源泄漏** | 非 Cordis 管理资源一律 `ctx.effect()` 包装；热重载测试入门禁 |
| **并行/BFS 广度爆炸** | L3 `max_concurrent_children` + 并发闸；全局上限需引擎层自建 |
| **subagent Messages 协议历史 notice 毒化** | 不依赖 subagent settlement notice 恢复；升级前归档 |
| **观察者干扰工作 Agent** | 观察为静默文件读取；fail-open；观察者故障不阻塞主流程 |
| **观察者 Token 失控** | 分级触发 + 观察者独立 Token 预算；超预算降级为 L1 |
| **ask_user 滥用 / 卡死** | prompt 明示"最多 3 次"；`default` 必填；用户不答按 default 继续 |
| **interrupt 与正常流程竞态** | 工具挂 300ms 等 interrupt；`run()` 正常流程 + catch 双处检查 `pendingAskUser` |
| **图版本化缺失** | 图 DSL `graphVersion` + `graphSchemaHash`；checkpoint 版本感知恢复 |
| **Windows 环境特有限制** | 全局安装 `dsh`；避免 `npx`/`pnpm dlx`；路径逃逸防护；scoped Cordis |

---

## 许可证

本项目采用 **MIT License**（暂定，最终以仓库根目录 LICENSE 文件为准）。

---

> **文档版本**：v4（2026-09-27）｜适配 **DSH 0.1.5-rc2 + Windows 11 + Node 24**，插件 `dsh-agent-weave@0.3.2`
> **当前阶段**：MVP-4 已完成（Web 实时看板 + 问题 1-5 + Bugs-V5 `ask_user`），MVP-5 即将动工
> **权威源**：`docs/04-MVP与设计契约.md`、`docs/02-整体设计.md`、`docs/03-能力探测与复用结论.md`、`docs/00-开发计划.md`、`docs/MVP-4/Bugs-v5-user-act.md`
