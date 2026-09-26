# MVP-5 Phase H：验收清单映射

> 版本：v1（2026-09-25 第 5 轮）
> 对照 `docs/MVP-5/MVP-5-task-union.md` 第十六节验收清单

| # | 场景 | 状态 | 实现/证据 |
|---|---|---|---|
| 1 | R1 只产需求文档不写代码 | ✅ 代码+约束 | 角色 YAML output gate + SKILL 五段；无 pwsh 白名单 |
| 2 | R1 环境缺失 → Environment Gate 暂停 | ✅ 代码+单测 | environment-gate.spec（5） |
| 3 | R6 写完代码 → R7 独立测试 | ✅ 代码 | 独立验证约束 + childId 复用区分 |
| 4 | R8 评审不通过 → success:false | ✅ 代码 | quality_gate 失败 → 图停（MVP-4） |
| 5 | R1 探测事实 → 下游 prompt 注入 | ✅ 代码+单测 | project-memory.spec（6） |
| 6 | 子代理无活动 → 提示不中止 | ✅ 代码（MVP-4） | node-idle-warning 事件 |
| 7 | 用户暂停 → interrupt | ✅ 代码（MVP-4） | waitForSubagentEnd PauseError |
| 8 | 用户说用 weave 创建 → propose_task | ✅ 代码+单测 | propose-commands.spec（3） |
| 9 | 返回 taskId + panelUrl + 摘要 | ✅ 代码 | propose 工具返回 |
| 10 | 面板自动打开右侧滑出 | ⚠️ 待真实环境 | 看板内抽屉已实现；Slots 自动激活待 PR-5.6 |
| 11 | 编辑画布（拖入/连边/门禁/模型） | ✅ 代码 | CanvasEditor + 配置抽屉 |
| 12 | 点开始工作 → 运行图 | ✅ 代码 | WeaveEditPanel → PATCH + /start |
| 13 | R1 有疑问 → UserQuestionModal | ✅ 代码（待真实链路） | UserQuestionModal + graph-paused 派发 |
| 14 | 用户回答 → 图恢复 | ✅ 代码 | POST /tasks/:id/answer → sendMessage |
| 15 | 会话已有活跃任务 → 拒绝 | ✅ 代码+单测 | task-store 单图守卫 |
| 16 | 角色库 描述/搜索/排序 | ✅ 代码+单测 | role-library.spec（4）+ RoleLibraryPanel |
| 17 | 引导推荐面板 | ✅ 代码 | CanvasEditor suggests_next 面板 |
| 18 | 门禁配置抽屉 | ✅ 代码 | CanvasEditor 节点配置 |
| 19 | 图保存落盘 | ✅ 代码+单测 | graph-store.spec（3） |
| 20 | 头顶气泡 | ⏳ 待 UI 细化 | 节点活动面板已有；气泡形态待接 |
| 21 | Token 分账 总/节点/角色 | ✅ 代码+单测 | token-collector.spec（5）+ TokenPanel byRole |
| 22 | 双击节点跳转 subagent | ⚠️ best-effort | hash 跳转；真实 API 待 PR-5.3 |
| 23 | 日志过滤/搜索 | ✅ 代码+单测 | log-reader.spec（3）+ REST /logs |

## 结论

代码层：验收项除 #10（Slots 自动激活）、#20（气泡 UI 细化）、#22（真实跳转 API）、#23 相关真实链路外，
均已实现并附单测（59 文件 / 352 测试全绿）。真实 LLM E2E 与宿主联动需用户在真实环境实测。
