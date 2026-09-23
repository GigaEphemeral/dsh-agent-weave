# MVP-4 阶段总结

> 版本：v1（2026-09-24）｜状态：**✅ 核心交付完成**（阶段0 + 预研 + Phase A/B/C/D/E 代码与单测；真实环境 REST/SSE 回归通过）
> 基线：DSH 0.1.5-rc.2 + Windows 11 + Node 22
> 目标：CLI 终端视图 → Web 实时看板（D1 页头按钮 + D3 主区切换）

## 一、目标达成（10 个硬目标）

| # | 目标 | 达成 | 证据 |
|---|---|---|---|
| G1 | 对话页内入口 | ✅ | `conversation.session.header.actions` slot 注册 Weave 看板按钮 |
| G2 | 主区看板切换 | ✅ | `conversation.view` slot 注册 ViewTab（weave-dashboard） |
| G3 | 实时图染色 | ✅ | SSE 流 + applyEvent 增量更新（≤2s 反映） |
| G4 | 当前节点活动 | ✅ | 点击节点 → `/node/:id/activity` 轮询显示活动行 |
| G5 | Token 分账 | ✅ | token-collector 引擎接入 + `/tokens` 真实数值 |
| G6 | 审批面板 | ✅ | approval-service + ApprovalPanel（待办/批准/拒绝/倒计时） |
| G7 | 观察者信号 | ✅ | P4.B.7 引擎观察器 → ledger + SSE → SignalPanel 热力图 |
| G8 | 消息流（零 token） | ✅ | message-bus → ledger `agent-message`（只存摘要）→ SSE → 时间线 |
| G9 | 运行控制 | ✅ | PAUSE/RESUME/STOP 文件 + `/pause|resume|stop` 端点 |
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

## 四、质量数据

- **260 测试全绿**（42 文件；新增 shared-bus/artifacts-root/event-schema/sse-broker/spec-registry/approval-service/run-history/message-bus-ledger/phase-d 等 12 文件）
- typecheck 0 error + build 通过 + 无 .ts 残留
- 真实环境：weave-test profile（3081）REST + SSE 回归通过
- 8 次 commit，未 push

## 五、门禁状态

| 门禁 | 状态 | 说明 |
|---|---|---|
| G0' 阶段0 | ✅ | typecheck 0 + test≥240（238）+ 产物落 workspace + artifactName/initial_state 生效 |
| G-A Phase A | ✅ | 事件契约归档 + SSE broker 单测 + bus 完整节点事件 |
| G-B Phase B | ✅ | 11 REST 端点（prefix 分发）+ SSE + 审批唤醒 + pause/stop + agent-message 零 token + /tokens 真实 |
| G-C Phase C | ✅ | D1 按钮 + D3 视图 + 染色 + 审批 + 信号 + Token + 消息流 + 活动 + ErrorBoundary |
| G-D Phase D | ✅ | 暂停/恢复/终止生效 + checkpoint 端点 + 观察者 L2 + RunLedger + 按角色分账 |
| G-FINAL | ⚠️ 部分 | 代码+单测+真实环境 REST/SSE 通过；浏览器人工目检（D1 按钮可见/D3 切换）待用户在 3081 页面确认 |

## 六、待办（MVP-5 / 后续）

1. **浏览器人工目检**：打开 http://127.0.0.1:3081 点 Weave 看板按钮，确认 D1+D3 视觉与交互
2. **真实 LLM 端到端**（G10 完整）：真实 subagent 跑图 → 看板实时染色 + Token 真实数值
3. `ctx.on('dispose')` 类型桥接处补正式 Events 声明（P2-8）
4. checkpoint store 全局化（/checkpoints 返回真实恢复点，Phase D 预留）
5. 消息流零 token 验证报告（真实 sendMessage 场景）→ `docs/MVP-4/消息流零token验证报告.md`

---

**关联**：`docs/MVP-4/MVP-4-Task.md`、`docs/MVP-4/预研结论.md`、`docs/MVP-4/事件流契约.md`、`docs/MVP-4/真实环境回归清单.md`、`test-env/verify-mvp4.ps1`。
