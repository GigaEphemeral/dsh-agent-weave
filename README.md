# 可视化 Agent 任务编排工具

> **一句话目标**：实现一个可视化的 Agent 任务编排工具——用户输入一句话需求，自动拆解为工作流任务图，多角色 subagent 按图协作（含循环与条件回退），激活状态全程可视化，每个 Agent 独立记忆防污染，可互相对话，角色支持导入文件创建与画布连线。

[![Status](https://img.shields.io/badge/status-MVP%20设计阶段-blue)]()
[![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.1%2B-green)]()
[![License](https://img.shields.io/badge/license-TBD-lightgrey)]()

---

## 目录

- [功能特性](#功能特性)
- [交互方式](#交互方式)
- [实现方案简述](#实现方案简述)
  - [分层架构](#分层架构)
  - [核心对象模型](#核心对象模型)
  - [StateGraph 编排引擎](#stategraph-编排引擎)
  - [记忆隔离机制](#记忆隔离机制)
  - [消息总线与防死锁](#消息总线与防死锁)
  - [观察者机制](#观察者机制)
  - [Token 熔断与优化](#token-熔断与优化)
- [关键设计决策](#关键设计决策)
- [依赖与参考](#依赖与参考)
  - [官方库（DeepSeek Harness 官方）](#官方库deepseek-harness-官方)
  - [社区库（DSH 生态插件，学习/可选）](#社区库dsh-生态插件学习可选)
  - [外部开源参考（非 DSH 插件）](#外部开源参考非-dsh-插件)
- [开发路线图（MVP）](#开发路线图mvp)
- [风险与缓解](#风险与缓解)
- [许可证](#许可证)

---

## 功能特性

- **一句话需求 → 工作流图**：用户输入自然语言需求，自动拆解为可执行的节点任务图。
- **非线性编排**：支持顺序、条件分支、循环回退（如开发→测试→审核→开发循环）与并行分支（预留）。
- **激活状态可视化**：实时展示谁在运行、等待谁、产出什么，节点状态（idle/pending/running/waiting/done/error）实时染色。
- **记忆纯洁性**：每个 Agent 拥有独立 subagent session，不共享上下文，仅通过文件与消息交接，防止污染。
- **Agent 间定向对话**：支持 Agent 之间定向消息传递（handoff / query / feedback / escalation），由编排器中转，具备防死锁机制。
- **角色自定义**：支持通过 YAML 文件导入角色定义（特质、工具、模型、质量门、Token 预算、handoff 依赖），并通过画布连线定义交互逻辑。
- **观察者机制（新增）**：可配置并发观察者（如质量观察者）在节点执行过程中静默监视产出，按关注级别发出 GREEN/YELLOW/RED 信号，实现早期偏离预警。
- **Token 消耗监控与熔断**：分账到角色与节点，支持软/硬阈值熔断，并提供 `art://` 工件引用等 Token 优化。
- **可恢复与可审计**：基于 checkpoint 的断点恢复，RunLedger 不可变审计账本，事件流对齐 OpenTelemetry 语义。

---

## 交互方式

1. **输入需求**：用户在 Web UI 中输入一句话需求，系统自动生成初始工作流图。
2. **画布编排**：用户可在画布上拖拽角色节点、连线定义交互（顺序/条件/循环），并配置循环退出条件与熔断阈值。
3. **角色导入**：通过导入 YAML 角色文件，动态创建新角色或修改现有角色元数据（特质、工具、模型、质量门等）。
4. **实时看板**：
   - 节点状态实时染色，展示当前激活的 Agent。
   - 查看每个节点的 Token 消耗、执行时长、产出物引用。
   - 观察者信号（GREEN/YELLOW/RED）在画布上可视化，并记录关注度热力图。
5. **人工审批**：分级审批机制（L1 轻量异步、L2 标准同步、L3 紧急同步+告警），用户可干预循环回退或异常终止。
6. **运行控制**：支持启动、暂停、恢复、中断工作流，从最近 checkpoint 恢复执行。

---

## 实现方案简述

### 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│ L5 可观测性与治理层                                            │
│  执行轨迹追踪 · RunLedger 审计账本 · 策略合规 · 成本熔断         │
├──────────────────────────────────────────────────────────────┤
│ L4 可视化层                                                    │
│  画布编辑器 · 实时激活状态 · Token 监控 · 观察者信号展示          │
├──────────────────────────────────────────────────────────────┤
│ L3 角色管理层                                                  │
│  YAML 配置 · 角色导入 · 观察者配置 · 生命周期与并发限制           │
├──────────────────────────────────────────────────────────────┤
│ L2 编排引擎层（自研 StateGraph）                                │
│  图 DSL · 条件边 · 循环回退 · 迭代熔断 · checkpoint · 消息总线    │
├──────────────────────────────────────────────────────────────┤
│ L1 执行与记忆层（官方 @deepseek-ai/dsh-subagent）               │
│  Continuable 子代理 · 独立 Session · 记忆隔离 · 持久化            │
└──────────────────────────────────────────────────────────────┘
```

- **复用层**：L1 直接使用官方 `@deepseek-ai/dsh-subagent`，无需自研记忆隔离。
- **自建层**：L2 自研 StateGraph 引擎，L3 角色管理，L4 可视化，L5 可观测与治理。

### 核心对象模型

| 对象 | 定义 | 落点 |
|---|---|---|
| **Agent（角色）** | 特质 + 工具 + 模型 + 质量门 + 预算 + 观察者配置 | `R1-R10 skill`（Prompt 内容）+ `YAML` 元数据 |
| **Workflow（图）** | 节点 = 角色/任务，边 = 顺序/条件/循环/并行 | 图 DSL（JSON） |
| **Task（任务实例）** | 一句话 → 根任务 → 子任务树 | 任务树（storageDomain） |
| **State（共享状态）** | Phase / active_agent / artifacts / 质量门 / retry 计数 | `DevTeamState` |
| **Memory（角色记忆）** | 每 Agent 独立 context + 交接物 | 独立 subagent session + 工作区文件 |
| **RunLedger（运行账本）** | 不可变事件流：节点事件 + Token 分账 + 合规状态 + 人工介入 | storageDomain（只追加） |

### StateGraph 编排引擎

- **状态定义**：`DevTeamState` 包含 `messages[]`、`current_phase`、`active_agent`、`artifacts{}`、`quality_gate_status`、`retry_count`、`max_iterations`（默认 25 熔断）。
- **图 DSL**：`GraphDefinitionSpec` 定义 `nodes`（角色/条件/审批）、`edges`（seq/cond/loop/parallel）、`checkpoint` 策略、`metadata`（source / graphVersion）。
- **原子合并**：节点只返回 `Partial<State>`，引擎统一原子合并，保证可恢复性与一致性。
- **条件边与循环**：质量审核输出 `retry` → 回退到开发节点并递增 `retry_count`；达到 `max_iterations` → 强制进入人工审批节点。
- **并行分支**：预留 `parallel` 边语法，MVP-2 仅实现串行 + 条件 + 循环。
- **静态验证器**：加载图 DSL 时检查节点/边引用一致性，毫秒级捕获集成错误。

### 记忆隔离机制

- **官方能力直接复用**：每个角色通过 `startContinuable()` 创建持久化子代理，`inheritsParentContext=false` 确保全新隔离上下文。
- **交接双通道**：
  - 产出物 = 文件（durable），落盘至共享工作区，通过 `art://` 引用传递。
  - 即时协商 = 消息（transient），通过 `sendMessage` 定向发送。
- **不共享 context**：Agent 之间不读取彼此的推理过程，只读取文件系统和工作产出。

### 消息总线与防死锁

- **父代理中转**：A → 父（编排器）→ B，父代理解析目标并转发。
- **防死锁分级恢复**：
  - 单条消息超时 → 重试（最多 2 次）。
  - 同一 Agent 在同链路被触发 ≥3 次 → 强制终止链路 + 写入 RunLedger。
  - 整个工作流超时 → 降级到人工审批节点。

### 观察者机制

观察者是**正交增强层**，不改变图拓扑，与质量审核节点互补。

| 层级 | 模式 | 触发时机 | 介入方式 | Token 开销 |
|---|---|---|---|---|
| **L1 轻量检查** | 中间件拦截 | 每个节点执行前后 | 纯函数检查（格式、权限、命名规范），不调用 LLM | 零 |
| **L2 静默观察** | 并发审计者 | 每个角色节点完成后 | 文件观察（`git diff`、读取产出），按关注级别发信号 | 低（仅在发现关注时调用 LLM） |
| **L3 深度审查** | 流式观察者 | 质量门节点、循环回退前 | 完整 LLM 审查，返回 BLOCK/SANITIZE/FLAG | 高（按需启用） |

- **观察者原则**：只读、非阻塞、文件观察优先、记忆隔离、分级介入、fail-open。
- **信号分级**：GREEN（继续） / YELLOW（记录并标记） / RED（触发早期回退）。
- **配置示例**（YAML 扩展）：
  ```yaml
  observers:
    - id: quality-observer
      role_ref: "R8-quality"
      observe_nodes: ["R3-develop", "R5-test"]
      observation_mode: file-watch
      intervention_mode: flag-only
      criteria: [architecture-drift, requirement-alignment]
      dispatch_conditions:
        variety_score_gte: 7
        parallel_coders_gte: 3
      token_budget: 10000
  ```

### Token 熔断与优化

- **熔断机制**：
  - 软阈值 80% → 上下文压缩 / 滑动窗口摘要。
  - 硬阈值 100% → 人工审批 / 降级。
  - 优先复用官方 `@deepseek-ai/dsh-agent-budget`，挂载 `dsh-discipline-guard` 作为兜底。
- **优化措施**：
  - System Prompt 分离不变/可变部分，使用 Prompt Caching。
  - `art://` 工件引用：长产出落盘，消息只传引用 + 紧凑语义摘要。
  - 循环回退只传结构化 diff，分层审核（轻量初筛 + 重模型终审）。
  - 看板推送仅含增量（nodeId + status），完整 State 按需拉取。

---

## 关键设计决策

| 决策点 | 结论 |
|---|---|
| 编排引擎 | ✅ 自研 StateGraph（非 workflowEngine script） |
| 运行时底座 | ✅ 分层复用：subagents（执行）+ 自建（引擎/角色/画布/治理）；**不依赖 experimental agentTeams** |
| 角色定义 | ✅ YAML 元数据 + `system_prompt_ref` 指向 skill 文件 |
| 开发路径 | ✅ 纯 Host CLI 先行（MVP-1/2 不碰 UI） |
| 编排 vs 可视化 | ✅ 编排（MVP-2）前置于可视化（MVP-4） |
| 观察者机制 | ✅ 作为正交增强层，MVP-2 实现 L1，MVP-3 实现 L2，MVP-6 按需 L3 |

---

## 依赖与参考

### 官方库（DeepSeek Harness 官方）

| 库名 | 用途 | 来源标注 | 仓库/链接 |
|---|---|---|---|
| `@deepseek-ai/dsh-subagent` | 持久化子代理服务，提供 `startContinuable` / `sendMessage` / `interrupt` 等 | **官方稳定版** | [deepseek-harness/packages/subagent](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent) |
| `@deepseek-ai/dsh-tool-subagent` | 将 subagent 能力暴露为模型可调用工具 | **官方稳定版** | 同上 |
| `@deepseek-ai/dsh-agent-budget` | 原生 Harness 的 Agent 树 Token 预算插件，durable session + descendant-tree scopes | **官方 bundle** | [vibeinging/dsh-agent-budget](https://github.com/vibeinging/dsh-agent-budget) |
| `@deepseek-ai/dsh-goal` | 目标跟踪服务（`ctx.goals`） | **官方稳定版** | `deepseek-harness/packages/goal/` |
| `dsh-jobs` / `dsh-jobs-local` | 后台任务注册表（`ctx.jobs`，九方法契约） | **官方稳定版** | `deepseek-harness/packages/jobs/` |

> **官方实验性包（不推荐作为核心依赖）**：`@deepseek-ai/dsh-experimental-agent-team`（不支持循环工作流，API 不稳定）。

### 社区库（DSH 生态插件，学习/可选）

> ⚠️ 以下为社区维护插件，版本兼容性需自行验证（多数未适配 DSH 0.1.5-rc.1+）。**仅作设计参考，不直接依赖**。

| 库名 | 学习点 | 来源标注 | 仓库/链接 |
|---|---|---|---|
| `dsh-state-graph` | StateGraph 引擎：条件边、迭代熔断、子图嵌套、审批门 | 社区（zerosloney） | [zerosloney/dsh-state-graph](https://github.com/zerosloney/dsh-state-graph) |
| `dsh-node-flow` | 可视化画布：拖拽节点、端口连线、If/Switch/Loop/While | 社区（CodermanYHZ） | [CodermanYHZ/dsh-node-flow](https://github.com/CodermanYHZ/dsh-node-flow) |
| `dsh-agent-team-gui` | Run Center：计划/成员输出/重试/Token 一界面 | 社区（toolclub） | [toolclub/dsh-agent-team-gui](https://github.com/toolclub/dsh-agent-team-gui) |
| `dsh-swarm` | 常驻生命周期、`art://` 工件引用、任务账本看门狗 | 社区（wanghj040530） | [wanghj040530/dsh-swarm](https://github.com/wanghj040530/dsh-swarm) |
| `dsh-expert-orchestrator` | Taskboard + 消息总线 + PM-first 规划 | 社区（mario841859784） | [mario841859784/dsh-expert-orchestrator](https://github.com/mario841859784/dsh-expert-orchestrator) |
| `dsh-session-pruner` | Session 生命周期管理（自动归档 one-shot / continuable） | 社区（mrzhangkris） | [mrzhangkris/dsh-session-pruner](https://github.com/mrzhangkris/dsh-session-pruner) |
| `dsh-turn-budget` | fail-closed per-turn 资源治理（`maxToolCallsPerTurn`） | 社区（Nunchakus888） | [Nunchakus888/dsh-turn-budget](https://github.com/Nunchakus888/dsh-turn-budget) |
| `dsh-discipline-guard` | 四道硬闸门（循环熔断、成本熔断、路由监视、计划门） | 社区（haozheou） | [haozheou/dsh-discipline-guard](https://github.com/haozheou/dsh-discipline-guard) |
| `dsh-plugin-product-subagents` | 基于角色的子代理 Provider，`maxConcurrentChildren` 限制 | 社区（shaokeyibb） | [shaokeyibb/dsh-plugin-product-subagents](https://github.com/shaokeyibb/dsh-plugin-product-subagents) |
| `dsh-token-stats` | Token 消耗统计面板（柱状图/饼图/热力图） | 社区（H1a3x） | [H1a3x/dsh-token-stats](https://github.com/H1a3x/dsh-token-stats) |
| `dsh-agent-graph` | 图编排 + 结构化交接 + bounded rework + layered ledger | 社区（wrc093） | [wrc093/dsh-agent-graph](https://github.com/wrc093/dsh-agent-graph) |

### 外部开源参考（非 DSH 插件）

| 项目 | 核心价值 | 来源标注 | 仓库/链接 |
|---|---|---|---|
| **LangGraph** | StateGraph、checkpoint、conditional edges、循环工作流 | 外部开源（LangChain） | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) |
| **DeerFlow** | 字节跳动 SuperAgent 框架，子代理独立 checkpointer + 并行编排 | 外部开源（字节跳动） | [bytedance/deer-flow](https://github.com/bytedance/deer-flow) |
| **MetaGPT** | 固定角色 SOP 流水线 + 结构化文档交接防失真 | 外部开源 | [geekan/MetaGPT](https://github.com/geekan/MetaGPT) |
| **ChatDev** | ChatChain 双人对话链 + 角色专属阶段循环 | 外部开源 | [OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev) |
| **AutoGen Studio** | 拖拽式 Team Builder + Playground 实时消息流可视化 | 外部开源（Microsoft） | [microsoft/autogen](https://github.com/microsoft/autogen) |
| **Orchid** | YAML 驱动 Agent 定义 + 滑动窗口历史摘要压缩 | 外部开源 | [orchid-ai](https://pypi.org/project/orchid-ai/) |
| **PACT** | 并发审计协议：文件观察优先、GREEN/YELLOW/RED 信号 | 外部参考（设计模式） | 见文档描述 |
| **AgentGit / CVC** | 工作流版本控制与回滚 | 外部开源 | [AgentGit](https://browse-export.arxiv.org) / [CVC](https://pypi.org/project/cvc/) |

---

## 开发路线图（MVP）

| MVP | 名称 | 关键环节 | 门禁 |
|---|---|---|---|
| 0 | 角色资产 | R1-R10 skill 已完成 | 已过 |
| 1 | 单链脚本验证 | workflowEngine 脚本串行 R1→R8，验证角色协作 | 多角色顺序跑通真实小任务 |
| 2 | **自研 StateGraph 引擎** | 图 DSL + checkpoint 契约 + 条件边 + 循环回退 + 熔断 + BDD/mock 测试 | 循环 DSL 跑通 + 循环退出/熔断双生效 + 路由确定性测试 |
| 3 | 状态+交接+消息+恢复 | 任务树持久化 + handoff + 消息总线 + checkpoint 恢复 + 分账 + 生命周期 + Token 熔断 + 观察者 L2 | 中断可恢复、交接可追溯、按角色分账、跨角色对话可达 |
| 4 | 只读激活看板 | 节点状态事件流（OTEL 对齐）+ 图渲染 + 审批面板 + 观察者信号展示 | 全程图节点实时染色 |
| 5 | 角色导入+画布连边 | YAML 导入解析器 + 拖拽连边 → DSL + 端口规则 + 沙箱隔离 | 零代码搭自定义团队跑通 |
| 6 | 打磨 | 恢复加固 / 超时降级 / 记忆压缩 / 对抗评审 / 观察者 L3 | 全套门禁 |

**观察者机制集成**：MVP-2 实现 L1 轻量检查（零 Token）；MVP-3 实现 L2 静默观察（低 Token）；MVP-4 展示观察者信号；MVP-6 按需实现 L3 深度审查。

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| **StateGraph 自研复杂度** | 参考 `dsh-state-graph` 逻辑（不抄码）；MVP-2 只做 seq+cond+loop |
| **冷恢复延迟** | 生命周期 resident/on-demand/hybrid + 活跃窗口 + SLA >10s 降级人工 |
| **循环失控 / 成本爆炸** | 迭代熔断 (25) + 硬 Token 预算 + 人工审批 + `dsh-discipline-guard` 兜底 |
| **Cordis 热重载资源泄漏** | 非 Cordis 管理资源一律 `ctx.effect()` 包装；热重载测试入门禁 |
| **并行/BFS 广度爆炸** | L3 `max_concurrent_children` + `dsh-turn-budget` 兜底；全局上限需引擎层自建 |
| **subagent Messages 协议历史 notice 毒化** | 不依赖 subagent settlement notice 恢复；升级前归档 |
| **观察者干扰工作 Agent** | 80%+ 观察为静默文件读取；fail-open；观察者故障不阻塞主流程 |
| **观察者 Token 失控** | 分级触发 + 观察者独立 Token 预算；超预算降级为 L1 |
| **图版本化缺失** | 图 DSL 增加 `graphVersion`；参考 AgentGit / CVC 的版本控制语义 |

---

## 许可证

本项目采用 **MIT License**（暂定，最终以仓库根目录 LICENSE 文件为准）。

---

> **文档版本**：v1（2026-09-22）｜整合自整体设计 v4、MVP 与设计契约、观察者机制设计文档及多轮查漏补缺。
> **权威源**：`docs/04-MVP与设计契约.md`、`docs/02-整体设计.md`、`docs/03-能力探测与复用结论.md`。