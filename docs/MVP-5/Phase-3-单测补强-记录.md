# MVP-5 第 3 轮：Phase H 单测补强

> 版本：v1（2026-09-25 第 3 轮）

## 本轮新增

- `tests/cli/propose-commands.spec.ts`（3 用例）：`weave_propose_task` 执行流——创建草稿/返回 taskId、单图模式拒绝、按 session 隔离
- `tests/l4-visual/task-store.spec.ts` 追加 2 用例：8 状态机“仅 proposing/drafting 可启动”、drafting→running(failed) 后可再提议
- 覆盖验收清单（Phase I #8/#9/#15、Phase H #“weave_propose_task → 草稿 → 启动”状态流转）中可单测部分

## 验证

- `pnpm typecheck`：0 error
- `pnpm build`：通过
- `pnpm vitest run`：**58 文件 / 347 测试全绿**

## 剩余（真实环境项，沙箱内无法完成）

- PR-5.6 宿主 Slots 自动激活右侧滑出（已有看板内抽屉实现）
- PR-5.3 真实 subagent 视图跳转（已有 best-effort hash 跳转）
- Phase H 真实 LLM E2E（用户实测）
