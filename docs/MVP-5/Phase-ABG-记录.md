# MVP-5 Phase A/B/G：角色库 + 图保存复用 + 结构化日志

> 版本：v1（2026-09-25）｜状态：✅ 后端层完成（Client 交互待下一轮）
> 依据：`docs/MVP-5/MVP-5-task-union.md` 第五/六/十一节

## Phase A：角色库

- 角色 YAML 扩展：`description` / `order` / `tags` / `suggests_next`
- `src/l4-visual/host/role-library.ts`：`listRoles({search, sort})` / `getRole(id)`，按 order 或 name 排序，id/name/description/tags 搜索
- REST：`GET /api/weave/roles?search=&sort=`
- 6 个角色 YAML 已补充描述/排序/标签/推荐

## Phase B：图保存与复用

- `src/l4-visual/host/graph-store.ts`：保存（校验+hash+YAML/meta.json 落盘）、列表、读取、删除、复制
- 存储布局：`<根>/weave/graphs/<id>.yaml + <id>.meta.json`（可用 `setGraphsDir` 注入）
- REST：`POST /graphs`、`GET/DELETE /graphs/saved/:id`、`POST /graphs/saved/:id/clone`、`GET /graphs/saved`

## Phase G：结构化日志

- `src/l4-visual/host/log-reader.ts`：读取 `traces/<graphId>.jsonl`，支持 limit / level / search 过滤
- REST：`GET /graph/:graphId/logs?level=&search=&limit=`

## 验证

- `pnpm typecheck`：0 error
- `pnpm build`：通过
- `pnpm vitest run`：**55 文件 / 332 测试全绿**（新增 role-library 4、graph-store 3、log-reader 3）

## 未完成（依赖真实环境/UI 预研）

- Phase C 引导式画布（React Flow + DnD，PR-5.9）
- Phase D 动效 + 头顶气泡（Client）
- Phase I Client 右侧滑出面板（PR-5.6 Slots 探测）
- Phase F 双击跳转 subagent（PR-5.3）
- Phase E Token 面板 UI（后端 MVP-4 已具备）
- Phase H 真实 LLM E2E（需用户实测）
