# MVP-5 追加：Phase E/F/I 客户端与服务层补充

> 版本：v1（2026-09-25 第二轮）

## 本轮新增

| Phase | 内容 |
|---|---|
| E | REST /tokens 增加 `byRole` 聚合；TokenPanel 增加“按角色”表格；新增 token-collector 单测（5 用例） |
| F | 引擎在子代理就绪时发出 `graph/node-activity(kind=child-ready, childId)`，前端可据此双击跳转；subagent-node.spec 新增断言 |
| I/A | 新增 Client 面板：`RoleLibraryPanel`（搜索/排序/描述）、`WeaveTaskPanel`（任务列表/开始/取消，监听 weave:task-proposed 刷新），挂载进 WeaveDashboardView |

## 验证

- `pnpm typecheck`：0 error（含 client tsconfig）
- `pnpm build`：通过（client.js 39KB → 48KB，新面板已打包）
- `pnpm vitest run`：**56 文件 / 338 测试全绿**

## 仍待真实环境预研

- Phase C 画布（React Flow/PR-5.9）、Phase D 动效、Phase I 右侧滑出（PR-5.6）、Phase F 跳转 API（PR-5.3）、Phase H 真人 E2E
