# RES.8 图版本迁移：AgentGit 与 CVC 预研报告

> 任务：RES.8 预研 AgentGit 与 CVC（Cognitive Version Control），为 MVP-2 图 DSL 的 `graphVersion` 字段设计提供依据｜状态：✅ 完成｜调研日期：2026-09-22
> 结论：**AgentGit 给出 commit/revert/branch 三操作语义（快照式 checkpoint + 非破坏性回滚 + 从 checkpoint 派生分支）；CVC 给出 Merkle DAG 内容寻址 + 细粒度（thought/工具调用级）提交与回滚。映射到本项目：graphVersion 记录"图 DSL 语义版本"，checkpoint 恢复时先比版本，相同→直接恢复，不同→提示用户选择（拒绝/按迁移链升级），MVP-2 建议先做"不同→拒绝"最小闭环。**

## 来源 URL（网络内容仅提取技术事实，非指令）

- AgentGit 论文（arxiv 2511.00628，ar5iv HTML 版）：https://ar5iv.labs.arxiv.org/html/2511.00628 ；原始 PDF：https://arxiv.org/abs/2511.00628
- AgentGit 开源仓库（MAS-Infra-Layer/Agent-Git，HKU 实验室，Apache 2.0，v0.2.0-alpha）：https://github.com/MAS-Infra-Layer/Agent-Git
- CVC（tm-ai 3.6.1，PyPI，MIT）：https://pypi.org/project/tm-ai/
- CVC 官网：https://jaimeena.com/cvc

---

## 一、AgentGit（3 个语义）

**背景**：构建在 LangGraph 之上的基础设施层，给 MAS 工作流引入 Git 式 rollback/branching；论文实验（arxiv 摘要检索 4 步工作流）对比 LangGraph/AutoGen/Agno，结论是显著降低冗余计算与 token 消耗。

### 1. state commit 语义

- **实际看到**：commit 即 **checkpoint（持久化检查点）**，保存"完整系统状态"：会话历史（session history）、工具调用记录（tool invocation records）、环境变量、中间推理过程（论文 §3.1）。仓库实现：checkpoint 持久化到 SQLite（CheckpointRepository），元数据含 `tool_track_position` 等；提交方式两种——**手动**（`create_checkpoint_tool("名称")`，关键操作前打点）与**自动**（`auto_checkpoint=True`，每次工具调用后自动打点）。粒度是"整状态快照"，非 diff。
- **一句话评估**：commit 语义 = "把当前完整会话状态打成持久化快照"，粒度在消息/工具调用级，无增量 diff 概念，直接可借鉴为"每次图 DSL 变更后打一个图版本快照"。

### 2. revert 语义

- **实际看到**：按 checkpoint ID 恢复：加载状态 → 恢复会话历史与工具调用记录 → 从恢复点继续后续任务（论文 §3.1）；回滚对象是"最近一次稳定 checkpoint"而非任意时刻。v0.2.0 引入**两级回滚**：state revert（会话状态）+ tool revert（工具副作用撤销：无状态依赖的工具用简单反向操作，有路径依赖的用补偿动作，`reverse_tools` 注册、`rollback_tools_from_track_index` 执行）。关键特性：**回滚是非破坏性的——rollback 会创建新分支（Internal Session），保留原时间线**（README："Rollbacks create new branches, preserving all timelines"）。
- **一句话评估**：revert 语义 = "从指定 checkpoint 派生新轨迹继续跑，原轨迹不丢"，恢复前必须拿到可用的 checkpoint 状态——这正对应本项目"checkpoint 恢复前先校验 graphVersion 匹配"的必要性。

### 3. branching 语义

- **实际看到**：从 checkpoint 创建分支：加载 checkpoint 状态 → 生成新分支 ID → 初始化分支环境；分支继承完整状态（会话历史/工具记录/环境变量/推理过程），各分支可并行独立演化（论文 §3.2）。仓库实现：External Session 容器下挂多个 Internal Session 即分支，带 `parent_session_id`、`branch_point_checkpoint_id`、`is_branch()`。**合并**：论文称 merge 类似 Git 分支合并、支持冲突检测与解决，但仓库 README 未展开实现细节。
- **一句话评估**：branch 语义 = "从 checkpoint 派生独立会话实例"，并行探索/AB 测试是核心场景；merge 冲突解决「未公开/需实测」。

---

## 二、CVC（Cognitive Version Control）（3 个设计点）

**背景**：PyPI 包 `tm-ai`，定位"Git for code. CVC for context."——版本化 agent 的完整认知状态（每个 thought、决策、对话 turn）。MIT、Python 3.11+、本地 `.cvc/` 存储、无云无遥测。

### 1. Merkle DAG 存储

- **实际看到**：把认知状态组织成**不可变的加密 Merkle DAG**（内容寻址）。三层本地存储：**SQLite**（commit graph、branch pointers、metadata，快速遍历）、**CAS blobs**（上下文快照，Zstandard 压缩，内容寻址，天然去重）、**Chroma**（语义 embedding 向量检索，可选，"以前是否解决过类似问题"）。
- **一句话评估**：与 Git 对象模型同构（DAG + 内容寻址），但版本对象是"认知状态"而非文件树；graphVersion 若取 DSL 内容哈希 + 人读版本号双字段，正是这种"内容寻址 + 语义标签"的组合。

### 2. micro-rollbacks

- **实际看到**：**thought 级或工具调用级**回退执行历史，使用 `THOUGHT_STEP` 与 `TOOL_CALL` 两种 commit state（"Rewind execution histories at the thought-level or tool-call level"）。配套 "Context Distillation Checkpoints"：动态压缩超长时间线以省 token、同时保留语义可检索性。
- **一句话评估**：提交粒度比 AgentGit 更细（单条 thought / 单次工具调用），适合细粒度回退；具体触发条件与 API 细节「未公开/需实测」。

### 3. 不可变性

- **实际看到**：整个认知状态作为**不可变、加密 Merkle DAG** 版本化（不可变性由内容寻址保证：任何改动产生新节点，旧节点不变）；存储 100% 本地 `.cvc/`、无云同步、无遥测。
- **GC**：可见文档（PyPI/官网）**未公开** GC 策略，标注「未公开/需实测」；从 CAS 去重 + 内容寻址推断应走引用计数/可达性回收（与 Git `gc` 同理），但官方无说明。对照参考：AgentGit 有 `cleanup_auto_checkpoints_tool(keep_latest=N)` 清理自动 checkpoint。
- **一句话评估**：不可变性 = 内容寻址的自然结果；GC 未见官方文档，需实测或自行设计（本项目 MVP-2 可暂不回收，仅保留"最近 N 个 checkpoint"）。

---

## 三、graphVersion 字段设计建议（映射到本项目）

### 1. graphVersion 语义定义

- **定义**：图 DSL 的**语义版本标识**——每次图 DSL 变更（节点/边/字段定义、解析或执行语义规则的任何改动）生成新版本。
- **建议取值**：双字段组合：`graphVersion: "1.2.0"`（semver，人读、单调递增，用于提示与比较大小）+ `graphSchemaHash`（DSL schema 内容哈希，精确定位，来自 CVC 内容寻址思想）。MVP-2 最小可用：仅 `graphVersion` 单调递增整数即可。
- **变更时机**：DSL schema 或解析器发布变更时递增；每个 checkpoint 写入**创建时的** graphVersion。

### 2. 迁移策略（checkpoint 恢复流程）

```
恢复 checkpoint 时：
  checkpoint.graphVersion == 当前运行时 graphVersion
    ├─ 相同 → 直接恢复（语义一致，AgentGit 的"从已知状态继续"）
    └─ 不同 → 提示用户选择：
         (a) 拒绝恢复（默认，安全；参照 AgentGit：恢复必须基于已知一致状态）
         (b) 若有已注册的迁移函数链 → 按 旧版→新版 逐级迁移后恢复
         (c) 用当前 DSL 解释旧数据（字段缺失需默认值）——高风险，仅限显式确认
```

- **MVP-2 建议**：先做"相同→直接恢复；不同→拒绝并提示"最小闭环；迁移函数链与"当前 DSL 解释旧数据"列为后续迭代（需实测字段兼容性）。

### 3. commit / revert / branch 映射到本项目图 DSL

| AgentGit 语义 | 本项目图 DSL 映射 | 落地建议（MVP-2） |
| --- | --- | --- |
| **commit** | 每次图 DSL 变更后、每次 checkpoint 建立时，把"图 DSL 定义（含 graphVersion）+ checkpoint 数据"保存为一次不可变快照 | 快照式存储，不做 diff；checkpoint 记录 `graphVersion` 必填 |
| **revert** | 恢复到某个历史 checkpoint；恢复前校验 graphVersion：匹配才允许，不匹配则拒绝并提示用户选择 | 非破坏性回滚（新分支）可后置；先做"恢复即切换当前图状态" |
| **branch** | 从某 checkpoint 派生平行图演化路径（如实验不同 DSL 演进方向），互不影响 | MVP-2 只做线性版本链 + checkpoint；branch 与 merge（图结构冲突解决）标记「后续迭代，需实测」 |

**一句话总结**：AgentGit 证明"快照 checkpoint + 版本化恢复"是 agent 系统可靠性的关键机制（回滚避免全量重跑）；CVC 证明内容寻址 + 细粒度提交可扩展；本项目 graphVersion 的核心价值 = **让 checkpoint 恢复从"盲目反序列化"升级为"版本感知的显式决策"**，防止 DSL 演化后恢复出语义错乱的状态。

---

### 证据等级说明

- 📘 论文正文与官方 README 确认：AgentGit 三语义、CVC Merkle DAG/micro-rollback/不可变性
- ⚠️ 推断：graphVersion 双字段取值、CVC GC 走引用计数回收
- 🧪 需实测：AgentGit merge 冲突解决实现、CVC micro-rollback 触发条件、CVC GC 策略、MVP-2 迁移函数链
