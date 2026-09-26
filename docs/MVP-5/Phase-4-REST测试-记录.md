# MVP-5 第 4 轮：REST 路由单测 + 预研状态

> 版本：v1（2026-09-25 第 4 轮）

## 本轮新增

- `routes.ts` 暴露 `getWeaveHandler()`（供单测直接调用内部 handler，不影响生产）
- `tests/l4-visual/routes.spec.ts`（5 用例）：
  - GET /tasks 列表
  - POST /tasks/:id/cancel → aborted
  - POST /tasks/:id/start 缺少 parentAgent → 409
  - GET /roles 搜索返回角色
  - POST /graphs 保存 + GET /graphs/saved 列表
- `docs/MVP-5/预研项状态.md`：PR-5.1~5.10 状态 + 真实环境探测清单

## 验证

- `pnpm typecheck`：0 error
- `pnpm build`：通过
- `pnpm vitest run`：**59 文件 / 352 测试全绿**

## 剩余真实环境项

- PR-5.6 / PR-5.3 / PR-5.7 探测（文档已给操作步骤）
- Phase H 真实 LLM E2E（用户实测）
