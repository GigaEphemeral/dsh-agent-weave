# 可视化 Agent 任务编排工具（dsh-agent-weave）

> **一句话目标**：实现一个可视化的 Agent 任务编排工具——用户输入一句话需求，自动拆解为工作流任务图，多角色 subagent 按图协作（含循环与条件回退），激活状态全程可视化，每个 Agent 独立记忆防污染，角色支持画布连线与编辑器创建，节点间以**结构化交接单**传递事实与契约。

[![Status](https://img.shields.io/badge/status-MVP--5B%20%E5%B7%B2%E5%AE%8C%E6%88%90-brightgreen)]()
[![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.2-green)]()
[![Node](https://img.shields.io/badge/Node-%5E22.19%20%7C%7C%20%3E%3D24-green)]()
[![Tests](https://img.shields.io/badge/tests-388%20%E5%85%A8%E7%BB%BF-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-lightgrey)]()

---

## 目录

- [当前状态](#当前状态)
- [开发阶段总览](#开发阶段总览)
- [功能特性](#功能特性)
- [交互方式](#交互方式)
- [代码结构](#代码结构)
- [核心机制](#核心机制)
  - [分层架构](#分层架构)
  - [结构化交接单（方案 B）](#结构化交接单方案-b)
  - [StateGraph 编排引擎](#stategraph-编排引擎)
  - [记忆隔离与角色管线](#记忆隔离与角色管线)
  - [门禁与容错](#门禁与容错)
  - [Web 看板与交互](#web-看板与交互)
- [关键设计决策](#关键设计决策)
- [测试与验证](#测试与验证)
- [开发与部署](#开发与部署)
- [依赖与参考](#依赖与参考)
- [遗留与真实环境项](#遗留与真实环境项)
- [许可证](#许可证)

---

## 当前状态

| 项 | 状态 |
|---|---|
| **当前阶段** | **MVP-5B 已完成 ✅**（结构化交接单方案 B，B1-B7 全过） |
| **版本** | `dsh-agent-weave@0.2.9` |
| **代码规模** | src 约 90 个 TS/TSX 文件；6 角色（R1/R2/R4/R6/R7/R8）；**62 测试文件 / 388 测试全绿** |
| **运行环境** | Windows 11 + DSH **0.1.5-rc.2** + Node 22.23 + pnpm 12.3 |
| **真实环境验证** | 由用户在测试环境 **http://127.0.0.1:3081/** 执行（见 [开发与部署](#开发与部署)） |

**已完成的里程碑**：

| MVP | 内容 | 门禁/验证 |
|---|---|---|
| **0** | 角色资产 R1-R10 skill + 3 横切纪律 | ✅ |
| **1** | 角色 YAML 编译 + 单链编排验证（记忆隔离/toolFilter/产物落盘） | ✅ 四项门禁全过 |
| **2** | 自研 StateGraph 引擎（图 DSL/条件边/循环回退/熔断/checkpoint） | ✅ 循环+熔断+确定性测试 |
| **3** | 状态+交接+消息总线+断点恢复+Token 分账+观察者 L2+审批分级 | ✅ 可恢复/可分账/可对话 |
| **4** | Web 实时看板（D1 按钮+D3 主区）+ 图染色 + 审批 + 消息流 + 恢复 | ✅ 问题 1-5 修复 |
| **5** | 画布编辑器 + 角色库 + 任务面板 + 门禁（环境/输出）+ 输入门禁 + 项目事实 | ✅ 59 文件 / 352 测试 |
| **5B** | **结构化交接单**（方案 B）：交接单 envelope + 引擎注入 + 门禁回写 + 角色契约 + 前端交互 | ✅ 62 文件 / 388 测试 |

---

## 开发阶段总览

```
MVP-0 角色资产 ──▶ MVP-1 单链验证 ──▶ MVP-2 StateGraph 引擎（质变点）
                                          │
                                          ▼
                          MVP-3 状态+交接+消息+恢复
                                          │
                                          ▼
                          MVP-4 Web 实时看板（体验质变点）
                                          │
                                          ▼
                          MVP-5 画布编辑+角色库+门禁
                                          │
                                          ▼
                          MVP-5B 结构化交接单（✅ 当前）
                                          │
                                          ▼
                          MVP-6 打磨+生态（⏳ 未开始）
```

- **质变点 = MVP-2**：从"一堆 skill"到"编排工具"。
- **体验质变点 = MVP-4**：从"跑完看结果"到"实时可看可控"。
- **MVP-5B**：把"上下游节点间的信息传递"从"路径清单"升级为"结构化交接单"，让下游**读得到、不重复探测、能被阻塞**。

---

## 功能特性

- **一句话需求 → 工作流图**：用户输入自然语言需求，自动拆解为可执行的节点任务图（`weave_propose_task`）。
- **画布编辑**：从角色库拖入角色、点击连线（seq）、推荐下一步、节点配置抽屉（模型覆盖/输入门禁/审批/输出约束）、节点编辑器（双击弹窗，可改 roleRef/产物名/门禁）。
- **角色管理**：角色库（搜索/排序/描述）、**角色编辑器**（新建/编辑，provider/model/capabilities/tools 全部动态候选，不硬编码）、角色 YAML 落盘。
- **非线性编排**：顺序、条件分支、循环回退（含迭代熔断），并行边语法预留。
- **记忆纯洁性**：每个 Agent 独立 subagent session（`inheritsParentContext=false`），仅通过产物文件与交接单交接。
- **结构化交接单（MVP-5B）**：
  - 引擎写 `productions/<节点>/handoff.json`（LLM 只写 markdown front-matter，引擎补全 hash/size/source）
  - 下游 prompt 自动注入【上游交接单】：产物契约 / 已确认事实（禁止重复探测）/ 未满足（遇到必须停）/ 指派问题
  - facts 冲突标记（conflict）、unmet **累积式**传递（prev 未解决继续传，curr verified 同 key 才移除）、openIssues 同 id 关闭
  - 前端 HandoffViewer 展示累积交接单（可切按节点查看原始）
- **门禁与容错**：Environment Gate（前置检查，不满足 → 图暂停不静默降级，回写 verified/unmet）、Output Gate（职责越界扫描，回写 scannedArtifacts）、质量门、输入门禁（上游产物存在且非空）。
- **实时看板**：节点状态实时染色、节点活动流、Token 分账（按角色）、审批待办、观察者信号、消息流（零 token）、运行历史、恢复点。
- **运行控制**：启动、暂停、恢复、终止；从 checkpoint 恢复；暂停快照含交接单快照（`projectMemorySnapshot`），恢复不丢上游交接。
- **可观测性**：RunLedger 不可变审计账本（OTel 对齐）、轨迹事件流式落盘、结构化日志、日志过滤/搜索。

---

## 交互方式

1. **输入需求**：聊天中一句话需求 → 主 agent 调 `weave_propose_task` → SSE `task-proposed` → 右侧编辑面板自动滑出（常驻挂载，不依赖看板开关）。
2. **画布编排**：拖入角色节点、点击连线、推荐下一步、双击节点弹编辑器、配置门禁/模型/审批。
3. **角色创建/编辑**：角色库 `+ 新建` / `⚙ 编辑` → 角色编辑器 → 保存落盘 `roles/<id>.yaml` → 角色库立即可见。
4. **实时看板**：图节点实时染色、节点活动、Token 分账、审批、观察者信号、**交接单查看器**。
5. **人工审批**：审批门 / 用户确认弹窗（`ask_user_question` 链路），暂停时用户回答后恢复。
6. **运行控制**：暂停/恢复/终止；从 checkpoint 或暂停快照恢复。

---

## 代码结构

```
3pluginCode/
├── src/
│   ├── index.ts                 # 插件入口（角色注册 + 命令 + 可视化运行时）
│   ├── shared/                  # 类型（RoleDefinition/Zod）+ 结构化日志 + 错误分类
│   ├── cli/                     # DSH 工具命令
│   │   ├── graph-commands.ts    #   weave_graph_validate/show/help/watch/report/status/tail
│   │   ├── graph-run-commands.ts#   weave_run_graph（真实图执行，异步返回 graphId）
│   │   ├── graph-resume-commands.ts # weave_graph_resume（暂停快照恢复）
│   │   ├── graph-visual-commands.ts # 看板/报告命令
│   │   └── propose-commands.ts  #   weave_propose_task（一句话 → 任务草稿）
│   ├── l1-subagent/             # （占位：官方 @deepseek-ai/dsh-subagent 复用）
│   ├── l2-engine/               # ★ 编排引擎
│   │   ├── handoff-schema.ts    #   [B1] 交接单纯 schema + parseFrontMatter + validateEnvelope
│   │   ├── handoff.ts           #   [B1/B2] parse/merge/build + handoff.json IO + 兼容层
│   │   ├── project-memory.ts    #   [B1] 持有全局交接单 envelope + 新/旧 API
│   │   ├── state-graph.ts       #   [B2] 引擎核心：节点注入交接单 + 完成后回写
│   │   ├── environment-gate.ts  #   [B3] 环境门禁 → PreflightResult(verified/unmet)
│   │   ├── output-gate.ts       #   [B3] 输出门禁 → scannedArtifacts(hash/size)
│   │   ├── graph-definition.ts / static-validator.ts / condition-edge.ts
│   │   ├── atomic-merge.ts / concurrency-counter.ts / checkpoint.ts
│   │   ├── message-bus.ts / deadlock-guard.ts / task-tree.ts
│   │   ├── pause-snapshot.ts / types.ts / error-classifier.ts
│   │   ├── subagent-waiter.ts / subagent-events.ts / wait-for.ts / restart.ts
│   │   ├── chain-runner.ts / chain-tool.ts / mvp1-chain.ts   # ⚠️ MVP-1 遗留演示链
│   │   └── graph-service.ts / approval-policy.ts / node-validator.ts
│   ├── l3-roles/                # 角色管理：role-schema / role-loader / lifecycle-manager / workflow-package
│   ├── l4-visual/
│   │   ├── host/                # 可视化宿主
│   │   │   ├── routes.ts        #   REST：/tasks /roles /providers /capabilities /tools /handoff /graphs ...
│   │   │   ├── provider-registry.ts # [B6] provider 三级探测（dynamic/yaml-scan/static）
│   │   │   ├── role-library.ts  #   [B6] 角色库 + saveRoleDefinition 落盘
│   │   │   ├── task-store.ts / graph-store.ts / log-reader.ts / activity-reader.ts
│   │   │   ├── sse-broker.ts / shared-bus.ts / event-bus.ts / event-bridge.ts
│   │   │   ├── approval-service.ts / spec-registry.ts / run-history.ts
│   │   │   ├── artifacts-root.ts / visual-runtime.ts / graph-control.ts
│   │   │   └── html-report.ts / terminal-view.ts / loop-detector.ts
│   │   └── shared/              # 事件 schema
│   ├── client/                  # 前端（React，esbuild 打包）
│   │   ├── index.tsx            # 入口：页头按钮 + 看板 + shell.overlay 常驻挂载（编辑面板/确认弹窗）
│   │   ├── dashboard/
│   │   │   ├── CanvasEditor.tsx #   画布（拖入/连线/推荐/节点编辑器）
│   │   │   ├── RoleLibraryPanel.tsx # 角色库（+新建/⚙编辑）
│   │   │   ├── RoleEditor.tsx   #   [B6] 角色编辑器（动态候选）
│   │   │   ├── HandoffViewer.tsx #  [B6] 交接单查看器
│   │   │   ├── WeaveEditPanel.tsx # 右侧滑出编辑面板（主区挤压 + 进入即 drafting）
│   │   │   ├── UserQuestionModal.tsx / WeaveTaskPanel.tsx / WeaveDashboardView.tsx
│   │   │   ├── GraphCanvas.tsx / ControlBar.tsx / TokenPanel.tsx / ApprovalPanel.tsx
│   │   │   └── SignalPanel.tsx / MessageFlowPanel.tsx / NodeActivityPanel.tsx
│   │   │   └── RunHistoryPanel.tsx / RestorePanel.tsx / canvas-model.ts
│   │   ├── hooks/               # useGraphStream / useActivityFeed
│   │   └── state/ types.ts      # 看板类型
│   ├── l5-observability/        # run-ledger / token-collector
│   └── observers/               # observer-l1 / observer-l2 / signal
├── roles/                       # 6 个角色 YAML（R1/R2/R4/R6/R7/R8）
├── skills/<角色>/SKILL.md       # 角色 prompt（含【必读】上游交接单 +【必写】你的交接单契约）
├── tests/                       # 62 个 spec 文件 / 388 测试
├── test-env/                    # 隔离测试环境 + verify-mvp5.ps1 一键验证
├── docs/                        # 开发计划/契约/MVP 各阶段文档（decisions/探索/...）
├── scripts/build-client.mjs     # 前端 esbuild 打包
├── tsconfig.json / tsconfig.client.json / tsdown.config.ts
└── package.json                 # dsh-agent-weave@0.2.9
```

**产物目录（运行期）**：

```
<workspace>/productions/
├── <节点>/            # 每个图节点一个目录（MVP-5B：无 graph-artifacts 中间层）
│   ├── <artifact>.md  # 节点产物（LLM 输出，含 front-matter）
│   └── handoff.json   # 交接单（引擎写，LLM 不写）
├── traces/            # 轨迹事件流 graph-*.jsonl
└── pauses/            # 暂停快照 <graphId>.json（含 projectMemorySnapshot）
```

---

## 核心机制

### 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│ L5 可观测性层：RunLedger 审计账本 · Token 分账 · 轨迹事件流      │
├──────────────────────────────────────────────────────────────┤
│ L4 可视化层：画布编辑器 · 角色编辑器 · 交接单查看器 · 实时看板    │
├──────────────────────────────────────────────────────────────┤
│ L3 角色管理层：YAML 定义 · 角色库 · 角色编辑器落盘 · 生命周期     │
├──────────────────────────────────────────────────────────────┤
│ L2 编排引擎层：StateGraph · 交接单(handoff) · 门禁 · checkpoint  │
├──────────────────────────────────────────────────────────────┤
│ L1 执行与记忆层（官方 @deepseek-ai/dsh-subagent）              │
└──────────────────────────────────────────────────────────────┘
```

### 结构化交接单（方案 B）

**机制与内容分离**：平台只提供【机制】（字段结构/解析语法/合并语义/prompt 模板/探测接口），不提供【内容】（键名约定/值/领域术语由角色层与 LLM 运行时填充）。

**三层分工**：

| 层 | 负责 | 示例 |
|---|---|---|
| 平台层 | schema、解析、注入、合并 | `HandoffEnvelope` 字段定义 |
| 角色层 | 键名规范、必填项、交互约定 | "环境事实用 `<domain>.<entity>.<attr>` 三层命名" |
| 数据层 | 具体内容 | LLM 探测/生成的结果 |

**数据流**：节点完成 → 解析产物 front-matter → 补全 hash/size/source → 写 `handoff.json` → 合并进全局 `ProjectMemory` → 下一节点启动时注入【上游交接单】→ 下游不重复探测、遇 unmet 停止、处理指派问题。

**合并语义（用户决策）**：facts 冲突标 conflict；verified 同 key 保留最新；**unmet 累积式**（prev 未解决继续传，curr verified 同 key 才移除）；openIssues 同 id 关闭；handoff.upstream 累积去重。

### StateGraph 编排引擎

- 自研引擎（非 workflowEngine script）：`addNode / addSubagent / addEdge / addLoopEdge / addConditionalEdge / addApprovalGate / run`。
- 节点返回 `Partial<State>`，引擎原子合并（冲突 reject-on-conflict）。
- 迭代熔断（默认 25）+ 边级熔断 + 全局并发闸（排队）。
- checkpoint 在"补丁合并后、跳转前"，落盘 loopUsage；恢复时读回。
- 轨迹事件 8+ 种（graph/* 契约），可选流式落盘 traces/*.jsonl。

### 记忆隔离与角色管线

- 角色 YAML → Zod 校验 → `compileRoleToProvider`（persona/toolFilter/agentOptions/inheritsParentContext）。
- 子代理 `startContinuable` 建 durable child（同节点复用，循环回退 sendMessage 追加反馈）。
- 输入门禁：上游产物存在且非空才启动节点。

### 门禁与容错

- **Environment Gate**：节点启动前逐条执行 preflight；不满足 → `EnvironmentGateError`（携带 unmet）→ 图暂停等待用户决策（禁止静默降级）；满足 → verified 回写交接单。
- **Output Gate**：产物落盘后扫描（仅 .md / 禁止扩展名 / 禁止内容特征），失败 → permission-denied 暂停；scannedArtifacts（hash/size）回写交接单。
- **质量门**：产物非空/数量验证，失败 → 节点失败整图停。
- **错误分类**：permission/dependency/budget/timeout/environment-gate → 需人工介入 → 暂停快照 + 通知。

### Web 看板与交互

- **常驻挂载**（决策 #8）：编辑面板 + 用户确认弹窗挂 `shell.overlay`，不依赖看板开关。
- **主区挤压**（决策 #7）：面板打开时 `body.weave-panel-open` → 主区 margin-right 720px，主 agent 仍可见。
- **进入即 drafting**（决策 #9）：面板打开即 PATCH 任务状态。
- **动态候选**（B6 反例）：前端 provider/model/capabilities/tools 全部来自 REST 探测，0 硬编码。

---

## 关键设计决策

| 决策点 | 结论 |
|---|---|
| 编排引擎 | ✅ 自研 StateGraph（非 workflowEngine script） |
| 运行时底座 | ✅ 分层复用：subagents（执行）+ 自建（引擎/角色/画布/治理）；不依赖 experimental agentTeams |
| 交接单写入 | ✅ handoff.json 由引擎写，LLM 只写 front-matter（结构稳定） |
| 交接单载体 | ✅ front-matter 而非独立 JSON（LLM 更熟悉，文件随 md 移动） |
| unmet 合并 | ✅ **累积式**（用户决策：prev 未解决继续传递，curr verified 同 key 才移除） |
| 产物目录 | ✅ `productions/<节点>/`（用户决策：无 graph-artifacts 中间层，与文档验收一致） |
| 面板常驻 | ✅ shell.overlay 常驻挂载（真实 Slot 树；设计文档的 app.root 为占位） |
| 前端候选值 | ✅ 全动态探测，0 硬编码 provider id / 工具名 |
| 依赖方向 | ✅ 严格单向：handoff-schema ← handoff ← project-memory ← state-graph |
| 兼容层 | ✅ 旧 API（Handoff 四字段 / setFact 等）保留为 deprecated 转发 |

---

## 测试与验证

- **62 测试文件 / 388 测试全绿**（Vitest），覆盖：handoff（parse/merge/build/inject）、门禁（环境/输出）、引擎（路由/循环/熔断/恢复/事件）、角色（加载/并发）、可视化（REST/SSE/看板）、生命周期（热重载）。
- **`pnpm typecheck`**：0 error（strict + NodeNext ESM + verbatimModuleSyntax）。
- **`pnpm build`**：通过（host tsc + client esbuild IIFE，client bundle ~112KB）。
- **一键复验**：`pwsh -File test-env/verify-mvp5.ps1`（typecheck + build + 全量单测）。
- **反例验收（planB 10.4）**：前端代码 0 硬编码 provider id / 工具名；平台新代码 0 领域术语；handoff.ts 不导入 project-memory（编译错误验证）。

---

## 开发与部署

### 本地验证

```powershell
cd 3pluginCode
pnpm install
pnpm typecheck   # 0 error
pnpm build       # lib/index.js + lib/client.js
pnpm vitest run  # 388 tests
```

### 打包发布

```powershell
pnpm pack --pack-destination ./dist   # 产出 dist/dsh-agent-weave-0.2.9.tgz
```

### 测试环境重部署（3081）

```powershell
# 1. 删 profile 里已装的包
cd D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home\profiles\weave-test
Remove-Item -Recurse -Force ".\node_modules\dsh-agent-weave" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force ".\node_modules\.pnpm\dsh-agent-weave*" -ErrorAction SilentlyContinue

# 2. 清 pnpm store 里所有 dsh-agent-weave 相关
pnpm store prune

# 3. 卸载 profile 里声明的依赖
pnpm remove dsh-agent-weave

# 4. 重新安装 0.2.9 并启动
node $dshBin plugin --profile weave-test add "D:\dsharness\agentDev\softwareEngnieering\3pluginCode\dist\dsh-agent-weave-0.2.9.tgz"
pnpm add "file:D:/dsharness/agentDev/softwareEngnieering/3pluginCode/dist/dsh-agent-weave-0.2.9.tgz"
node $dshBin --profile weave-test --port 3081
```

> 真实 E2E（真实 LLM）由用户在 3081 执行；开发环境禁止高强度调用测试环境大模型。

---

## 依赖与参考

### 官方库（DeepSeek Harness 官方）

| 库名 | 用途 |
|---|---|
| `@deepseek-ai/dsh-subagent` | 持久化子代理（startContinuable / sendMessage / interrupt） |
| `@deepseek-ai/dsh-tools` | 工具注册（defineTool） |
| `@deepseek-ai/dsh-agent` | Agent 最小形态（父代理上下文） |
| `@deepseek-ai/cordis` | 插件框架（scoped，无双 Cordis 分裂） |

### 外部开源参考（设计借鉴，非直接依赖）

| 项目 | 借鉴点 |
|---|---|
| LangGraph | StateGraph、checkpoint、conditional edges、循环工作流 |
| dsh-agent-graph | 结构化交接（summary/artifacts/openIssues）注入直接下游；分层全局账本 |
| MetaGPT | 固定角色 SOP 流水线 + 结构化文档交接防失真 |
| dsh-node-flow / AutoGen Studio | 拖拽式画布、节点属性面板、导入导出 |
| PACT | 并发审计协议：文件观察优先、GREEN/YELLOW/RED 信号 |

---

## 遗留与真实环境项

| 项 | 说明 | 归属 |
|---|---|---|
| **真实 LLM E2E** | 一句话 → 面板 → 开始 → 交接单累积 → HandoffViewer（用户 3081 实测） | 用户 |
| **角色编辑器实测** | 新建角色落盘 → 角色库可见 → 画布可拖入 | 用户 |
| **交接单注入实测** | 下游 prompt 含【上游交接单】；verified 不重复探测；unmet 阻塞暂停 | 用户 |
| **恢复实测** | 暂停 → 恢复后 projectMemorySnapshot 重建，交接单不丢 | 用户 |
| **PR-5.6 自动激活** | shell.overlay 常驻已实现；宿主自动打开看板待真实环境确认 | 待探测 |
| **mvp1-chain.ts** | ⚠️ **MVP-1 遗留演示链**（ETF/腾讯 API 演示内容）；仅 `weave_run_chain` 工具调用，不影响本体引擎/交接单/看板；B1-B7 范围外未重构 | 遗留 |
| **观察者 L3 / 记忆压缩 / 并行边** | MVP-6 内容，未开始 | MVP-6 |
| **版本号** | 代码层 0.2.9 未 bump（MVP-5B 未涉及发布版本号决策） | 待定 |

---

## 许可证

本项目采用 **MIT License**（暂定，最终以仓库根目录 LICENSE 文件为准）。

---

> **文档版本**：v4（2026-09-26）｜适配 **DSH 0.1.5-rc.2 + Windows 11 + Node 22**
> **当前阶段**：MVP-5B 已完成（结构化交接单），MVP-6 打磨+生态待动工
> **权威源**：`docs/04-MVP与设计契约.md`、`docs/02-整体设计.md`、`docs/00-开发计划.md`、`docs/001-开发契约.md`、`docs/MVP-5B/MVP-5planB.md`
