# MVP-5 Phase I：结构化任务入口（后端层）

> 版本：v1（2026-09-25）｜状态：✅ 引擎/服务层完成（Client 面板待接）
> 依据：`docs/MVP-5/MVP-5-task-union.md` 第四/十五节（Phase I 入口设计）

## 已实现

| # | 项 | 位置 |
|---|---|---|
| 1 | `weave_propose_task` 工具（草稿 + SSE 推送 + 单图守卫） | `src/cli/propose-commands.ts` |
| 2 | 任务草稿存储（8 状态机 + 会话单活守卫 + 模板图构建） | `src/l4-visual/host/task-store.ts` |
| 3 | 任务 REST API（GET/PATCH/DELETE + start/cancel/answer） | `src/l4-visual/host/routes.ts` |
| 4 | SSE 事件扩展（`task-proposed` / `task-status`）+ 全局 broker 暴露 | `event-schema.ts` / `visual-runtime.ts` |
| 5 | 模板图：full-sdlc / quick-dev / research-only / custom（含 SOP 约束） | `task-store.ts` |

## 关键语义

- **单图模式**：`canProposeTask(sessionId)` 拒绝会话内第二个活跃任务（决策 #9）
- **决策 #1**：`weave_propose_task` 只建草稿，不执行；`weave_run_graph` 由面板/用户点【开始工作】触发
- **start 复用父 Agent**：`weave_propose_task` 调用时捕获 `exec.agent` 存入草稿，REST `/start` 用它启动真实图
- **状态机**：proposing/drafting/running/awaiting_user/paused/stopped/completed/failed/aborted

## 验证

- `pnpm typecheck`：0 error
- `pnpm build`：通过
- `pnpm vitest run`：**52 文件 / 322 测试全绿**（新增 task-store 9 用例）

## 未完成（下一轮）

1. Client 右侧滑出面板（`WeaveEditPanel`）——依赖 PR-5.6 Slots API 探测
2. 画布编辑器（Phase C）+ 角色库 REST（Phase A）
3. 用户确认弹窗（`UserQuestionModal`）——依赖 PR-5.7
4. `weave_graph_help` 任务入口契约章节
