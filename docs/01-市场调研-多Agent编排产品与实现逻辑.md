# 市场调研：多 Agent 编排 / 可视化工作流产品与实现逻辑

> 调研时间：2026-09-22 ｜ 目的：支撑"可视化 Agent 任务编排工具"的需求收敛与架构选型
> 调研方式：web_search + web_fetch 官方文档 ｜ 证据等级：📘官方 / 📊行业 / ⚠️假设 / 🧪需实测

---

## 一、产品分类图谱（全景四族）

| 族 | 代表 | 形态 | 谁定义工作流 | 典型用户 |
|---|---|---|---|---|
| A. 编排框架/库 | LangGraph、CrewAI、OpenAI Agents SDK、AutoGen/MS Agent Framework | 代码 SDK | 开发者写代码 | AI 工程师 |
| B. 可视化编排平台 | Dify、Coze、n8n、Langflow、Flowise、LangSmith Studio | 画布/低代码 | 用户在画布拖拽 | 业务/低代码用户 |
| C. 编码助手内建 agent 团队 | Claude Code subagents、Cline、DSH `agentTeams/subagents` | 宿主内建 | 配置文件/preset | 开发者 |
| D. 软件工程专用多Agent团队 | MetaGPT、ChatDev | 代码 SDK + 结构化 SOP | 框架内置角色与流程 | 研究者/开发者 |

**定位判断**：我们的最终目标（可视化 agent 任务编排工具，跑在 DSH 上）横跨 B（可视化画布）+ C（复用 DSH 原生 subagent 执行）+ D（角色技能驱动的 SOP 团队）。B 族告诉我们"画布+节点连线"的产品形态，C 族告诉我们"独立 subagent 记忆隔离"的执行底座，**D 族与我们最接近**——已验证"固定角色集合 + SOP 驱动 + 结构化文档交接"范式可行（我们的 R1-R9 是其扩展版）。

---

## 二、核心实现逻辑提炼（七个通用抽象）

跨产品反复出现的抽象，是我们架构的直接素材：

### 抽象 1：图（Graph / DAG）
- **通用做法**：节点 = agent/任务/工具，有向边 = 流转关系；在此基础上加**条件边**（router 决定下一步）和**循环边**（回到上游）。
- **LangGraph**：StateGraph，节点+边，`add_conditional_edges` 支持循环与分支。📘 [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview)
- 对应本项目：Workflow 图 DSL（节点=角色，边=顺序/条件/循环）。

### 抽象 2：共享状态（State）+ Reducer
- **LangGraph**：全图一个显式 `State`（TypedDict/Pydantic），节点读写它，多分支写同一字段靠 **reducer** 合并；状态流经每个节点，是"图级别的共享记忆"。📘 [LangGraph Checkpointers/Persistence](https://docs.langchain.com/oss/python/langgraph/checkpointers)
- 对应本项目：任务树 + 工作区产出物 = 团队级共享状态（有意的、收敛的），与"私有记忆"隔离。

### 抽象 3：握手协议（Handoff，控制权移交）
- **OpenAI Agents SDK**：每个 Agent = instructions + tools + `handoffs`（可移交的 agent 列表）；一个 agent 把对话控制权**移交**给另一个 agent（非广播），新 agent 拿到历史消息继续。📘 [OpenAI orchestration & handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration)
- 对应本项目：角色间的"交接物 + 消息"双通道；关键点在于**交接是定向的、带上下文的**，而非全员广播。

### 抽象 4：记忆隔离（独立 context window）
- **Claude Code subagents**：每个 subagent **以全新、隔离的 context window 开始**，不继承主会话全部历史，只接收任务描述 + 文件系统交接。📘 [Claude Code sub-agents](https://code.claude.com/docs/sub-agents)
- **DSH 原生**：`subagents`/`agentTeams` 每个 worker 独立 session，天然同构。
- 对应本项目：**"记忆纯洁性防污染"的行业范本就是独立 context window + 文件交接**，与用户需求完全对齐。

### 抽象 5：持久化 checkpointer（断点/恢复/time-travel）
- **LangGraph**：每个 super-step 后把 state 快照写 checkpointer，支撑断点恢复、`human-in-the-loop` 暂停、time-travel 回滚。📘 [LangGraph Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers)
- 对应本项目：P0-3 的"重启恢复 + 卡顿登记"，即把"当前激活状态"可持久化、可恢复。

### 抽象 6：SOP 驱动的流水线
- **MetaGPT**：把人类软件工程 SOP 编码进 agent prompt，任务拆成模块化子任务分派给模拟专业角色的 agent。📘
- **ChatDev**：核心通信 = **ChatChain**——每阶段在角色专属的两个 agent 之间"双人对话"，顺序交换结构化 JSON 消息（输出 + 上下文更新），同时指导"该沟通什么"+"如何沟通"（communicative dehallucination）。📘
- 对应本项目：8 阶段流程（需求→架构→测试用例→开发→回归→复盘）本质是 SOP；L2 StateGraph 的节点顺序 + 条件边 = **SOP 的图化表达**。差异：它们 SOP **硬编码**，我们**画布可编排** = 核心差异化。

### 抽象 7：共享文档存储（结构化交接防失真）
- **MetaGPT**：通信**不是直接消息**，每个 agent 把结构化文档写入共享存储、读角色依赖的文档；边由"读取顺序"诱导（隐式边），而非字面路由链。消息协议 = 固定文档格式（先需求文档→带接口设计→任务列表→代码），与自由对话**对立**，防交接失真。📘
- 对应本项目：这是 handoff 四字段 + `productions/<角色>/` 的行业范本。结论很关键：**结构化文档交接比自由对话更能防信息失真**。我们的设计（handoff 只读上游、产出落盘、消息只传引用+摘要）与之一致，且保留了"协商"通道，比纯文档更灵活。⚠️

---

## 三、逐框架实现逻辑详表

| 框架/产品 | 编排模型 | 状态/记忆 | 循环/条件 | 可视化 | 证据 |
|---|---|---|---|---|---|
| **LangGraph** | StateGraph（节点+边） | 共享 State + reducer + checkpoint + store（长期记忆） | 条件边 + 循环边（强） | LangSmith Studio | 📘 |
| **CrewAI** | Crew = agents + tasks + process（sequential/hierarchical） | 短期 RAG + 长期 SQLite 嵌入；task 有 expected_output + context 依赖 | 顺序/层级为主，循环弱 | 无原生画布 | 📘 [crews concept](https://docs.crewai.com/v1.15.18/ko/concepts/crews) |
| **OpenAI Agents SDK** | 扁平 agent + handoff 动态路由（无强制图） | Session 管理对话，可 resume | handoff 可环回 | 无原生画布 | 📘 |
| **AutoGen / MS Agent Framework** | GroupChat + Manager → Team + participants | 全员共享消息上下文（历史上），新版分 Team 隔离 | selector/round-robin | 无原生画布 | 📘 [MS migration](https://learn.microsoft.com/he-il/agent-framework/migration-guide/from-autogen/) |
| **Dify** | 画布 DAG：LLM/工具/检索/条件/循环节点连线 | 各节点独立输入输出，变量沿边流转 | 条件分支 + 迭代/循环节点 | ✅ 成熟画布 | 📊 [Dify 技术骨架](https://cloud.tencent.cn/developer/article/2600306) |
| **Coze 扣子** | 工作流画布 + 多 Agent（主 agent + 子 agent） | 工作流变量 + 知识库 | 条件 + 循环 | ✅ 成熟画布 | 📊 [扣子 Coze](https://baike.baidu.com/item/%E6%89%A3%E5%AD%90Coze/68194952) |
| **n8n** | 通用工作流节点连线 + AI Agent 节点（manager + sub-agent tools） | 数据沿边流 | 条件 + 循环 | ✅ 画布 | 📘 [n8n sub-agent](https://n8n.io/workflows/7158-beginner-manager-agent-with-sub-agent-tools/) |
| **Claude Code subagents** | 主会话 spawn 独立 subagent，prompt 描述 + 任务投递 | 独立隔离 context window + 文件交接 | spawn 循环 | 无画布 | 📘 |
| **MetaGPT** | 固定 5 角色 SOP 流水线 | 共享文档存储（run 内），不跨 run | 有界重试（重跑失败单测 ≤3） | 无原生画布 | 📘 [arXiv](https://arxiv-org.ezproxy.obspm.fr/html/2607.22682v1) |
| **ChatDev** | ChatChain 双人对话链 + 阶段研讨会 | 结构化 JSON 顺序交换 | 阶段循环 | 无原生画布 | 📘 [GitHub](https://github.com/pirahansiah/ChatDev) |
| **AutoGen Studio** | Team Builder(JSON/拖拽) + Playground | 实时消息流 + 控制转换图可视化 | 终止条件可配置 | ✅ 拖拽式画布 | 📘 [MS Docs](https://microsoft.github.io/autogen/stable/user-guide/autogenstudio-user-guide/index.html) |

**关键补充**：
- **AutoGen Studio** = "构建时拖拽（Team Builder）+ 运行时观察（Playground：消息流可视化 + 暂停/停止）"双界面，是 **L4 直接产品参考**；但官方标注"**非生产就绪**"，需自建生产级。⚠️
- **MetaGPT 隐式边 vs 我们显式边**：MetaGPT 边由"读文档顺序"诱导（隐式，难可视化），我们 YAML `handoff.upstream/downstream` 生成**显式有向边**（画布可见可编辑）——选择正确。⚠️

---

## 四、对本项目的借鉴映射

| 借鉴点 | 来源 | 落到本项目设计 |
|---|---|---|
| 图 DSL（节点+边+条件/循环边） | LangGraph / Dify | 图 DSL + 画布编辑器 |
| State + reducer（收敛的共享状态） | LangGraph | 任务树 + 产出物 = 团队共享，与私有记忆隔离 |
| Handoff 定向交接（非广播） | OpenAI Agents | 交接协议：产出物=文件，协商=消息(定向) |
| 独立 context window = 记忆纯洁性 | Claude Code subagents | 每角色独立 subagent session，只经文件+消息交接 |
| Checkpoint 持久化 + human-in-the-loop | LangGraph | 重启恢复、卡顿登记、审批暂停 |
| Crew/Task 分离 | CrewAI | Agent(角色) 与 Task(实例) 两对象分离 |
| 画布"节点+连线"产品形态 | Dify/Coze/n8n | 先只读看板，后拖拽编辑器 |
| SOP 驱动的角色流水线 | MetaGPT/ChatDev | L0 角色 skill = SOP 片段；L2 节点顺序 = SOP 图化 |
| 结构化文档交接防失真 | MetaGPT | handoff：产出物=结构化文档落盘，协商=消息 |
| ChatChain 双人对话 | ChatDev | 循环中"开发↔测试"的 per-phase 双人对话 |
| Team Builder 拖拽建团队 | AutoGen Studio | 画布：角色拖入 + 连边 + 终止条件 |
| Playground 消息流可视化 | AutoGen Studio | 只读看板：实时消息流 + 节点状态染色 |
| Token 优化六模式 | Zenodo 实证 | 预算闸：上下文分层/fetch-once/schema-contracted/fallback/语义缓存/通信压缩 |

**Token 优化实证**（Zenodo）：六模式生产管道实测——冷加载延迟 **3.5-10.5min → 61-116 秒**，历史 token 估算**减少 60-70%**；其中 **inter-agent 通信压缩 + schema-contracted prompts** 与消息总线 + 角色 YAML 直接相关，建议 L2 设计阶段纳入。🧪

---

## 五、关键结论（供 PM 决策）

1. **范式已被验证，不需从零验证范式**：MetaGPT/ChatDev 证明"固定角色集合 + SOP 驱动 + 结构化文档交接"在软件工程可行；我们只需验证"**画布可编排**"这一差异化。📘
2. **记忆隔离的行业标准答案是"独立 context window + 文件交接"**，DSH 原生 subagent 天然具备，我们无需自建隔离机制（只需设计交接协议）。📘+⚠️
3. **结构化文档交接 > 自由对话（防信息失真）**，强化"handoff 产出物=文件、协商=消息"的设计决策。📘+⚠️
4. **核心差异化不是"多 Agent 团队"，而是"DSH 原生、角色技能驱动、画布可编排的 agent 团队"**——三者交集处无成熟产品；与 Dify/Coze（通用 LLM 节点）和 MetaGPT（硬编码 SOP）都不同。⚠️
5. **最难复刻的是画布编辑体验**（=P0-5 拖拽），建议独立里程碑；**AutoGen Studio 是 L4 最直接产品参考**（TeamBuilder + Playground 双界面）。📘+⚠️
6. **Token 优化六模式有实证**（-60~70%），inter-agent 通信压缩 + schema-contracted prompts 应在 L2 阶段纳入。🧪

---

## 六、来源索引

- 📘 [LangGraph — LangChain Docs](https://docs.langchain.com/oss/python/langgraph/checkpointers)
- 📘 [OpenAI Agents — Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration)
- 📘 [CrewAI — Crews concept](https://docs.crewai.com/v1.15.18/ko/concepts/crews)
- 📘 [Microsoft Agent Framework — AutoGen migration](https://learn.microsoft.com/he-il/agent-framework/migration-guide/from-autogen/)
- 📘 [Claude Code — Sub-agents](https://code.claude.com/docs/sub-agents)
- 📊 [Dify 技术骨架剖析（腾讯云）](https://cloud.tencent.cn/developer/article/2600306)
- 📊 [扣子 Coze（百科）](https://baike.baidu.com/item/%E6%89%A3%E5%AD%90Coze/68194952)
- 📘 [n8n — manager agent + sub-agent tools](https://n8n.io/workflows/7158-beginner-manager-agent-with-sub-agent-tools/)
- 📊 [Multi-Agent Orchestration: A Survey（MDPI）](https://www.mdpi.com/1999-5903/18/6/326/pdf)
- 📘 [MetaGPT — arXiv](https://arxiv-org.ezproxy.obspm.fr/html/2607.22682v1)
- 📘 [ChatDev — GitHub](https://github.com/pirahansiah/ChatDev)｜📘 [ChatDev — IBM tutorial](https://www.ibm.com/tutorials/chatdev-chatchain-agent-communication)
- 📘 [AutoGen Studio — Microsoft Docs](https://microsoft.github.io/autogen/stable/user-guide/autogenstudio-user-guide/index.html)
- 📘 [Token Optimization in Multi-Agent AI Workflows — Zenodo](https://zenodo.org/records/21924612)
- 📘 [agent-kernel — 死锁检测（npm）](https://socket.dev/npm/package/@cdzzy/agent-kernel)｜📘 [agent-watchdog — 运行时循环/死锁检测（npm）](https://www.npmjs.com/package/agent-watchdog)（佐证：消息总线防死锁是业界已识别问题）