# MVP-5 阶段总结（代码层）

> 版本：v1（2026-09-25 第 7 轮）｜状态：✅ 代码层完成（59 文件 / 352 测试全绿）
> 目标：`docs/MVP-5/MVP-5-task-union.md` 全部 Phase；`verify-mvp5.ps1` 一键验证

## 完成清单（代码 + 单测）

| Phase | 交付 | 单测 |
|---|---|---|
| 0 前置修复 | ProjectMemory/Facts、EnvironmentGate、OutputGate、graphConstraints、错误分类 | project-memory 6 / environment-gate 5 / mvp5-phase0 13 |
| I 入口 | weave_propose_task、task-store（8 状态+单图守卫+模板）、/tasks REST、SSE task-proposed | propose-commands 3 / task-store 11 / routes 5 |
| A 角色库 | role-library（搜索/排序/描述/推荐）、GET /roles、角色 YAML 元数据 | role-library 4 |
| B 图保存 | graph-store（CRUD+复制+哈希）、/graphs REST | graph-store 3 |
| C 引导式画布 | CanvasEditor（拖入/连边/推荐/配置/DSL）、canvas-model 纯模型 | canvas-model 4 |
| D 动效 | 边流动画、节点活动头顶气泡（useActivityFeed + GraphCanvas） | —（构建验证） |
| E Token | /tokens byRole、TokenPanel 按角色 | token-collector 5 |
| F 跳转 | childId child-ready 事件、双击 best-effort | subagent-node +1 |
| G 日志 | log-reader、/graph/:id/logs | log-reader 3 |
| H 验收 | Phase-H-验收清单.md、verify-mvp5.ps1 | 全量 352 |

## 代码规模

- 新增模块：project-memory / environment-gate / output-gate / task-store / role-library / graph-store / log-reader / canvas-model / propose-commands
- Client：RoleLibraryPanel / WeaveTaskPanel / WeaveEditPanel / UserQuestionModal / CanvasEditor / useActivityFeed
- 新增测试文件 10 个，测试总量 284 → 352

## 验证证据

- `pnpm typecheck`：0 error
- `pnpm build`：通过
- `pnpm vitest run`：**59 文件 / 352 测试全绿**
- `pwsh -File test-env/verify-mvp5.ps1`：一键复验

## 剩余（必须真实 DSH/LLM 环境）

| 项 | 说明 | 文档指引 |
|---|---|---|
| PR-5.6 右侧滑出自动激活 | 已加 best-effort `slots.activate`，真实签名待探测 | 预研项状态.md |
| PR-5.3 真实 subagent 跳转 | best-effort hash；真实路由待探测 | 预研项状态.md |
| PR-5.7 ask_user_question 弹窗链路 | UserQuestionModal 已备；真实子代理路由待测 | 预研项状态.md |
| Phase H 真人 E2E | 一句话 → 面板 → 开始 → 看板 | Phase-H-验收清单.md |
