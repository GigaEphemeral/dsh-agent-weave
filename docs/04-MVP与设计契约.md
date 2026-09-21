# 可视化 Agent 任务编排工具 · MVP 与设计契约（整合版）

> 整合自：04-v2 + 04-v3 + 05 契约 + 运行时/资源边界/故障恢复三轮查漏（2026-09-22）｜依据：`docs/03-能力探测与复用结论.md` + 多方评审
> 本文件是 MVP 与契约的**唯一权威版**。

---

## 一、方向定位

**最终目标**：可视化 agent 任务编排工具——一句话需求 → 拆成工作流任务图 → 多角色 subagent 按图自动协作（含循环）→ 激活状态可视化 → 每 agent 独立记忆防污染 + 互相对话 → 角色可导入文件创建、画图连线。

**三条方向修正**（v2→v3→定稿）：

| | 早期方案 | 定稿 | 理由 |
|---|---|---|---|
| 编排引擎 | 图 DSL → workflowEngine script | **自研 StateGraph**（图 DSL 直驱 subagents） | workflowEngine 是脚本式，表达条件边/循环/精确节点状态别扭；StateGraph 才是图范式 |
| workflowEngine | 主引擎 | 降为 MVP-1 临时验证 | 复用现成脚本+chat 可视化，先验"角色协作"闭环 |
| 角色定义 | provider + persona string | **YAML 元数据 + `system_prompt_ref` 指向 skill** | traits 是元数据（画布/边依赖），Prompt 内容来自 skill 文件，R1-R10 直接复用 |

**不要做（评审采信）**：①不依赖 experimental agent-team（不支持循环+实测不兼容）②不用社区插件（版本不匹配）③不自研记忆隔离（subagent 已提供）④不自研 Prompt（skill 已有）。

---

## 二、分层架构（L0-L5）

```
L0 角色资产      R1-R10 skill + 3 横切纪律（已完成，system_prompt_ref 直接指向）
L1 执行与记忆    官方 @deepseek-ai/dsh-subagent（Continuable child + 独立 Session + 记忆隔离）
L2 编排引擎      自研 StateGraph（图 DSL + 条件边 + 循环回退 + 迭代熔断 + checkpoint）
L3 角色管理      自研 YAML 配置（特质/工具/模型/质量门/预算/handoff 依赖/生命周期/并发上限）
L4 可视化        自研画布 + 实时激活状态 + Token 监控
L5 可观测与治理  轨迹追踪 · RunLedger 审计账本 · 策略合规 · 成本熔断 · 行为漂移检测（见 docs/02）
```

复用层仅 L1；自建 L2/L3/L4/L5。**图 DSL = L2 输入；L4 画布 = DSL 编辑器；L3 YAML = 每个节点的角色元数据。**

> 全栈以 **Cordis 插件形态**存在（引擎/画布/角色加载器都是插件）：所有非 Cordis 管理的资源必须遵守生命周期契约（见 §4.2），否则热重载泄漏。

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
节点只返回 `Partial<State>`，引擎**原子合并**（状态修改统一由引擎执行 → 可恢复）。条件边：质量审核输出 `retry` → 回开发节点 `retry_count++`；`retry_count >= max_iterations` → 强制人工审批。

### 3.2 消息总线（父代理中转 + 防死锁）

A→B 对话 = A `sendMessage` 给编排器（父）→ 父解析目标 → 转投 B。防死锁：`correlation_id` + `deadline` + **分级恢复**（见 §4.3）。API 名采信实测 `sendMessage`。

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
- 落盘 `{ graphId, node, state, iteration }` → session-log/SQLite/fs（复用 storageDomain）；**同一回调同时追加 RunLedger 事件**（State 快照 + 历史轨迹双写，支撑 MVP-3 恢复 + MVP-4 染色/分账）。
- 恢复 = 从**最近 checkpoint** 重建；引擎保持内存态，持久化由宿主 checkpoint 承担。
- **并行分支合并**：汇聚后一次 checkpoint；字段冲突**默认 `reject-on-conflict`**（两分支写同一字段 → 引擎抛错 + RunLedger 记冲突，不静默覆盖）；`merge` 仅对声明 `@mergeable` 的字段启用。
- **资源生命周期约束（Cordis）**：引擎/总线/RunLedger 内非 Cordis 管理的资源——循环超时定时器、deadline 定时器、文件句柄/DB 连接、watcher——必须 `ctx.effect()` 注册并返回 disposer，确保插件热重载时完整回滚；`registerProvider` 本身是 Cordis effect 会自动撤销，但引擎持有的定时器/连接不会。

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
| correlation_id 的 Agent 访问计数超阈值（同一 Agent 同链路被触发 ≥3 次） | 强制终止链路 + 诊断写入 RunLedger |
| 整个工作流超时 | 降级到人工审批节点 |

- 借鉴 dsh-swarm 看门狗（claimed 超 5min 重派、重试 ≤3）；死锁/活锁检测另可参考 Tangle（为 LangGraph 设计）。

### 4.4 角色 YAML schema + 生命周期 + 资源边界（MVP-3 前）

```yaml
role:
  schema_version: "1.0"
  id: R3
  system_prompt_ref: "skills/R3-developer.md"   # Prompt 内容来自 skill，非 traits 组装
  traits: [...]          # 元数据：画布显示 + 边依赖
  capabilities: [...]
  tools: [...]           # → toolFilter
  memory_scope: private  # → inheritsParentContext=false
  lifecycle: resident | on-demand | hybrid      # 常驻/按需/活跃窗口(N分钟,默认5)
  model: <模型路由>      # → agentRouteDefaults.model（⚠️ 必须显式指定：子代理继承有已知 bug）
  max_concurrent_children: 8   # 并发上限：dsh-subagent 无内置并发闸，provider 层强制
  quality_gate: [...]
  token_budget: 50000
  handoff: { upstream: [R2], downstream: [R4,R5], edge_type: seq|cond }
```
- `handoff.upstream/downstream` 直接生成图**有向边**（"画图连线"的语义来源）。
- **生命周期**：核心角色(开发/测试) resident、边缘(复盘) on-demand、hybrid 活跃窗口超时降冷恢复；冷恢复 SLA >10s 降级人工。
- **并发上限（资源边界）**：`dsh-subagent` 无任何数量/并发上限，广度爆炸真实发生过（~56 子代理 → 2.2GB 内存、单核满载 20min、UI 无响应）。`max_concurrent_children` 在 provider 层限制同时活跃 child（参考 dsh-plugin-product-subagents 的 maxConcurrentChildren=8/idleTimeoutMs=600000、pi2dsh 默认 maxConcurrent=4/maxSubagentDepth=2）。MVP-2 串行可不启用，但字段+校验逻辑必须现在就定义好。
- **模型显式指定**：子代理继承模型有已知 bug（继承过期 base + spawn 路由错账户），`model`/`provider` 创建时走 agentRouteDefaults 显式指定，不依赖继承。
- **权限在 provider 层**：官方 dispatch 结构性无法携带 settings，`tools`→toolFilter 即最小权限声明，R3 shell / R5 只读等在 provider 注册时预配置。

### 4.5 Token 熔断（MVP-2/3 纳入，含落地机制，不等打磨）

- 软阈值 80% → 上下文压缩/滑动窗口摘要；硬阈值 100% → 人工审批/降级；图级预算 = Σ角色 + 引擎开销余量；熔断进 StateGraph 条件边判断。
- **落地机制（谁在何时检查、如何触发）**：落地点 = **RunLedger 写入回调**——每次节点完成时从 LLM 响应提取 token 消耗，累加到工作流级 + 角色级预算计数器；超软阈值 → 下一节点预处理注入"请压缩上下文"指令；超硬阈值 → 条件边直接路由审批节点。参考 token-limiter（record+ceiling+circuit breaker）、backstop-ai（reserve/commit per request）、hummbl-governance（3 次失败 open + recovery_timeout）。
- **采集点决策（待敲定）**：token 在 **LLM provider 层** 还是 **StateGraph 节点层** 采集？节点层需在每个节点执行函数包裹采集逻辑；provider 层需确认 `ctx.llm` 是否返回 per-call usage。**MVP-2 前确认 `ctx.llm` 接口是否暴露 usage 字段**，据此定采集点。

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
| 1 | 单链脚本验证 | 封装 R6 角色 provider；workflowEngine 脚本串行 R1→R8 | 多角色顺序跑通真实小任务 |
| 2 | **自研 StateGraph 引擎** | 图 DSL schema + checkpoint 契约(+Cordis 生命周期约束+并行合并默认)；addNode/addEdge/addConditionalEdge；循环回退+熔断；BDD/mock 结构覆盖测试；确认 ctx.llm usage | 含循环 DSL 跑通 + 循环退出/熔断双生效 + checkpoint 契约随 DSL 敲定 + 路由/条件边确定性测试(零 LLM) |
| 3 | 状态+交接+消息+恢复 | 任务树持久化(storageDomain)；handoff 四字段；父代理中转+分级死锁恢复；checkpoint 恢复；分账；**生命周期+并发上限+Token 熔断落地**；重启(复用 ctx.jobs)+目标(复用 ctx.goals) | 中断可恢复、交接可追溯、按角色分账、跨角色对话可达 |
| 4 | 只读激活看板 | 节点状态事件流(node-start/end/error/loop-iteration/edge-traversed/checkpoint-written) + 图渲染 + 审批面板 | 全程图节点实时染色 |
| 5 | 角色导入+画布连边 | YAML 导入解析器 + 拖拽连边→DSL + 端口规则 + source 冲突解决 | 零代码搭自定义团队跑通 |
| 6 | 打磨 | 恢复加固/超时降级/记忆压缩/对抗评审/卫生 | 全套门禁 |

**契约敲定时机**：图 DSL+checkpoint（MVP-2 前）｜消息分级恢复+YAML+生命周期+并发上限（MVP-3 前）｜Token 熔断落地+采集点（MVP-3 中，MVP-2 前先确认 ctx.llm usage）｜事件流契约（MVP-4 前）｜画布端口（MVP-5 前）。

---

## 七、难点、风险、待决策

**难点（按难度）**：①StateGraph 原子合并+并发安全（MVP-2 只做串行，并行后推）②冷恢复延迟（活跃窗口+10s SLA）③死锁检测（correlation_id+deadline+分级恢复）④YAML→Provider 映射（system_prompt_ref 分离）⑤画布/YAML DSL 双向同步（source 冲突解决）。

**风险**：
- StateGraph 自研复杂度（参考 dsh-state-graph 逻辑不抄码）
- 跨版本 API（采信 sendMessage，上线前 dsh --version 复测）
- 循环失控 / 成本爆炸（熔断+预算闸+人工审批）
- **Cordis 热重载资源泄漏**（非 Cordis 资源一律 ctx.effect() 包装）
- **并行/BFS 广度爆炸**（dsh-subagent 无并发闸，L3 `max_concurrent_children` provider 层强制）
- **Token 采集点不明确**（MVP-2 前确认 ctx.llm 是否返回 usage）
- **死锁恢复动作缺失**（按超时类型分级：重试/终止链路/降级审批）
- **并行字段冲突静默覆盖**（默认 reject-on-conflict，不 last-write-wins）
- 画布复杂度（独立验收+只读看板先行）

**待 PM 裁决**：①自研 StateGraph 主方向 ②角色主格式 YAML ③四契约按本文敲定、时机作门禁锚点（experimental agentTeams 已确认不依赖——实测不兼容 PR #257，task DAG/mailbox 自建）。

---

## 八、社区/开源参考（学逻辑不抄码）

- **L2 引擎**：dsh-state-graph（checkpoint 回调/熔断/审批门/条件边）；Tangle（LangGraph 死锁/活锁检测）
- **L3 角色/资源边界**：dsh-plugin-product-subagents（maxConcurrentChildren=8/idleTimeoutMs）、pi2dsh + @tintinweb/pi-subagents（maxConcurrent=4/maxSubagentDepth=2）、dsh-turn-budget（maxToolCallsPerTurn 闸）、dsh-plugin-subagent-director（模型路由+角色模板）、Orchid（YAML 定义+滑动窗口摘要）
- **L4 画布**：dsh-node-flow（节点/端口/If/Switch/Loop/While）、dsh-agent-team-gui（Run Center）
- **调度/生命周期**：dsh-swarm（常驻生命周期/art:// 工件/看门狗）、dsh-expert-orchestrator（Taskboard+消息总线）
- **Token/circuit breaker**：dsh-token-stats、token-limiter、backstop-ai、hummbl-governance
- **开源范式**：DeerFlow（子代理独立 checkpointer）、LangGraph（StateGraph/checkpoint/conditional edges）、Cordis 生命周期文档（ctx.effect）