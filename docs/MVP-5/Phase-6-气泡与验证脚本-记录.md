# MVP-5 第 6 轮：头顶气泡 + 验证脚本

> 版本：v1（2026-09-25 第 6 轮）

## 本轮新增

- `useActivityFeed.ts`：订阅全局 SSE node-activity，按 graphId 缓存每节点最近活动
- `GraphCanvas.tsx`：运行中/当前节点显示头顶气泡（活动文本 + 图标），验收 #20 落地
- `test-env/verify-mvp5.ps1`：一键验证 typecheck / build / 全量单测

## 验证

- `pnpm typecheck`：0 error
- `pnpm build`：通过（client.js 74KB）
- `pnpm vitest run`：**59 文件 / 352 测试全绿**

## 剩余真实环境项

- PR-5.6 右侧滑出自动激活（已有抽屉 + SSE 派发）
- PR-5.3 真实 subagent 跳转（已有 best-effort）
- Phase H 真人 E2E
