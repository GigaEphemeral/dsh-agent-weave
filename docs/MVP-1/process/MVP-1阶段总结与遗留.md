# MVP-1 阶段总结与遗留（交接文档）

> 版本：v1（2026-09-22）｜状态：**✅ 阶段完成，四项门禁全部通过**
> 用途：MVP-1 → MVP-2 交接；明确完成项、交付物、遗留坑

## 一、完成情况

### 1.1 任务清单（12 任务，全部完成）

| 任务 | 交付物 | 状态 |
|---|---|---|
| P1.1.0 Windows 环境验证 | `docs/env-verification.md` | ✅ |
| P1.1.1 插件脚手架 | `package.json` / `tsconfig*.json` / `tsdown.config.ts` / `cordis.patch.yml` / `src/index.ts` / `src/client/index.tsx` | ✅ |
| P1.1.2 L0-L5 目录骨架 | `src/{shared,l3-roles,l2-engine,l1-subagent,l4-visual,l5-observability,observers}` | ✅ |
| P1.1.3 共享类型定义 | `src/shared/types.ts`（RoleDefinition/RoleProfile/Zod Schema） | ✅ |
| P1.1.4 结构化日志 | `src/shared/logger.ts`（trace 贯穿 + 脱敏） | ✅ |
| P1.1.5 角色 YAML Schema | `src/l3-roles/role-schema.ts` | ✅ |
| P1.1.6 角色 Provider 编译器 | `src/l3-roles/role-loader.ts`（含路径逃逸防护） | ✅ |
| P1.1.7 Cordis 生命周期验证 | `tests/lifecycle/cordis-effect.spec.ts` | ✅ |
| P1.2.1 单链编排 | `src/l2-engine/{chain-runner,mvp1-chain,chain-tool}.ts` | ✅ |
| P1.2.2 记忆隔离验证 | `docs/MVP-1/验证报告-单链闭环.md` §门禁3 | ✅ |
| P1.2.3 toolFilter 验证 | 同上 §门禁3/四问 Q3 | ✅ |
| P1.2.4 端到端测试 | `docs/MVP-1/process/MVP-1测试记录-井字棋.md` | ✅ |

### 1.2 四项门禁（全部通过）

| # | 门禁 | 结果 | 证据 |
|---|---|---|---|
| 1 | 多角色顺序跑通真实小任务 | ✅ | 六阶段 completed，1,376s，产出 95K 字符 |
| 2 | 产物落盘 | ✅ | 6 产物含 58KB 可运行 `index.html` |
| 3 | 记忆隔离验证通过 | ✅ | 6 角色独立 session + `inherits_parent_context=false` |
| 4 | chat 中可见 workflow 节点 | ✅ | 用户实测观察节点树 + session `subagent/catalog` 事件 |

### 1.3 质量数据

| 指标 | 值 |
|---|---|
| 单元测试 | **56 个全绿**（6 个测试文件） |
| typecheck | `tsc --noEmit` 0 error（host + client） |
| 构建 | `lib/index.js` + `lib/client.js`，无 `.ts` 残留 |
| 真实端到端 | 一句话 → 六角色 → 可运行游戏（23 分钟 / 21.2 万 token） |

## 二、交付物索引

| 类别 | 文件 |
|---|---|
| 插件源码 | `src/**`（10 模块） |
| 角色资产 | `roles/*.yaml`（6 角色）、`skills/*/SKILL.md`（6 技能） |
| 测试 | `tests/**`（56 用例） |
| 发布包 | `dist/dsh-agent-weave-0.1.0.tgz` |
| 架构决策 | `docs/decisions/D-001-subagent-provider-contract.md` |
| 环境验证 | `docs/env-verification.md` |
| 验证报告 | `docs/MVP-1/验证报告-单链闭环.md` |
| **过程文档** | `docs/MVP-1/process/`：实现逻辑总览 / 隔离环境启动手册 / 自测逻辑说明 / 验证操作指南 / 链执行监控与停止 / 踩坑记录 / **MVP-1测试记录-井字棋** / 本文件 |
| 隔离环境 | `test-env/`（dsh-home + 10 个诊断脚本 + 日志，按规则保留） |

## 三、遗留坑（按优先级）

### 🔴 P1-坑1：角色 persona 与任务类型不匹配

**现象**：R1-R8 用的是 `1skillCode` 的 **TS 工程角色**（brainstormer / spec-owner / test-designer / ts-developer / qa / reviewer）。面对"纯 HTML 井字棋"这种轻量任务，R2 产出 8.8KB 架构文档、R4 产出 16.9KB 详细设计——**过度工程**。

**根因**：MVP-1 用固定角色链（R1→R8），没有"按任务类型选角色/裁剪深度"的机制。

**影响**：简单任务评估阶段偏慢偏重（R2 207s + R4 394s）。

**建议**：MVP-2 图编排时引入「任务类型 → 角色集/深度」映射；或增加轻量角色变体。

### 🔴 P1-坑2：产物路径依赖 `process.cwd()`

**现象**：产物落在 **DSH 启动目录**（`D:\...\softwareEngnieering\productions\`），而非用户会话工作区（用户在 web 里选的是「测试工作区」）。

**根因**：`chain-runner` 用 `process.cwd()` 作产物根，未取会话工作区路径。

**影响**：用户需到启动目录取产物，与 UI 里选的工作区不一致。

**建议**：MVP-2 从 `ctx`/agent 取会话 workspace 路径作为产物根（或用 `art://` 抽象）。

### 🟡 P2-坑3：STOP 仅阶段边界生效

**现象**：创建 `STOP` 后，正在执行的角色会跑完当前轮才停（R6 单阶段曾 650s）。

**根因**：`runChain` 只在阶段边界检查标志；未把 AbortSignal 传给子代理。

**建议**：MVP-3 引入中止信号传播（`run.cancel()`/AbortSignal）。

### 🟡 P2-坑4：无 token/时间上限

**现象**：单阶段耗时可能很长（R6 650s）；无熔断。

**根因**：MVP-1 设计明确不做熔断（属 MVP-3）。

**建议**：MVP-3 接入 `@deepseek-ai/dsh-agent-budget` + 迭代熔断。

### 🟢 P3-坑5：workflowEngine 未真正集成（D-001 偏离）

**现象**：门禁 4「chat 可见 workflow 节点」是通过 **subagent 事件**（`subagent/catalog`）实现的，不是 workflowEngine 的 `workflow/*` 事件。

**根因**：官方 `workflowEngine.agent()` 的 `provider` 是 LLM 路由，无法按角色切子代理 provider（见 D-001）。

**影响**：若 MVP-2/4 期望 UI 显示"workflow 节点"，需确认走 subagent 节点树还是自研 StateGraph 事件。

**建议**：MVP-2 自研 StateGraph 后，用自己的事件流（对齐 OTel）供 UI 消费。

### 🟢 P3-坑6：模型路由配置易错

**现象**：`llm-pi-ai` 用**模型 ID**（`DeepSeek-V4-Flash`）做解析键，写成 name（`deepseek-v4-flash`）会 `UNKNOWN_MODEL`。

**建议**：角色 YAML 增加启动期校验（对照 settings 的 provider/model 可用性）；或文档固化。

### 🟢 P3-坑7：工具名必须符合 provider 规范

**现象**：`weave:run-chain` 含冒号被火山端点拒（400）；mock 环境不校验，故仅真实环境暴露。

**建议**：工具名统一 `snake_case`；把「provider 字段规范」纳入自测清单。

## 四、经验教训（可复用）

1. **mock 通过 ≠ 真实通过**：mock LLM 不校验函数名/schema 形状，真实端点会拒。凡"传给 provider 的字段"都要按规范校验。
2. **给模型的工具权限 = 给它的探索空间**：给了 `pwsh`，角色就会去勘察环境。**最小权限**既安全又省 token（输入 token 降 50%）。
3. **prompt 里不能硬编码技术栈**：写"TypeScript"就会把 HTML 任务带偏。应写"按上游设计的技术选型"。
4. **可观测性必须给用户**：AI 监看既慢又贵；把执行细节落盘为日志（+ 心跳 + 停止标志）让用户自助。
5. **慢模型需要单轮化设计**：多轮工具往返对慢模型是灾难；prompt 约束"单轮直接产出"。
6. **会话落盘时机**：DSH 在 turn 完成后才写 session；执行中 session 不增长 ≠ 卡死，要看 CPU/心跳。

## 五、给 MVP-2 的输入

| MVP-1 产出 | MVP-2 用法 |
|---|---|
| `compileRoleToProvider`（包装 provider） | StateGraph 节点通过 `roleRef` 引用已注册角色 |
| `RoleDefinitionSchema` | 图 DSL 的 `roleRef` 校验 |
| `chain-runner` 编排逻辑 | 演进为 StateGraph 引擎（加条件边/循环/checkpoint） |
| `chain.log` 可观测模式 | 演进为 RunLedger 事件流（对齐 OTel） |
| 记忆隔离验证结论 | 节点执行继续复用 `inheritsParentContext=false` |
| 踩坑记录（6 条） | 设计期规避 |

## 六、环境状态（交接）

| 项 | 状态 |
|---|---|
| 隔离 DSH_HOME | `test-env/dsh-home`（保留，含 `weave-test` / `weave-headless` profile） |
| 隔离 web | 曾运行于 `:3081`（当前可能已停；重启见启动手册） |
| 真实 LLM 配置 | `settings.yaml` 指向火山端点（key 走 `HUOSHAN_186_API_KEY` 环境变量） |
| 测试产物 | `productions/`（6 产物 + chain.log）**保留** |
| 监控脚本 | `test-env/{watch,stop,resume}-chain.ps1` |

---
**关联**：`docs/MVP-1/验证报告-单链闭环.md`、`docs/MVP-1/process/*`、`docs/decisions/D-001-subagent-provider-contract.md`
