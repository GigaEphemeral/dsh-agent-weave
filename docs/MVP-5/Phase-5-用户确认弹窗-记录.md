# MVP-5 第 5 轮：用户确认弹窗 + Phase H 验收清单

> 版本：v1（2026-09-25 第 5 轮）

## 本轮新增

- `UserQuestionModal.tsx`（Phase I 通道 A）：监听 `weave:user-question`，支持选项/自定义回答；回答 POST /tasks/:id/answer
- WeaveDashboardView：SSE 收到 `graph-paused`（awaiting-user / approval-pending / environment-gate）→ 自动派发弹窗
- `docs/MVP-5/Phase-H-验收清单.md`：23 项验收场景逐项映射（实现位置/单测证据）

## 验证

- `pnpm typecheck`：0 error
- `pnpm build`：通过（client.js 72KB）
- `pnpm vitest run`：**59 文件 / 352 测试全绿**

## 剩余真实环境项

- #10 右侧滑出自动激活（PR-5.6）、#20 头顶气泡 UI 细化、#22 真实跳转（PR-5.3）、Phase H 真人 E2E
