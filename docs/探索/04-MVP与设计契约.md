# 可视化 Agent 任务编排工具 · MVP 与设计契约（整合版 · 最终修复版）

> 整合自：04-v2 + 04-v3 + 05 契约 + 运行时/资源边界/故障恢复/并发防护/缺陷规避/熔断复用/观察者机制/对外配置/多轮查漏（2026-09-22）
> 依据：`docs/03-能力探测与复用结论.md` + 多方评审 + 最新 Discussion 探测 + 依赖项事实核查
> 本文件是 MVP 与契约的**唯一权威版**。


## 一、方向定位

**最终目标**：可视化 agent 任务编排工具——一句话需求 → 拆成工作流任务图 → 多角色 subagent 按图自动协作（含循环）→ 激活状态可视化 → 每 agent 独立记忆防污染 + 互相对话 → 角色可导入文件创建、画图连线。

**三条方向修正**：

| | 早期方案 | 定稿 | 理由 |
|---|---|---|---|
| 编排引擎 | 图 DSL → workflowEngine script | **自研 StateGraph**（图 DSL 直驱 subagents） | workflowEngine 是脚本式，表达条件边/循环/精确节点状态别扭；StateGraph 才是图范式 |
| workflowEngine | 主引擎 | 降为 MVP-1 临时验证 | 复用现成脚本+chat 可视化，先验“角色协作”闭环 |
| 角色定义 | provider + persona string | **YAML 元数据 + `system_prompt_ref` 指向 skill** | traits 是元数据，Prompt 内容来自 skill 文件，R1-R10 直接复用 |
| Token 熔断 | 自研 RunLedger 回调 | **复用官方 `@deepseek-ai/dsh-agent-budget` + 社区 `dsh-discipline-guard` 兜底** | 官方 durable 预算 + harness 边界硬闸门，避免重复造轮子 |

**不要做（评审采信）**：①不依赖 experimental agent-team（不支持循环+实测不兼容）②不用社区团队插件（版本不匹配）③不自研记忆隔离（subagent 已提供）④不自研 Prompt（skill 已有）⑤不自研 Token 熔断（官方+社区闸门已足够）。


## 二、分层架构（L0-L5）

```
L0 角色资产      R1-R10 skill + 3 横切纪律（已完成，system_prompt_ref 直接指向）
L1 执行与记忆    官方 @deepseek-ai/dsh-subagent（Continuable child + 独立 Session + 记忆隔离）
L2 编排引擎      自研 StateGraph（图 DSL + 条件边 + 循环回退 + 迭代熔断 + checkpoint + 全局并发计数）
L3 角色管理      自研 YAML 配置（特质/工具/模型/质量门/预算/handoff 依赖/生命周期/并发上限/观察者）
L4 可视化        自研画布 + 实时激活状态 + Token 监控 + 观察者信号
L5 可观测与治理  轨迹追踪 · RunLedger 审计账本 · 策略合规 · 成本熔断 · 行为漂移检测（见 docs/02）
```

复用层仅 L1；自建 L2/L3/L4；L5 的成本熔断**复用官方 `@deepseek-ai/dsh-agent-budget` + 社区 `dsh-discipline-guard`**（不自研）。**图 DSL = L2 输入；L4 画布 = DSL 编辑器；L3 YAML = 每个节点的角色元数据。**

> 全栈以 **Cordis 插件形态**存在：所有非 Cordis 管理的资源必须遵守生命周期契约（见 §4.2），否则热重载泄漏。


## 三、核心设计

### 3.1 循环工作流状态机（L2）

```
DevTeamState {
  messages[], current_phase, active_agent, task_queue[],
  artifacts{}, quality_gate_status: 'passed'|'failed'|'pending',
  retry_count, max_iterations   // 默认 25 熔断
}
```
节点只返回 `Partial<State>`，引擎**原子合并**。条件边：质量审核输出 `retry` → 回开发节点 `retry_count++`；`retry_count >= max_iterations` → 强制人工审批。

### 3.2 消息总线（父代理中转 + 防死锁）

A→B 对话 = A `sendMessage` 给编排器（父）→ 父解析目标 → 转投 B。防死锁：`correlation_id` + `deadline` + **分级恢复**（见 §4.3）。

### 3.3 观察者机制（正交增强层）

观察者作为**正交增强层**，不改变图拓扑，与质量审核节点互补。核心原则：**只读、非阻塞、文件观察优先、记忆隔离、分级介入、fail-open**。

| 层级 | 模式 | 触发时机 | 介入方式 | Token 开销 |
|---|---|---|---|---|
| **L1 轻量检查** | 中间件拦截 | 每个节点执行前后 | 纯函数检查（格式、权限、命名规范），不调用 LLM | 零 |
| **L2 静默观察** | 并发审计者 | 每个角色节点完成后 | 文件观察（`git diff`、读取产出），按关注级别发信号 | 低（仅在发现关注时调用 LLM） |
| **L3 深度审查** | 流式观察者 | 质量门节点、循环回退前 | 完整 LLM 审查，返回 BLOCK/SANITIZE/FLAG | 高（按需启用） |

**信号分级**：GREEN（继续） / YELLOW（记录并标记） / RED（触发早期回退）。

**DSH 生态参考**：`dsh-auto-review`（第二模型只读审批子代理，fail-closed 默认）、`dsh-danus`（cold-start 验证者为正确性唯一权威，只读可观测看板）、`dsh-cortex`（低成本多模型编排与质量门控）、`decision-gates`（五道防偏闸门：原始证据锚、对抗式对齐审计、跨包一致性校验、成本比对、防御自检）、`dsh-ai-team`（插件驱动的 AI 团队，客观质量门，`gates_run` 全绿才 approve）。

**MVP 集成时间线**：MVP-2 实现 L1 轻量检查（零 Token）；MVP-3 实现 L2 静默观察（低 Token）；MVP-4 展示观察者信号；MVP-6 按需实现 L3 深度审查。

### 3.4 人工审批分级

| 等级 | 触发条件 | 审批方式 | 超时策略 |
|---|---|---|---|
| **L1 轻量** | 质量审核连续 2 次不通过 | 异步通知，不阻塞 | 超时自动继续 |
| **L2 标准** | `retry_count` 达上限、Token 超硬阈值 | 同步阻塞，等待人工 | 超时降级到 L3 |
| **L3 紧急** | 安全策略违规、跨角色死锁 | 同步阻塞 + 告警 | 超时强制终止 |


## 四、设计契约（MVP 动工前敲定）

### 4.1 图 DSL schema（MVP-2 前敲定，全系统“宪法”）

```
GraphDefinitionSpec {
  version, entryPoint
  nodes: [{ id, roleRef?, promptTemplate?, nodeType: "role"|"code"|"condition"|"approval" }]
  edges: [{ from, to, type: "seq"|"cond"|"loop"|"parallel", when?, maxIter? }]
  checkpoint: { strategy: "node-level", storage: "session-log"|"sqlite"|"fs" }
  metadata: { source: "canvas"|"yaml"|"hybrid", createdAt, updatedAt, graphVersion }
  observers: [{ id, roleRef, observeNodes[], observationMode, interventionMode, criteria[], tokenBudget }]
}
```
- parallel 边语法**现在预留**（MVP-2 只实现 seq+cond+loop）。`metadata.source` 承载画布/YAML 冲突解决。
- **`graphVersion` 字段（新增）** ：图 DSL 本身需版本化。当图 DSL 变更时，已有工作流要么继续使用旧版本执行（通过 checkpoint 中记录的 `graphVersion`），要么提示用户“图已变更，是否从当前状态迁移到新版本”。参考 AgentGit 的 state commit/revert/branching 语义、CVC 的认知版本控制。
- **静态验证器（MVP-2 纳入）** ：加载图 DSL 时检查所有边的 `from`/`to` 节点存在、`condition` 边的 `when` 表达式引用的字段在 State 中存在、循环边的 `maxIter` 已设置、`roleRef` 指向已注册的角色。毫秒级捕获集成错误，零 Token 消耗。

### 4.2 checkpoint 契约（MVP-2 就定义，非 MVP-3）

- 粒度 = **节点级**，时机 = 每次节点补丁合并后；`run(initialState, { checkpoint })` 里 checkpoint 是**必需参数**。
- 落盘 `{ graphId, graphVersion, node, state, iteration }` → session-log/SQLite/fs（复用 storageDomain）；**同一回调同时追加 RunLedger 事件**（State 快照 + 历史轨迹双写）。
- 恢复 = 从**最近 checkpoint（RunLedger）重建**；**不依赖 subagent 的 settlement notice 持久化恢复**（见 §4.6 缺陷 3）——Subagent Session 只作执行上下文，不作恢复依据；引擎/节点状态重建走自己的 RunLedger。
- **并行分支合并**：汇聚后一次 checkpoint；字段冲突**默认 `reject-on-conflict`**（两分支写同一字段 → 抛错 + RunLedger 记冲突，不静默覆盖）；`merge` 仅对声明 `@mergeable` 的字段启用。冲突检测在**引擎合并阶段**执行，参考 agent-coherence 的 MESI + 乐观并发协议。
- **资源生命周期约束（Cordis，精确约束）** ：引擎/总线/RunLedger 内**不得使用裸 `setTimeout`/`setInterval`/`fs.open`/`new Database()`**；所有非 Cordis 一等服务的资源必须 `ctx.effect(() => {...; return disposer})` 注册，disposer 完整释放。⚠️ Discussion #2854：HMR recompose 在 fiber disposal 与 recompose 间有竞态，非 effect 资源可能泄漏或过早清理（案例：第三方 bundle 插件 boot 后 ~3s 被静默禁用）。**热重载测试作为 MVP-2 门禁一部分**——插件热重载后验证无资源泄漏。RunLedger 建议直接用 `ctx.storageDomain`（一等服务，框架管生命周期）。

**产物路径约束（FIX.6，MVP-2 强制）** ：

- `graphId` 和产物根路径**必须**从 `ctx`（会话工作区）获取，**禁止**使用 `process.cwd()`
- `graphId` 由引擎生成（格式：`graph-{timestamp}-{random}`）
- 产物根路径从 `ctx.workspace` 或 `ctx.session.workspace` 获取（具体 API 待 RES.3 确认）
- 所有 `art://` 引用基于产物根路径解析
- 单元测试必须覆盖：不同会话工作区下，产物落盘到正确路径

**为什么是契约级约束**：
- `process.cwd()` 返回 DSH 进程启动目录，与用户会话工作区无关
- checkpoint 恢复时若路径错误，会读不到产物
- MVP-3 的 `art://` 引用依赖此约束

### 4.3 消息总线契约（MVP-3 前）

```
Message { id, correlation_id, from, to,
  type: "handoff"|"query"|"feedback"|"escalation",
  payload: { artifact_ref?, summary, full_content? },
  deadline, priority: "high"|"normal"|"low" }
```
- **防死锁分级恢复**：

| 超时类型 | 恢复动作 |
|---|---|
| 单条消息超时 | 重试（最多 2 次） |
| correlation_id 的 Agent 访问计数超阈值（同 Agent 同链路 ≥3 次） | 强制终止链路 + 诊断写入 RunLedger |
| 整个工作流超时 | 降级到人工审批节点 |

### 4.4 角色 YAML schema + 生命周期 + 并发多层防护（MVP-3 前）

```yaml
role:
  schema_version: "1.0"
  id: R3
  system_prompt_ref: "skills/R3-developer.md"
  traits: [...]
  capabilities: [...]
  tools: [...]           # → toolFilter（最小权限声明）
  memory_scope: private  # → inheritsParentContext=false
  lifecycle: resident | on-demand | hybrid
  model: <模型路由>      # ⚠️ 必须显式传 { provider, model } 完整对象，不能只传 model 名
  max_concurrent_children: 8   # provider 层单点 cap（见下方多层防护）
  quality_gate: [...]
  token_budget: 50000
  handoff: { upstream: [R2], downstream: [R4,R5], edge_type: seq|cond }
  observers: [...]       # 观察者配置（见 §4.1 GraphDefinitionSpec）
```
- `handoff.upstream/downstream` 直接生成图**有向边**（“画图连线”的语义来源）。
- **生命周期**：核心角色 resident、边缘 on-demand、hybrid 活跃窗口降冷恢复；冷恢复 SLA >10s 降级人工。**安装 `dsh-session-pruner`** 作为长期生命周期管理基础设施（one-shot 子代理完成后自动归档，continuable/main 空闲超 N 天归档，总容量超上限按优先级回收，避免 `session_projcache.json` 膨胀导致主进程 CPU 饱和）。
- **模型显式指定（🐛 继承缺陷）** ：`{ provider, model }` **完整对象**在 `startContinuable` 时经 `agentRouteDefaults` 显式传入，不依赖继承（继承的是冻结时的默认路由）+ 不依赖默认 provider（spawn 可能路由到 deepseek-official 错账户）。
- **权限在 provider 层**：官方 dispatch 结构性无法携带 settings，`tools`→toolFilter 即最小权限声明。
- **YAML→Provider 映射的类型收窄**：`prepareContinuable` 是 `SubagentProvider` 的唯一把关方法，方法存在即为能力。
- **并发多层防护（`max_concurrent_children` 只是单点 cap，无法阻止跨 provider/跨 run 累积并发）** ：

| 层级 | 机制 | 来源 | 本项目 |
|---|---|---|---|
| Provider 层 | `maxConcurrentChildren` / `idleTimeoutMs` | `dsh-plugin-product-subagents` | L3 YAML `max_concurrent_children` |
| Agent Loop 层 | `maxToolCallsPerTurn` / `maxStepsPerTurn`，spawn/fork 作为工具调用在执行体前被拒 | `dsh-turn-budget` | 引擎初始化时挂载 |
| 引擎层 | 节点激活前检查**全局活跃 child 计数** | 自建（StateGraph） | MVP-2 定义 |
| 进程/事件循环层 | **无官方方案** | —— | 结构性限制，接受或自建 |

> ⚠️ 广度爆炸真实案例（Discussion #131）：~56 子代理 → 2.2GB 内存、单核满载 20min、UI 无响应；根因是 dsh-subagent 无任何数量/并发上限，`maxDepth` 只限深度挡不住广度（1→N→N²）。多层叠加可覆盖“单 provider 广度爆炸”+“单 turn 迭代失控”，但**无法完全阻止跨 provider 累积并发**——DSH 结构性限制，设计时明示。

### 4.5 Token 熔断（复用官方 + 社区，不自研）

- **首选：复用 `@deepseek-ai/dsh-agent-budget`（官方 npm 包，社区维护仓库）** ——durable session + descendant-tree scopes；soft accounting / hard admission；绝对 deadline 跨 restart 存活；每次 LLM 调用前预留 capacity，stream settle 后用 provider-reported usage 替换估算，**并发子代理不花同一份剩余余额**。→ 替代自研“角色级+图级预算”，**采集点 = provider 层（官方 Token Meter 提供），解决“采集点不明确”** 。
- **兜底：挂载 `dsh-discipline-guard`（社区四道硬闸门，MIT 许可）** ——loop circuit-breaker（第 4 次重复 denied before dispatch）、cost fuse（从 real usage data 计量）、route watcher、plan gate；挂在 harness waterfall（tools/pre-execute、agent/pre-step、session/event），**模型无法绕过**。
- **软/硬阈值语义**：软 80% → 上下文压缩/滑动窗口摘要；硬 100% → 人工审批/降级；图级预算 = Σ角色 + 引擎开销余量。
- **自研 RunLedger 回调降级为“记账/可观测”** （非强制闸门），强制熔断交给官方/社区闸门；参考 `dsh-fuse`（per-call metering + offline fuse, fail-closed + unpricedFallback）。

### 4.6 subagent 已知缺陷规避（契约级，🐛 已确认）

| 缺陷 | 影响 | 契约规避 |
|---|---|---|
| 1. 继承过期 base 默认模型 | 运行中切模型不传播到子代理，错误被吞 | `{ provider, model }` 完整对象经 `agentRouteDefaults` 显式传入 |
| 2. spawn 路由到 deepseek-official | 计费记错账户 | 显式指定 `agentRouteDefaults.provider`，不依赖默认路由 |
| 3. Messages 协议历史 notice 毒化 | 跨 0.1.6-alpha.1 升级后旧会话永久不可用（0.1.6-alpha.1 前 settlement notice 含 reasoning/tool-call blocks，Messages 协议无法表示，1 个旧 notice 毒化整个 history，实测 15 session 全失败） | **不依赖 subagent settlement notice 恢复**（§4.2）；用 RunLedger 重建状态；升级前归档/迁移（清理 reasoning blocks） |


## 五、Token 四大优化

1. **System Prompt 重复注入**：Prompt Caching + 分离不变/可变部分，只对可变每轮注入 + 滑动窗口摘要。
2. **交付物传递**：`art://` 工件引用——长产出落盘，消息只传引用+200 字摘要，全文按需展开。
3. **循环回退**：只传结构化 diff + 分层审核（轻量先、完整后）+ max_iterations 强制审批。
4. **看板推送**：事件 payload 只含增量（nodeId+status），完整 State 按 checkpoint 拉取。


## 六、MVP 全景与关键环节

| MVP | 名称 | 关键环节 | 门禁 |
|---|---|---|---|
| 0 | 角色资产 | R1-R10 skill ✅ | 已过 |
| 1 | 单链脚本验证 | 封装 R6 角色 provider（model 传完整对象）；workflowEngine 脚本串行 R1→R8 | 多角色顺序跑通真实小任务 |
| 2 | **自研 StateGraph 引擎** | 图 DSL schema + checkpoint 契约(+Cordis 精确约束+并行默认+RunLedger 恢复+**graphVersion**)；addNode/addEdge/addConditionalEdge；循环回退+熔断；**全局并发计数**；**观察者 L1 轻量检查**；BDD/mock 结构覆盖测试；挂载 `dsh-turn-budget` 兜底 | 含循环 DSL 跑通 + 循环退出/熔断双生效 + checkpoint 契约随 DSL 敲定 + 路由/条件边确定性测试(零 LLM) + **热重载后无资源泄漏** |
| 3 | 状态+交接+消息+恢复 | 任务树持久化(storageDomain)；handoff 四字段；父代理中转+分级死锁恢复；RunLedger 重建恢复(不依赖 settlement notice)；分账；**生命周期(`dsh-session-pruner`)+多层并发+复用 `@deepseek-ai/dsh-agent-budget` / `dsh-discipline-guard`** ；重启(复用 ctx.jobs)+目标(复用 ctx.goals)；**观察者 L2 静默观察**；**人工审批分级** | 中断可恢复、交接可追溯、按角色分账、跨角色对话可达、session 不膨胀 |
| 4 | 只读激活看板 | 节点状态事件流(node-start/end/error/loop-iteration/edge-traversed/checkpoint-written) + 图渲染 + 审批面板 + **观察者信号可视化** | 全程图节点实时染色 |
| 5 | 角色导入+画布连边 | YAML 导入解析器 + 拖拽连边→DSL + 端口规则 + source 冲突解决 | 零代码搭自定义团队跑通 |
| 6 | 打磨 | 恢复加固/超时降级/记忆压缩/对抗评审/卫生 + **观察者 L3 深度审查** | 全套门禁 |

**契约敲定时机**：图 DSL+checkpoint（MVP-2 前）｜消息分级恢复+YAML+生命周期+并发多层防护+观察者 Schema（MVP-3 前）｜Token 熔断复用方案（MVP-3 中，MVP-2 前确认 `ctx.llm` usage 与 `dsh-agent-budget` 可用性）｜事件流契约（MVP-4 前）｜画布端口（MVP-5 前）。

**质量验证双层模型**：
- **结构覆盖**（验证工作流被完整执行）——StateGraph 的路由/条件边/熔断都是**纯函数**，用 **BDD + mock 隔离 LLM 做确定性测试（零 Token、毫秒级）** ，**提前到 MVP-2**。
- **语义评估**（判断输出质量）——LLM-judge，落到 MVP-6 对抗评审。


## 七、难点、风险、待决策

**难点（按难度）** ：①StateGraph 原子合并+并发安全（MVP-2 只做串行，并行后推）②冷恢复延迟（活跃窗口+10s SLA）③死锁检测（correlation_id+deadline+分级恢复）④YAML→Provider 映射（system_prompt_ref 分离）⑤画布/YAML DSL 双向同步 ⑥**图版本迁移（AgentGit/CVC 参考）** 。

**风险**：
- StateGraph 自研复杂度（参考 `dsh-state-graph` / `dsh-agent-graph` 逻辑不抄码）
- 跨版本 API（采信 `sendMessage`，上线前 `dsh --version` 复测）
- 循环失控 / 成本爆炸（熔断+预算闸+`dsh-discipline-guard` loop circuit-breaker）
- Cordis 热重载资源泄漏（非 Cordis 资源一律 `ctx.effect()` 包装 + 热重载测试入门禁）
- **并发失控多层防护缺失**（provider 单点 cap 无法阻止跨 provider/跨 run 累积并发 → 引擎级全局计数 + `dsh-turn-budget` 兜底；进程层无官方方案=结构性限制）
- **Messages 协议 notice 毒化**（跨 0.1.6-alpha.1 升级旧会话不可用 → 不依赖 settlement notice 恢复 + 升级前归档）
- **Token 熔断重复造轮子**（自研回调不如官方 `dsh-agent-budget` → 直接复用 + `dsh-discipline-guard` 兜底）
- 并行字段冲突静默覆盖（`reject-on-conflict` 默认）
- 画布复杂度（独立验收+只读看板先行）
- **Agent 治理缺失**（Agent 视为“特权内部人员”：短期凭证 + 记忆防投毒 + 执行前验证；L3 `tools`=最小权限声明，L5 引擎侧只允许调用角色声明工具）
- **安全沙箱缺失**（MVP-5 后引入容器级隔离）

**待 PM 裁决**：①自研 StateGraph 主方向 ②角色主格式 YAML ③四契约按本文敲定、时机作门禁锚点（experimental agentTeams 已确认不依赖——实测不兼容 PR #257，task DAG/mailbox 自建）④**并发全局上限是否接受当前 DSH 结构性限制（自建引擎层计数）** 。


## 八、社区/开源参考（学逻辑不抄码）

### L2 引擎
- `dsh-state-graph`（checkpoint 回调/熔断/审批门/条件边，npm 当前 `0.2.0`，`0.3.0` 待发布）
- `dsh-agent-graph`（scoped agent nodes + structured handoffs + **bounded rework** + layered global ledger——每个 node 是 fresh subagent，upstream delivery 作 structured contract 交给 downstream，node 发现 upstream 不足时**返回直接上游**，与“质量审核→开发”回退逻辑高度吻合）
- `miuzel/dsh-graph`（单包 host+client，浏览器二维泳道看板 + REST 端点 + graph_* 目标生命周期工具）
- Tangle（死锁/活锁检测）

### L3 角色/资源边界
- `dsh-plugin-product-subagents`（`maxConcurrentChildren` / `idleTimeoutMs`，npm 当前版本 0.3.1，MIT）
- `pi2dsh`（Pi 生态插件兼容层，`maxConcurrent=4` / `maxSubagentDepth=2`，MIT）
- `dsh-turn-budget`（per-turn 工具/步数闸，MIT，由 Nunchakus888 维护）
- `dsh-plugin-subagent-director`（模型路由+角色模板，npm 已发布，MIT）
- Orchid（YAML 定义+滑动窗口摘要）
- **角色导入生态参考**：`thissensen/dsh-agent-studio`（可视化配置 Agent 的 prompt/tools/skills/子代理/备用模型，npm 2026-09-22 发布）；`yangdcm/dsh-expert-team`（三步搞定专家团队）；`weibaohui/experts-management`（专家市场，50+内置专家，`/expert-名称` 手势）

### Token / circuit breaker
- `@deepseek-ai/dsh-agent-budget`（官方 npm 包，durable 树级预算）
- `dsh-discipline-guard`（四道硬闸门，MIT，由 haozheou 维护）
- `dsh-fuse`（fail-closed metering + unpricedFallback，npm 包名 `@openplan/dsh-fuse`）
- `dsh-token-stats`（Token 消耗统计面板，H1a3x 维护）
- `token-limiter`、`backstop-ai`

### L4 画布
- `dsh-node-flow`（节点/端口/If/Switch/Loop/While，**项目尚未发布到 npm，从 GitHub 安装**）
- `dsh-agent-team-gui`（Run Center，需 DSH Web profile + Node.js ≥22.19）

### 调度/生命周期
- `dsh-swarm`（常驻生命周期/`art://` 工件/看门狗，captain 拆任务 + 独立 API/插件成员跑在隔离 DSH 子进程 + JSONL mailbox IPC，wanghj040530 维护）
- `dsh-expert-orchestrator`（Taskboard+消息总线+PM-first 规划+gated delivery+experience pooling，mario841859784 维护）
- `dsh-session-pruner`（session 生命周期管理，Apache-2.0，npm 已发布，mrzhangkris 维护）

### 观察者/质量门生态参考
- `dsh-auto-review`（第二模型只读审批子代理，fail-closed 默认）
- `dsh-danus`（cold-start 验证者为正确性唯一权威，只读可观测看板 `/danus`）
- `dsh-cortex`（低成本多模型编排与质量门控）
- `decision-gates`（五道防偏闸门：原始证据锚、对抗式对齐审计、跨包一致性校验、成本比对、防御自检）
- `dsh-ai-team`（插件驱动的 AI 团队，客观质量门，`gates_run` 全绿才 approve）

### 记忆分层参考
- `dsh-layered-memory`（L0捕获→L1原子记忆→L2场景整合→L3画像蒸馏）
- `dsh-memento`（`ctx.memory` 服务 + SQLite provider + 审批门 + 冻结快照注入，Apache-2.0）
- `dsh-memory-db`（项目级问答记忆，三态分类智能注入）
- `evo-subagent`（角色路由 + 每 Agent 独立 `prefercmd.md`/`memory.md`，要求 DSH ≥0.1.5-rc.1 / Node ≥24.2.0）

### 开源范式
- DeerFlow（子代理独立 checkpointer）
- LangGraph（StateGraph/checkpoint/conditional edges）
- MetaGPT（结构化文档交接）
- ChatDev（ChatChain）
- AutoGen Studio（Team Builder + Playground）
- AgentGit / CVC（版本控制与回滚）
- Cordis 生命周期文档（`ctx.effect` / LIFO 释放）


## 九、依赖项事实核查表

| 依赖项 | 文档原标注 | 核查结果 | 修正建议 |
|---|---|---|---|
| `@deepseek-ai/dsh-agent-budget` | 官方 bundle | ✅ 官方 npm 包，仓库由 `vibeinging` 维护 | 标注为“官方 npm 包（社区维护仓库）” |
| `dsh-discipline-guard` | 社区 | ✅ 社区（`haozheou` 维护，MIT） | 保持，补充维护者与许可 |
| `dsh-turn-budget` | 社区 | ✅ 社区（`Nunchakus888` 维护，MIT） | 补充维护者与许可 |
| `dsh-state-graph` | 社区 | ✅ 社区（`zerosloney` 维护），npm 当前 `0.2.0`，`0.3.0` 待发布 | 补充版本信息 |
| `dsh-agent-graph` | 社区 | ✅ 社区（`wrc093` 维护），从 GitHub 安装 | 保持 |
| `dsh-node-flow` | 社区 | ✅ 社区（`CodermanYHZ` 维护），**尚未发布到 npm** | 补充“从 GitHub 安装” |
| `dsh-session-pruner` | 未显式列出 | ✅ 社区（`mrzhangkris` 维护，Apache-2.0，npm 已发布） | **新增到 §4.4 生命周期管理** |
| `dsh-swarm` | 社区 | ✅ 社区（`wanghj040530` 维护），另有 `joekytc/dsh-swarm` 版本 | 补充版本区分 |
| `dsh-expert-orchestrator` | 社区 | ✅ 社区（`mario841859784` 维护，agent preset 插件） | 保持 |
| `dsh-agent-team-gui` | 社区 | ✅ 社区（`toolclub` 维护），需 DSH Web profile + Node.js ≥22.19 | 补充依赖要求 |
| `dsh-token-stats` | 社区 | ✅ 社区（`H1a3x` 维护），另有 `@duke-dsh-plugins/dsh-token-stats` 版本 | 补充版本区分 |
| `dsh-fuse` | 社区 | ✅ 社区（`openplancc` 维护），npm 包名 `@openplan/dsh-fuse` | 补充 npm 包名 |
| `dsh-plugin-product-subagents` | 社区 | ✅ 社区（`shaokeyibb` 维护，MIT），npm 当前版本 0.3.1 | 补充版本与许可 |
| `dsh-plugin-subagent-director` | 社区 | ✅ 社区（`SeverusZh` 维护，MIT） | 补充维护者与许可 |
| `pi2dsh` | 社区 | ✅ 社区（`weijiafu14` 维护，MIT） | 补充维护者与许可 |
| `dsh-agent-teams`（`NanmiCoder`） | 不依赖 | ✅ 支持矩阵：推荐 `0.1.5-rc.1`，**不包含 0.1.5-rc2** | 确认不依赖的正确性 |


## 十、遗漏项补全清单

| # | 遗漏项 | 补全位置 |
|---|---|---|
| 1 | `dsh-session-pruner` 作为生命周期管理基础设施 | §4.4 生命周期 |
| 2 | `graphVersion` 字段与图版本化契约 | §4.1 图 DSL schema |
| 3 | 观察者机制的完整 Schema 与信号契约 | §4.1 GraphDefinitionSpec 的 `observers` 字段 |
| 4 | 人工审批分级的契约定义 | §3.4 人工审批分级 |
| 5 | 角色导入的生态参考（`dsh-agent-studio`、`dsh-expert-team`、`experts-management`） | §8 L3 角色/资源边界 |
| 6 | 画布生态参考 `miuzel/dsh-graph` | §8 L2 引擎 |
| 7 | 观察者/质量门生态参考（`dsh-auto-review`、`dsh-danus`、`dsh-cortex`、`decision-gates`、`dsh-ai-team`） | §8 观察者/质量门生态参考 |
| 8 | 记忆分层参考（`dsh-layered-memory`、`dsh-memento`、`dsh-memory-db`、`evo-subagent`） | §8 记忆分层参考 |
| 9 | `prepareContinuable` 类型收窄说明 | §4.4 YAML→Provider 映射 |
| 10 | 依赖项事实核查表 | §9 依赖项事实核查表 |
| 11 | 观察者 L1/L2/L3 与 MVP 的集成时间线 | §6 MVP 全景（MVP-2 L1、MVP-3 L2、MVP-4 信号可视化、MVP-6 L3） |
| 12 | Agent 治理与安全沙箱风险 | §7 风险 |
| 13 | `dsh-agent-teams` 兼容性矩阵确认 | §9 依赖项事实核查表 |


## 十一、总结

本文档是“可视化 Agent 任务编排工具”的 MVP 与设计契约的**唯一权威版**，整合了：

- **方向定位**：自研 StateGraph 编排引擎、YAML 角色定义、复用官方 Token 熔断。
- **分层架构**：L0-L5，复用 L1（官方 subagent），自建 L2-L4，L5 复用官方+社区熔断。
- **核心设计**：循环工作流状态机、消息总线防死锁、观察者机制、人工审批分级。
- **设计契约**：图 DSL schema（含 `graphVersion`）、checkpoint 契约、消息总线契约、角色 YAML schema、Token 熔断复用方案、subagent 缺陷规避。
- **Token 优化**：System Prompt 分离、`art://` 工件引用、循环回退 diff、看板增量推送。
- **MVP 全景**：6 个阶段，契约敲定时机明确，观察者 L1/L2/L3 集成时间线。
- **难点与风险**：StateGraph 原子合并、冷恢复延迟、死锁检测、并发失控、Messages 协议毒化、Token 熔断复用等，均已给出缓解措施。
- **社区参考**：L2 引擎、L3 角色、Token 熔断、L4 画布、调度/生命周期、观察者/质量门、记忆分层、开源范式，均标注来源与维护者。
- **依赖项事实核查**：对每个依赖项的名称、维护者、许可、版本、安装方式做了核实与修正。
- **遗漏项补全**：13 项遗漏内容已全部补全到对应章节。

**下一步**：按待 PM 裁决的四项决策确认后，即可启动 MVP-1 单链脚本验证。