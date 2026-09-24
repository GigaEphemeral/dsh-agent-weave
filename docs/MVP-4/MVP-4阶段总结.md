# MVP-4 阶段总结

> 版本：v2（2026-09-24）｜状态：**✅ 核心交付 + 问题修复完成**（阶段0 + 预研 + Phase A/B/C/D/E + 问题 1-5 修复 + 实时进展）
> 基线：DSH 0.1.5-rc.2 + Windows 11 + Node 22
> 目标：CLI 终端视图 → Web 实时看板（D1 页头按钮 + D3 主区切换）+ 图运转/子代理问题修复

## 一、目标达成（10 个硬目标）

| # | 目标 | 达成 | 证据 |
|---|---|---|---|
| G1 | 对话页内入口 | ✅ | `conversation.session.header.actions` slot 注册 Weave 看板按钮 |
| G2 | 主区看板切换 | ✅ | `conversation.view` slot 注册 ViewTab（weave-dashboard） |
| G3 | 实时图染色 | ✅ | SSE 流 + applyEvent 增量更新（≤2s 反映）+ 全局流自动绑定 graphId |
| G4 | 当前节点活动 | ✅ | 点击节点 → 活动面板（SSE 实时流 + 3s 轮询兜底） |
| G5 | Token 分账 | ✅ | token-collector 引擎接入 + `/tokens` 真实数值 |
| G6 | 审批面板 | ✅ | approval-service + ApprovalPanel（待办/批准/拒绝/倒计时） |
| G7 | 观察者信号 | ✅ | P4.B.7 引擎观察器 → ledger + SSE → SignalPanel 热力图 |
| G8 | 消息流（零 token） | ✅ | message-bus → ledger `agent-message`（只存摘要）→ SSE → 时间线 |
| G9 | 运行控制 | ✅ | 内存化图控制 + PAUSE/RESUME/STOP 文件 + `/pause|resume|stop` 端点 |
| G10 | 真实环境回归 | ✅ | weave-test profile 启动：6 角色注册 + REST `[]` + SSE connected |

## 二、代码审查问题修复（P0-1~P0-20）

| # | 问题 | 状态 |
|---|---|---|
| P0-1 | 引擎事件未桥接 bus | ✅ eventSink 参数 |
| P0-2 | bus 不共享 | ✅ shared-bus.ts（单图模式） |
| P0-3 | artifactsRoot 用 cwd | ✅ artifacts-root.ts（R45） |
| P0-4 | 假 signal | ✅ 贯通外部 signal（契约必填） |
| P0-5 | 并发闸拒绝版 | ✅ 已用 createQueueingCounter（MVP-3） |
| P0-6 | ConditionHandler 缺 `'__SKIP__'` | ✅ 补类型 |
| P0-7 | 命令列表缺 tail | ✅ index.ts 补 weave_graph_tail |
| P0-8 | wait-for listener 泄漏 | ✅ cleanup 摘 listener |
| P0-9 | Client 构建路径 | ✅ src/client/ 统一 |
| P0-10 | event-bus 缺 waiting/paused | ✅ 补状态 |

P1 全修（ledger/tokenCollector/approvalPolicy/observer 接入引擎、artifactName/edgeRole、graphId 复用、initialLoopUsage、GraphEngineService opts、Client 实现）。
P2 修 3 项（observer-l2 信号统一、webServer 契约修正、react peerDep）。

## 三、预研关键发现（计划偏差 3 处）

1. **D1 挂载点**：`conversation.header` 不存在 → 用 `conversation.session.header.actions`
2. **webServer 契约**：`register({kind,path,handler})` 对象形式（非字符串路由）；`ctx.get` 鸭子类型 + 轮询（不可 inject）
3. **react 构建**：loader 提供 react → tsdown neverBundle react（避免双 react）

详见 `docs/MVP-4/预研结论.md`。

## 四、问题修复（问题 1-5 + 实时进展）

真实环境回归后发现的 6 个问题全部修复（详见各问题文档）：

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| **1** | 看板无法实时显示图进展 | ① 双 graphId 不一致 ② 工具同步阻塞 ③ 前端空 graphId 不请求 ④ 无全局广播 | 统一 graphId → `weave_run_graph` 异步化秒返回 → 全局 SSE `/api/weave/stream` → Client 订阅自动绑定 → `/graphs/active` 兜底 |
| **2** | 子代理自动 spawn 下级（5-10x token） | ① `maxDepth` 错赋 `max_concurrent_children` ② `subagent` 内置能力不受 toolFilter 管 ③ skill 未禁止委派 | `capability` 声明机制（`allow_delegation`/`max_depth`）→ depthLimit 语义修正 → 6 角色 YAML + 6 skill 硬约束 |
| **3** | 子代理无法互动（跑完即销毁） | `addSubagent` 用 one-shot `start()` | 最小版：`startContinuable` 建 durable child + provider `prepareContinuable` + `subagent/end` 事件等待 |
| **4** | 图中间出错继续空跑 | 节点无产物验证；失败不传播 | `quality_gate` 产物验证（非空/至少 N 个）→ 失败即停整图 + 内存化图控制（即时 pause/resume/stop） |
| **5** | 断点恢复 + 向上通知 | 无错误分类/暂停快照/resume 工具 | `error-classifier` → `PauseSnapshot` 落盘 `pauses/<id>.json` → 引擎 catch 暂停 + approval 通知 → `weave_graph_resume` 从暂停节点续跑复用子代理 |
| **6** | 看板看不到子代理实时进展 | ① `ctx.off` 未 inject 崩溃 ② `subagent/end` scoped 事件缺 `{global:true}` 收不到 ③ 无活动桥接 | disposer 取消订阅修崩溃 → 事件加 global 监听修超时 → `session/event` 桥接 `graph/node-activity`（💭/🔧/✓/💬）→ 看板 SSE 实时流 |

**新增工具**：`weave_graph_resume`（从暂停快照恢复）。`weave_graph_help` 加契约章节：暂停处理契约（禁止重跑/猜意图/谎报完成）+ 禁止探测插件源码 + 图启动后报告 graphId + 出错引导 help。

## 五、质量数据

- **284 测试全绿**（47 文件；新增 shared-bus/artifacts-root/event-schema/sse-broker/spec-registry/approval-service/run-history/message-bus-ledger/phase-d/problem1-realtime/graph-path/problem4-tolerance/problem5-resume/activity-bridge 等）
- typecheck 0 error + build 通过 + 无 .ts 残留
- 真实环境：weave-test profile（3081）REST + SSE 回归通过
- 14 次 commit，未 push

## 六、门禁状态

| 门禁 | 状态 | 说明 |
|---|---|---|
| G0' 阶段0 | ✅ | typecheck 0 + test≥240 + 产物落 workspace + artifactName/initial_state 生效 |
| G-A Phase A | ✅ | 事件契约归档 + SSE broker 单测 + bus 完整节点事件 |
| G-B Phase B | ✅ | 11 REST 端点（prefix 分发）+ SSE + 审批唤醒 + pause/stop + agent-message 零 token + /tokens 真实 |
| G-C Phase C | ✅ | D1 按钮 + D3 视图 + 染色 + 审批 + 信号 + Token + 消息流 + 活动 + ErrorBoundary |
| G-D Phase D | ✅ | 暂停/恢复/终止生效 + checkpoint 端点 + 观察者 L2 + RunLedger + 按角色分账 |
| G-FINAL | ⚠️ 部分 | 代码+单测+真实环境 REST/SSE 通过；浏览器人工目检（D1 按钮可见/D3 切换）待用户在 3081 页面确认 |

## 七、待办（MVP-5 / 后续）

1. **浏览器人工目检**：打开 http://127.0.0.1:3081 点 Weave 看板按钮，确认 D1+D3 视觉与交互
2. **真实 LLM 端到端**（G10 完整）：真实 subagent 跑图 → 看板实时染色 + Token 真实数值 + 子代理活动流
3. **跨进程恢复**：`weave_graph_resume` 依赖同进程 spec-registry；重启后需 spec 持久化
4. `ctx.on('dispose')` 类型桥接处补正式 Events 声明（P2-8）
5. checkpoint store 全局化（/checkpoints 返回真实恢复点，Phase D 预留）
6. 消息流零 token 验证报告（真实 sendMessage 场景）→ `docs/MVP-4/消息流零token验证报告.md`

---

**关联**：`docs/MVP-4/MVP-4-Task.md`、`docs/MVP-4/预研结论.md`、`docs/MVP-4/事件流契约.md`、`docs/MVP-4/真实环境回归清单.md`、`docs/MVP-4/问题一_图状态不实时.md`、`docs/MVP-4/问题二_图运转和子代理相关问题.md`、`test-env/verify-mvp4.ps1`。
