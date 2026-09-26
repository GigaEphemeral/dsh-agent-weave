# MVP-5 第 2 轮：Phase C/D/I/F 客户端落地（零新依赖）

> 版本：v1（2026-09-25 第 2 轮）

## 本轮新增

| Phase | 内容 |
|---|---|
| C | `CanvasEditor.tsx`：原生 div+SVG 引导式画布——角色库拖入、节点拖动、点击连边、suggests_next 推荐面板、节点配置（模型覆盖/输入门禁/审批/仅.md）、DSL 导出 |
| C | `canvas-model.ts` 纯模型（布局 + DSL 构建），新增 4 单测 |
| D | 画布边流动画（CSS keyframes） |
| I | `WeaveEditPanel.tsx`：右侧滑出编辑面板（取消/保存图/开始工作）；看板全局 SSE 订阅 task-proposed 自动打开 |
| F | 画布节点双击 best-effort 打开 `#/subagent/<roleRef>`（真实跳转 API 待 PR-5.3） |

## 验证

- `pnpm typecheck`：0 error（含 client）
- `pnpm build`：通过（client.js 68KB，含画布/面板）
- `pnpm vitest run`：**57 文件 / 342 测试全绿**

## 剩余真实环境项

- PR-5.6：宿主 Slots 自动激活右侧滑出（当前在看板内以抽屉呈现）
- PR-5.3：真实 subagent 视图跳转（当前 best-effort hash 跳转）
- PR-5.9：React Flow 迁移（当前原生实现可继续演进）
- Phase H：真实 LLM 端到端验收（需用户实测）
