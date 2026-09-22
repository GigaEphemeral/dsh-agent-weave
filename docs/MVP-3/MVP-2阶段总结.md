# MVP-2 阶段总结（自研 StateGraph 引擎）

> 版本：v1（2026-09-23）｜状态：**✅ 阶段完成**（20 任务 + 5 阶段门禁全部通过）
> 基线：DSH 0.1.5-rc.2 + Windows 11 + Node 22.23
> 用途：MVP-1.5 → MVP-2 交付总结；供 MVP-3 启动与用户手动验收参考

## 一、任务完成总览（20/20）

| Phase | 任务 | 交付物 | 结果 |
|---|---|---|---|
| **A 图定义** | T1 引擎内部类型 | `src/l2-engine/types.ts`（9 类型 + 8 轨迹事件） | ✅ |
| | T2 图 DSL Schema | `graph-definition.ts`（6 refine + schemaHash） | ✅ 11 单测 |
| | T3 静态验证器 | `static-validator.ts`（5 检查 + Kahn 环检测 + 性能） | ✅ 9 单测 |
| | T4 CLI 图命令 | `src/cli/graph-commands.ts`（validate/show/help） | ✅ 3 单测 + 实机 |
| **B 引擎** | T5 checkpoint 契约 | `checkpoint.ts`（7 字段 + graphVersion + 版本感知恢复） | ✅ 7 单测 |
| | T6 原子合并 | `atomic-merge.ts`（3 策略 + reject-on-conflict + 结合律） | ✅ 11 单测 |
| | T7 条件边循环 | `condition-edge.ts`（白名单求值 + 回退/升级/终止） | ✅ 14 单测 |
| | T8 全局并发闸 | `concurrency-counter.ts`（基础 + 排队版，effect 清理） | ✅ 7 单测 |
| | T9 引擎骨架 | `state-graph.ts`（5 方法 + 熔断 + 审批门 + 轨迹） | ✅ 9 集成 |
| | T10 ctx.graph 服务 | `graph-service.ts`（Service 子类 + create/fromDefinition） | ✅ 3 单测 |
| **C 可视化** | T11 事件总线 | `l4-visual/host/event-bus.ts`（快照 + 订阅） | ✅ 4 单测 |
| | T12 终端视图 | `terminal-view.ts`（事件流 + 状态头 + 颜色） | ✅ 实机 |
| | T13 HTML 报告 | `html-report.ts`（4 section + SVG 染色 + Token 分账） | ✅ 4 单测 + 实机 |
| | T14 循环告警 | `loop-detector.ts`（80% 告警 + 熔断告警） | ✅ 4 单测 + 实机 |
| **D 合规** | T15 观察者 L1 | `observers/observer-l1.ts + signal.ts`（零 Token） | ✅ 6 单测 |
| | T16 turn-budget | `cordis.patch.yml` 配置段（插件未装，已标注） | ✅ 配置保留 |
| | T17 资源合规 | `docs/MVP-2/资源合规检查.md`（7 项） | ✅ 通过 |
| **E 测试** | T18 测试矩阵 | 全量 168 单测（各模块自带） | ✅ 全绿 |
| | T19 循环端到端 | `tests/integration/loop-workflow.spec.ts`（7 断言） | ✅ 全绿 |
| | T20 版本恢复+热重载 | `version-restore.spec.ts` + `hot-reload.spec.ts`（13 断言） | ✅ 全绿 |

**合计**：20 任务，**168 单测 + 13 集成 = 181 测试全绿**，typecheck 0 error，构建通过。

## 二、门禁检查（5 阶段 + G-FINAL）

| 门禁 | 内容 | 结果 |
|---|---|---|
| **GA** | T1-T4（类型/DSL/验证器/CLI） | ✅ 23 单测 + typecheck |
| **GB** | T5-T10（checkpoint/合并/条件/并发/引擎/服务） | ✅ 51 测试 + 契约冻结 |
| **GC** | T11-T14（总线/视图/报告/告警） | ✅ 12 单测 + **实机验证**（watch/report 输出正确） |
| **GD** | T15-T17（L1/预算/合规） | ✅ 6 单测 + 7 项合规 |
| **GE** | T18-T20（测试矩阵/循环/恢复） | ✅ 181 测试全绿 + 零 LLM |
| **G-FINAL** | `test-env/verify-mvp2.ps1` 一键验收 | ✅ 7/7 通过（含实机 CLI + HTML 报告生成） |

## 三、实机验证记录（隔离环境 weave-headless，mock 零 LLM）

| 命令 | 结果 |
|---|---|
| `weave_graph_help` | ✅ 帮助文本输出 |
| `weave_graph_validate` (visual-demo) | ✅ 图校验通过 |
| `weave_graph_show` (visual-demo) | ✅ ASCII 图：入口/主链/loop/cond/节点详情 |
| `weave_graph_watch` (visual-demo) | ✅ 实时视图：事件流 + Token + retry + 熔断告警 + 成功结束 |
| `weave_graph_report` (visual-demo) | ✅ HTML 生成（4 section：摘要/SVG 染色/时间线/Token 分账） |
| `verify-mvp2.ps1` | ✅ 7/7 通过 |

> 注：隔离 headless 环境缺 spawn provider（角色未注册），图命令不受影响（T4 修复）；
> validate 对 roleRef 图会正确报「角色未注册」——静态验证器行为符合预期。
> role 节点的真实子代理执行属 MVP-3（addSubagent 接入）。

## 四、关键设计决策与修正

| # | 决策/修正 | 说明 |
|---|---|---|
| 1 | **addLoopEdge 独立 API** | `addEdge` 固定 seq；loop 边（maxIter）需显式 `addLoopEdge`，避免类型混淆（T19 发现） |
| 2 | **审批门可选依赖** | `ctx.approval` 经 `ctx.get('approval')` 探测（避免编译期依赖 dsh-user-approval；未注入时跳过） |
| 3 | **spawn 缺失不阻断图命令** | 修复 index.ts：角色注册失败仅告警，图命令/服务照常注册（实机验证关键） |
| 4 | **cond 边函数式路由** | 声明式 when 表达式在 CLI 层转 `evaluateCondition` 条件函数；引擎核心用函数式条件边 |
| 5 | **合并冲突即失败** | reject-on-conflict 严格生效（测试数据设计需避免非可合并字段多轮写入） |
| 6 | **mock 执行模式** | role 节点用 mock handler（异步延迟 + 固定产出），零 LLM，供可视化验收 |

## 五、与 MVP-1.5 预研的对应

| Phase F 结论 | MVP-2 落地 |
|---|---|
| FIX.4 模型路由可信 | T10 角色经 roleRef 引用（MVP-3 接子代理） |
| FIX.5 max_concurrent_children | T8 并发闸 `maxConcurrentChildren=8` 默认 |
| FIX.6 产物路径契约 | checkpoint store 注入式（root 由调用方提供，禁 cwd） |
| FIX.7 角色适配层 | T9 `SubagentNodeOptions.provider` 预留扩展点 |
| RES.1 llm usage | T13 Token 分账接口预留（node-end 事件携带） |
| RES.3 sendMessage | MVP-3 消息总线 API 已确认 |
| RES.4 热重载 | T20 hot-reload.spec.ts + 资源合规 |
| RES.5 无内置并发闸 | T8 引擎层全局闸 |
| RES.8 graphVersion | T5 checkpoint 版本感知恢复 |
| RES.10 引擎调研 | 8 项直接采用（增量补丁/熔断/checkpoint/审批门/边模型/事件/校验/服务形态） |

## 六、给 MVP-3 的输入

1. **addSubagent 接入**：role 节点接真实 `ctx.subagents.start`（T9 的 `SubagentNodeOptions` 已预留）
2. **消息总线**：`ctx.subagents.sendMessage`（RES.3 已确认）
3. **RunLedger**：checkpoint 演进为不可变审计账本（T5 的 7 字段为基础）
4. **Token 分账真实采集**：node-end 事件接 session `data.usage`（RES.1 已确认）
5. **并行分支**：`parallel` 边语法预留（T2 Schema），MVP-3 实现 Fan-out/Join
6. **dsh-turn-budget**：安装后激活 T16 配置段
7. **chain-runner 迁移**：heartbeat 改 ctx.effect（T17 合规登记）

## 七、交付物索引

| 类别 | 文件 |
|---|---|
| 引擎源码 | `src/l2-engine/`（types/graph-definition/static-validator/checkpoint/atomic-merge/condition-edge/concurrency-counter/state-graph/graph-service） |
| 可视化源码 | `src/l4-visual/host/`（event-bus/terminal-view/html-report/loop-detector） |
| 观察者源码 | `src/observers/`（observer-l1/signal） |
| CLI 源码 | `src/cli/`（graph-commands/graph-visual-commands） |
| 工作流样例 | `workflows/mvp2-loop-demo.yaml`、`workflows/visual-demo.yaml` |
| 测试 | `tests/`（23 文件，181 用例） |
| 合规报告 | `docs/MVP-2/资源合规检查.md` |
| 验收脚本 | `test-env/verify-mvp2.ps1` |
| HTML 报告样例 | `reports/graph-*.html` |

---
**关联**：`docs/MVP-2/0-详细设计.md`、`docs/MVP-2/1-DevTask.md`、`docs/MVP-1.5/process/*`、`docs/MVP-3/`（下一阶段）
