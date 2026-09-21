# 可视化 Agent 任务编排工具 · MVP 与设计契约（整合版）

> 整合自：04-v2 + 04-v3 + 05 契约 + 运行时/资源边界/故障恢复/并发防护/缺陷规避/熔断复用多轮查漏（2026-09-22）
> 依据：`docs/03-能力探测与复用结论.md` + 多方评审 + 最新 Discussion 探测
> 本文件是 MVP 与契约的**唯一权威版**。

---

## 一、方向定位

**最终目标**：可视化 agent 任务编排工具——一句话需求 → 拆成工作流任务图 → 多角色 subagent 按图自动协作（含循环）→ 激活状态可视化 → 每 agent 独立记忆防污染 + 互相对话 → 角色可导入文件创建、画图连线。

**三条方向修正**：

| | 早期方案 | 定稿 | 理由 |
|---|---|---|---|
| 编排引擎 | 图 DSL → workflowEngine script | **自研 StateGraph**（图 DSL 直驱 subagents） | workflowEngine 是脚本式，表达条件边/循环/精确节点状态别扭；StateGraph 才是图范式 |
| workflowEngine | 主引擎 | 降为 MVP-1 临时验证 | 复用现成脚本+chat 可视化，先验"角色协作"闭环 |
| 角色定义 | provider + persona string | **YAML 元数据 + `system_prompt_ref` 指向 skill** | traits 是元数据，Prompt 内容来自 skill 文件，R1-R10 直接复用 |
| Token 熔断 | 自研 RunLedger 回调 | **复用官方 dsh-agent-budget + discipline-guard 兜底** | 官方 durable 预算 + harness 边界硬闸门，避免重复造轮子 |

**不要做（评审采信）**：①不依赖 experimental agent-team（不支持循环+实测不兼容）②不用社区团队插件（版本不匹配）③不自研记忆隔离（subagent 已提供）④不自研 Prompt（skill 已有）⑤不自研 Token 熔断（官方+社区闸门已足够）。

---

## 二、分层架构（L0-L5）

```
L0 角色资产      R1-R10 skill + 3 横切纪律（已完成，system_prompt_ref 直接指向）
L1 执行与记忆    官方 @deepseek-ai/dsh-subagent（Continuable child + 独立 Session + 记忆隔离）
L2 编排引擎      自研 StateGraph（图 DSL + 条件边 + 循环回退 + 迭代熔断 + checkpoint + 全局并发计数）
L3 角色管理      自研 YAML 配置（特质/工具/模型/质量门/预算/handoff 依赖/生命周期/并发上限）
L4 可视化        自研画布 + 实时激活状态 + Token 监控
L5 可观测与治理  轨迹追踪 · RunLedger 审计账本 · 策略合规 · 成本熔断 · 行为漂移检测（见 docs/02）
```

复用层仅 L1；自建 L2/L3/L4；L5 的成本熔断**复用官方 dsh-agent-budget + 社区 dsh-discipline-guard**（不自研）。**图 DSL = L2 输入；L4 画布 = DSL 编辑器；L3 YAML = 每个节点的角色元数据。**

> 全栈以 **Cordis 插件形态**存在：所有非 Cordis 管理的资源必须遵守生命周期契约（见 §4.2），否则热重载泄漏。

---

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

---

## 四、设计契约（MVP 动工前敲定）

### 4.1 图 DSL schema（MVP-2 前敲定，全系统"宪法"）

```
GraphDefinitionSpec {
  version, entryPoint
  nodes: [{ id, roleRef?, promptTemplate?, nodeType: "role"|"code"|"condition"|"approval" }]
  edges: [{ from, to, type: "seq"|"cond"|"loop"|"parallel", when?, maxIter? }]
  checkpoint: { strategy: "node-level", storage: "session-log"|"sqlite"|"fs" }
  metadata: { source: "canvas"|"yaml"|"hybrid", createdAt, updatedAt }
}
```
parallel 边语法**现在预留**（MVP-2 只实现 seq+cond+loop）。`metadata.source` 承载画布/YAML 冲突解决。

### 4.2 checkpoint 契约（MVP-2 就定义，非 MVP-3）

- 粒度 = **节点级**，时机 = 每次节点补丁合并后；`run(initialState, { checkpoint })` 里 checkpoint 是**必需参数**。
- 落盘 `{ graphId, node, state, iteration }` → session-log/SQLite/fs（复用 storageDomain）；**同一回调同时追加 RunLedger 事件**（State 快照 + 历史轨迹双写）。
- 恢复 = 从**最近 checkpoint（RunLedger）重建**；**不依赖 subagent 的 settlement notice 持久化恢复**（见 §4.6 缺陷 2.3）——Subagent Session 只作执行上下文，不作恢复依据；引擎/节点状态重建走自己的 RunLedger。
- **并行分支合并**：汇聚后一次 checkpoint；字段冲突**默认 `reject-on-conflict`**（两分支写同一字段 → 抛错 + RunLedger 记冲突，不静默覆盖）；`merge` 仅对声明 `@mergeable` 的字段启用。
- **资源生命周期约束（Cordis，精确约束）**：引擎/总线/RunLedger 内**不得使用裸 `setTimeout`/`setInterval`/`fs.open`/`new Database()`**；所有非 Cordis 一等服务的资源必须 `ctx.effect(() => {...; return disposer})` 注册，disposer 完整释放。⚠️ Discussion #2854：HMR recompose 在 fiber disposal 与 recompose 间有竞态，非 effect 资源可能泄漏或过早清理（案例：第三方 bundle 插件 boot 后 ~3s 被静默禁用）。**热重载测试作为 MVP-2 门禁一部分**——插件热重载后验证无资源泄漏。RunLedger 建议直接用 `ctx.storageDomain`（一等服务，框架管生命周期）。

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
```
- `handoff.upstream/downstream` 直接生成图**有向边**（"画图连线"的语义来源）。
- **生命周期**：核心角色 resident、边缘 on-demand、hybrid 活跃窗口降冷恢复；冷恢复 SLA >10s 降级人工。
- **模型显式指定（🐛 继承缺陷）**：`{ provider, model }` **完整对象**在 `startContinuable` 时经 `agentRouteDefaults` 显式传入，不依赖继承（继承的是冻结时的默认路由）+ 不依赖默认 provider（spawn 可能路由到 deepseek-official 错账户）。
- **权限在 provider 层**：官方 dispatch 结构性无法携带 settings，`tools`→toolFilter 即最小权限声明。
- **并发多层防护（`max_concurrent_children` 只是单点 cap，无法阻止跨 provider/跨 run 累积并发）**：

| 层级 | 机制 | 来源 | 本项目 |
|---|---|---|---|
| Provider 层 | maxConcurrentChildren / idleTimeoutMs | dsh-plugin-product-subagents | L3 YAML `max_concurrent_children` |
| Agent Loop 层 | maxToolCallsPerTurn / maxStepsPerTurn，spawn/fork 作为工具调用在执行体前被拒 | dsh-turn-budget | 引擎初始化时挂载 |
| 引擎层 | 节点激活前检查**全局活跃 child 计数** | 自建（StateGraph） | MVP-2 定义 |
| 进程/事件循环层 | **无官方方案** | —— | 结构性限制，接受或自建 |

> ⚠️ 广度爆炸真实案例（Discussion #131）：~56 子代理 → 2.2GB 内存、单核满载 20min、UI 无响应；根因是 dsh-subagent 无任何数量/并发上限，`maxDepth` 只限深度挡不住广度（1→N→N²）。多层叠加可覆盖"单 provider 广度爆炸"+"单 turn 迭代失控"，但**无法完全阻止跨 provider 累积并发**——DSH 结构性限制，设计时明示。

### 4.5 Token 熔断（复用官方 + 社区，不自研）

- **首选：复用 `@deepseek-ai/dsh-agent-budget`（官方 bundle）**——durable session + descendant-tree scopes；soft accounting / hard admission；绝对 deadline 跨 restart 存活；每次 LLM 调用前预留 capacity，stream settle 后用 provider-reported usage 替换估算，**并发子代理不花同一份剩余余额**。→ 替代自研"角色级+图级预算"，**采集点 = provider 层（官方 Token Meter 提供），解决"采集点不明确"**。
- **兜底：挂载 `dsh-discipline-guard`（社区四道硬闸门）**——loop circuit-breaker（第 4 次重复 denied before dispatch）、cost fuse（从 real usage data 计量：input token net of cache、cache-hit rate、per-turn cumulative，典型 token-plan 先警告、同 turn 重复违规 hard-stop）、route watcher、plan gate；挂在 harness waterfall（tools/pre-execute、agent/pre-step、session/event），**模型无法绕过**。
- **软/硬阈值语义**：软 80% → 上下文压缩/滑动窗口摘要；硬 100% → 人工审批/降级；图级预算 = Σ角色 + 引擎开销余量。
- **自研 RunLedger 回调降级为"记账/可观测"**（非强制闸门），强制熔断交给官方/社区闸门；参考 dsh-fuse（per-call metering + offline fuse, fail-closed + unpricedFallback）。

### 4.6 subagent 已知缺陷规避（契约级，🐛 已确认）

| 缺陷 | 影响 | 契约规避 |
|---|---|---|
| 1. 继承过期 base 默认模型 | 运行中切模型不传播到子代理，错误被吞 | `{ provider, model }` 完整对象经 agentRouteDefaults 显式传入 |
| 2. spawn 路由到 deepseek-official | 计费记错账户 | 显式指定 `agentRouteDefaults.provider`，不依赖默认路由 |
| 3. Messages 协议历史 notice 毒化 | 跨 0.1.6-alpha.1 升级后旧会话永久不可用（0.1.6-alpha.1 前 settlement notice 含 reasoning/tool-call blocks，Messages 协议无法表示，1 个旧 notice 毒化整个 history，实测 15 session 全失败） | **不依赖 subagent settlement notice 恢复**（§4.2）；用 RunLedger 重建状态；升级前归档/迁移（清理 reasoning blocks） |

---

## 五、Token 四大优化

1. **System Prompt 重复注入**：Prompt Caching + 分离不变/可变部分，只对可变每轮注入 + 滑动窗口摘要。
2. **交付物传递**：`art://` 工件引用——长产出落盘，消息只传引用+200 字摘要，全文按需展开。
3. **循环回退**：只传结构化 diff + 分层审核（轻量先、完整后）+ max_iterations 强制审批。
4. **看板推送**：事件 payload 只含增量（nodeId+status），完整 State 按 checkpoint 拉取。

---

## 六、MVP 全景与关键环节

| MVP | 名称 | 关键环节 | 门禁 |
|---|---|---|---|
| 0 | 角色资产 | R1-R10 skill ✅ | 已过 |
| 1 | 单链脚本验证 | 封装 R6 角色 provider（model 传完整对象）；workflowEngine 脚本串行 R1→R8 | 多角色顺序跑通真实小任务 |
| 2 | **自研 StateGraph 引擎** | 图 DSL schema + checkpoint 契约(+Cordis 精确约束+并行默认+RunLedger 恢复)；addNode/addEdge/addConditionalEdge；循环回退+熔断；**全局并发计数**；BDD/mock 结构覆盖测试；挂载 dsh-turn-budget 兜底 | 含循环 DSL 跑通 + 循环退出/熔断双生效 + checkpoint 契约随 DSL 敲定 + 路由/条件边确定性测试(零 LLM) + **热重载后无资源泄漏** |
| 3 | 状态+交接+消息+恢复 | 任务树持久化(storageDomain)；handoff 四字段；父代理中转+分级死锁恢复；RunLedger 重建恢复(不依赖 settlement notice)；分账；**生命周期+多层并发+复用 dsh-agent-budget/discipline-guard**；重启(复用 ctx.jobs)+目标(复用 ctx.goals) | 中断可恢复、交接可追溯、按角色分账、跨角色对话可达 |
| 4 | 只读激活看板 | 节点状态事件流(node-start/end/error/loop-iteration/edge-traversed/checkpoint-written) + 图渲染 + 审批面板 | 全程图节点实时染色 |
| 5 | 角色导入+画布连边 | YAML 导入解析器 + 拖拽连边→DSL + 端口规则 + source 冲突解决 | 零代码搭自定义团队跑通 |
| 6 | 打磨 | 恢复加固/超时降级/记忆压缩/对抗评审/卫生 | 全套门禁 |

**契约敲定时机**：图 DSL+checkpoint（MVP-2 前）｜消息分级恢复+YAML+生命周期+并发多层防护（MVP-3 前）｜Token 熔断复用方案（MVP-3 中，MVP-2 前确认 ctx.llm usage 与 dsh-agent-budget 可用性）｜事件流契约（MVP-4 前）｜画布端口（MVP-5 前）。

---

## 七、难点、风险、待决策

**难点（按难度）**：①StateGraph 原子合并+并发安全（MVP-2 只做串行，并行后推）②冷恢复延迟（活跃窗口+10s SLA）③死锁检测（correlation_id+deadline+分级恢复）④YAML→Provider 映射（system_prompt_ref 分离）⑤画布/YAML DSL 双向同步。

**风险**：
- StateGraph 自研复杂度（参考 dsh-state-graph / dsh-agent-graph 逻辑不抄码）
- 跨版本 API（采信 sendMessage，上线前 dsh --version 复测）
- 循环失控 / 成本爆炸（熔断+预算闸+dsh-discipline-guard loop circuit-breaker）
- Cordis 热重载资源泄漏（非 Cordis 资源一律 ctx.effect() 包装 + 热重载测试入门禁）
- **并发失控多层防护缺失**（provider 单点 cap 无法阻止跨 provider/跨 run 累积并发 → 引擎级全局计数 + dsh-turn-budget 兜底；进程层无官方方案=结构性限制）
- **Messages 协议 notice 毒化**（跨 0.1.6-alpha.1 升级旧会话不可用 → 不依赖 settlement notice 恢复 + 升级前归档）
- **Token 熔断重复造轮子**（自研回调不如官方 dsh-agent-budget → 直接复用 + discipline-guard 兜底）
- 并行字段冲突静默覆盖（reject-on-conflict 默认）
- 画布复杂度（独立验收+只读看板先行）

**待 PM 裁决**：①自研 StateGraph 主方向 ②角色主格式 YAML ③四契约按本文敲定、时机作门禁锚点（experimental agentTeams 已确认不依赖）。

---

## 八、社区/开源参考（学逻辑不抄码）

- **L2 引擎**：dsh-state-graph（checkpoint 回调/熔断/审批门/条件边）；**dsh-agent-graph**（scoped agent nodes + structured handoffs + **bounded rework** + layered global ledger——每个 node 是 fresh subagent，upstream delivery 作 structured contract 交给 downstream，node 发现 upstream 不足时**返回直接上游**（provided/declined/forwarded one hop），与"质量审核→开发"回退逻辑高度吻合；/graph 命令 + /graph resume）；Tangle（死锁/活锁检测）
- **L3 角色/资源边界**：dsh-plugin-product-subagents（maxConcurrentChildren/idleTimeoutMs）、pi2dsh + @tintinweb/pi-subagents（maxConcurrent/maxSubagentDepth）、dsh-turn-budget（per-turn 工具/步数闸）、dsh-plugin-subagent-director（模型路由+角色模板）、Orchid（YAML 定义+滑动窗口摘要）
- **Token/circuit breaker**：dsh-agent-budget（官方 durable 树级预算）、dsh-discipline-guard（四道硬闸门）、dsh-fuse（fail-closed metering）、dsh-token-stats、token-limiter、backstop-ai
- **L4 画布**：dsh-node-flow（节点/端口/If/Switch/Loop/While）、dsh-agent-team-gui（Run Center）
- **调度/生命周期**：dsh-swarm（常驻生命周期/art:// 工件/看门狗）、dsh-expert-orchestrator（Taskboard+消息总线）
- **开源范式**：DeerFlow（子代理独立 checkpointer）、LangGraph（StateGraph/checkpoint/conditional edges）、Cordis 生命周期文档（ctx.effect/LIFO 释放）