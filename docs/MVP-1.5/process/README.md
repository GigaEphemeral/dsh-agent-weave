# MVP-1.5（Phase F）修复与预研阶段总结

> 版本：v1（2026-09-22）｜状态：**✅ 阶段完成**（FIX 5 项 + RES 6 项 = 11 项全部交付）
> 基线：DSH 0.1.5-rc.2 + Windows 11 + Node 22.23
> 用途：MVP-1 → MVP-2 之间的修复与预研阶段；门禁 8 项检查见 §四

## 一、任务完成总览

| 任务 | 类型 | 交付物 | 结论 | 状态 |
|---|---|---|---|---|
| **FIX.3** | 文档 | `MVP-1阶段总结与遗留.md` 门禁 4 偏离说明 + 事件流归属行 | 偏离已标注：门禁4 走 subagent 事件，MVP-2 用 `graph/*` 事件 | ✅ |
| **FIX.4** | 验证 | `test-env/verify-agent-route.mjs` + `FIX.4-agentRouteDefaults验证.md` | **规避有效**：6 角色子代理 model 与 YAML 一致，未继承主 model | ✅ |
| **FIX.5** | 验证 | `tests/l3-roles/role-loader.concurrency.spec.ts`（7 用例）+ `FIX.5-max_concurrent_children验证.md` | **映射生效**：depthLimit/maxDepth === max_concurrent_children | ✅ |
| **FIX.6** | 文档 | `04-MVP与设计契约.md` §4.2 产物路径约束 + `MVP-2/1-DevTask.md` T4 引用 | 契约级约束写入：禁 `process.cwd()`，从 `ctx` 取 | ✅ |
| **FIX.7** | 文档 | 阶段总结「角色 Skill 设计方向」章节 + `MVP-2/1-DevTask.md` T8 扩展点 | 核心能力层+任务适配层分离；`provider` 预留 adapter 扩展 | ✅ |
| **RES.1** | 探测 | `test-env/probe-llm-usage.mjs` + `RES.1-llm-usage.md` | **usage 存在**：`assistant/message.data.usage`（TokenUsage）；`complete` 不存在，用 `stream` | ✅ |
| **RES.3** | 复测 | `test-env/probe-subagent-api.mjs` + `RES.3-API复测.md` | **`sendMessage` 正确**；`followup`/`reportFrom` 不存在 | ✅ |
| **RES.4** | 复现 | `test-env/probe-hot-reload.mjs` + `RES.4-热重载竞态.md` | **复现成功**：裸资源泄漏 vs effect 清理；7 项检查清单 | ✅ |
| **RES.5** | 实测 | `test-env/probe-concurrency.mjs` + `RES.5-并发上限.md` | **无内置并发闸**；引擎层自建全局闸（多层防护） | ✅ |
| **RES.8** | 调研 | `RES.8-图版本迁移.md` | AgentGit commit/revert/branch + CVC Merkle DAG；graphVersion 建议 | ✅ |
| **RES.10** | 调研 | `RES.10-引擎设计调研.md` | dsh-state-graph（同构）+ dsh-agent-graph（编排层）；13 调研点全实锤 | ✅ |

## 二、执行策略（token 节约）

用户强调注意 token 消耗，本阶段采用三项节约策略：

1. **免跑真实链**：FIX.4（agentRouteDefaults）与 RES.1（llm usage）均利用
   `test-env/dsh-home` **已保留的历史 session 数据**（zstd 扫描）验证，
   **避免重跑 21 万 token 的真实链**。
2. **类型层优先**：RES.1/RES.3 先读 `node_modules` 类型定义（零消耗），
   运行时用轻量探测脚本（类原型检查 / session 扫描）交叉验证，全程零 LLM 调用。
3. **调研外包**：RES.8/RES.10 两个纯 web 调研（AgentGit/CVC、两个 GitHub 仓库源码）
   交给后台 subagent 隔离执行，避免占用主上下文。

**结果**：全部 11 项任务零新增 LLM 调用（验证均基于已有数据/类型/源码）。

## 三、关键发现与修正

| # | 发现 | 影响 |
|---|---|---|
| 1 | 任务草案 `ctx.llm.complete()` **不存在**，正确 API 是 `ctx.llm.stream()` | RES.1 报告已修正 |
| 2 | 任务草案 `capabilities.depthLimit` 断言数字是**错的**（布尔标志），数字走 `start()` 的 `maxDepth` | FIX.5 按真实契约重设计（7 用例） |
| 3 | `sendMessage` 采信正确，`followup`/`reportFrom` 是旧版本误记 | RES.3 报告明确 MVP-2/3 用 `sendMessage` |
| 4 | FIX.6 目标文档实际路径 `docs/探索/04-MVP与设计契约.md`（非任务写的 `docs/04-...`） | 已按实际路径更新 |
| 5 | 06:48 批（YAML=pro）主 session=flash、子代理=pro → 子代理未继承主 model 的铁证 | FIX.4 通过 |

## 四、Phase F 门禁检查（8 项）

| # | 门禁 | 验证方式 | 结果 |
|---|---|---|---|
| 1 | FIX 全部完成 | 文档一致性 + 验证脚本 | ✅ FIX.3-7 交付 |
| 2 | FIX.4 agentRouteDefaults 验证通过 | 6 子代理 session model 全部正确 | ✅ 命中 6/6 |
| 3 | FIX.6 产物路径契约写入 | checkpoint 契约文档有此约束 | ✅ §4.2 |
| 4 | RES.3 跨版本 API 确认 | 复测报告明确实际 API 名 | ✅ `sendMessage` |
| 5 | RES.4 热重载竞态理解 | 复现报告 + 检查清单 | ✅ 复现 + 7 项清单 |
| 6 | RES.5 并发上限实测 | 实测报告明确并发边界 | ✅ 无内置闸 |
| 7 | RES.10 引擎设计调研完成 | 调研报告提炼核心设计逻辑 | ✅ 13 调研点 |
| 8 | RES.1 ctx.llm usage 确认 | 探测报告明确是否返回 usage | ✅ TokenUsage 确认 |

**门禁 8 项全部通过 → MVP-2 可以启动。**

## 五、给 MVP-2 的输入汇总

| Phase F 产出 | MVP-2 如何使用 |
|---|---|
| FIX.4：模型路由可信 | StateGraph 节点通过 `roleRef` 复用角色，无需重复配置 model |
| FIX.5：depthLimit/maxDepth 映射 | 并发设计（注意 maxDepth 是深度非广度） |
| FIX.6：产物路径契约 | T4 checkpoint 契约前置约束（禁 process.cwd） |
| FIX.7：角色适配层方向 | T8 `provider` 字段预留 `{roleRef, adapter}` 扩展点 |
| RES.1：usage 字段 | Token 采集点在节点层（session data.usage → RunLedger） |
| RES.3：sendMessage 确认 | 消息总线用 `ctx.subagents.sendMessage(sender, targetId, content, options)` |
| RES.4：资源生命周期 | 7 项检查清单强制；热重载测试入门禁 |
| RES.5：无内置并发闸 | T8 引擎层全局并发闸（acquire/release + try/finally） |
| RES.8：graphVersion 设计 | T4 checkpoint 记录版本，恢复时比较（相同→恢复/不同→提示） |
| RES.10：引擎设计调研 | 8 项直接采用 + 2 项调整（loop 边语义）+ 5 项留 MVP-3 |

## 六、交付物索引

| 类别 | 文件 |
|---|---|
| 验证脚本 | `test-env/verify-agent-route.mjs`、`probe-subagent-api.mjs`、`probe-llm-usage.mjs`、`probe-hot-reload.mjs`、`probe-concurrency.mjs` |
| 单元测试 | `tests/l3-roles/role-loader.concurrency.spec.ts`（7 用例，全量 63 绿） |
| 预研报告 | `docs/MVP-1.5/process/`：FIX.4 / FIX.5 / RES.1 / RES.3 / RES.4 / RES.5 / RES.8 / RES.10 |
| 文档更新 | `docs/MVP-1/process/MVP-1阶段总结与遗留.md`（FIX.3/7）、`docs/探索/04-MVP与设计契约.md`（FIX.6）、`docs/MVP-2/1-DevTask.md`（T4/T8） |

---
**关联**：`docs/MVP-1.5/MVP-1修复&预研.md`（任务定义）、`docs/MVP-1/process/*`、`docs/MVP-2/0-详细设计.md`
