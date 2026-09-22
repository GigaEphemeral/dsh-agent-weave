# Phase F：修复与预研 · 完整任务拆解（Harness 可执行版）

> 版本：v1（2026-09-22）｜基线：**DSH 0.1.5-rc.2 + Windows 11 + Node 24**
> 交付对象：**Harness（AI 编码执行器）**
> 前置：MVP-1 已完成
> 范围：**FIX 5 项 + RES 6 项 = 11 个任务，~9.6d，约 2 周**
> 原则：**每个任务自包含、可独立执行、可验证、有明确交付物**


## 〇、给 Harness 的全局约束

### 0.1 环境基线

| 项 | 值 |
|---|---|
| DSH | 0.1.5-rc.2 |
| dsh bin 路径 | `%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js` |
| 隔离 DSH_HOME | `3pluginCode/test-env/dsh-home` |
| 项目路径 | `D:\dsharness\agentDev\softwareEngnieering` |
| PowerShell | 5.1（无 pwsh 7） |
| 编码 | 脚本 UTF-8 with BOM；读日志用 `-Encoding UTF8` |

### 0.2 硬性约束

| # | 约束 | 说明 |
|---|---|---|
| 1 | **不动主环境** | 所有操作在 `test-env/dsh-home` 隔离环境执行，主环境 `D:\dsharness\data` 零写入 |
| 2 | **测试数据保留** | `test-env/` 与 `productions/` 默认不清理，用户确认后才允许 |
| 3 | **日志结构化** | 所有输出走结构化日志，禁止字符串拼接 |
| 4 | **失败即暴露** | 禁止静默吞错；验证失败必须抛错并记录 |
| 5 | **预研报告归档** | 所有 RES 任务的报告写入 `docs/phase-f/` |


## 一、任务总览（11 项）

### FIX 系列（5 项，3.6d）

| 任务 ID | 任务名称 | 交付物 | 预估 | 依赖 |
|---|---|---|---|---|
| **FIX.3** | 标注门禁 4 的实现偏离 | `docs/MVP-1/MVP-1阶段总结与遗留.md` 更新 | 0.5d | 无 |
| **FIX.4** | 验证 `agentRouteDefaults` 生效 | 验证脚本 + 报告 | 1d | 无 |
| **FIX.5** | 验证 `max_concurrent_children` 映射 | 单元测试 + 报告 | 0.5d | 无 |
| **FIX.6** | 产物路径约束升级为契约级 | `04-MVP与设计契约.md` 更新 | 0.5d | 无 |
| **FIX.7** | 角色 persona 根因分析升级为 MVP-2 设计输入 | `docs/MVP-1/MVP-1阶段总结与遗留.md` 更新 | 0.5d | 无 |

### RES 系列（6 项，6d）

| 任务 ID | 任务名称 | 交付物 | 预估 | 依赖 |
|---|---|---|---|---|
| **RES.10** | `dsh-state-graph` / `dsh-agent-graph` 设计逻辑调研 | `docs/phase-f/RES.10-引擎设计调研.md` | 1.5d | 无 |
| **RES.3** | 跨版本 API 复测 | `docs/phase-f/RES.3-API复测.md` | 0.5d | 无 |
| **RES.4** | Cordis 热重载竞态复现 | `docs/phase-f/RES.4-热重载竞态.md` | 1d | 无 |
| **RES.5** | subagent 并发上限实测 | `docs/phase-f/RES.5-并发上限.md` | 1d | 无 |
| **RES.1** | `ctx.llm` usage 字段探测 | `docs/phase-f/RES.1-llm-usage.md` | 0.5d | 无 |
| **RES.8** | 图版本迁移参考调研 | `docs/phase-f/RES.8-图版本迁移.md` | 1d | 无 |

**总周期**：约 2 周（含并行）。


## 二、FIX 系列任务详细拆解

### FIX.3 标注门禁 4 的实现偏离

**目标**：在阶段总结中补充门禁 4 通过 subagent 事件而非 workflowEngine 事件的说明，明确 MVP-2 的 UI 节点树应消费自研 `graph/*` 事件。

**背景**：MVP-1 门禁 4「chat 中可见 workflow 节点」实际是通过 `subagent/catalog` 事件实现的，不是 workflowEngine 的 `workflow/*` 事件。但阶段总结中标注为 ✅ 未标注偏离，导致 MVP-2 的事件流设计不明。

**交付物**：更新 `docs/MVP-1/MVP-1阶段总结与遗留.md`

**操作步骤**：

1. 定位门禁 4 的描述段
2. 在「通过标准」中补充说明：

```
【实现偏离说明】
门禁 4 实际通过 subagent 事件（subagent/catalog）实现，而非 workflowEngine 的
workflow/* 事件。原因：官方 workflowEngine.agent() 的 provider 是 LLM 路由覆盖，
无法按角色切子代理 provider（见 D-001）。

【MVP-2 影响】
MVP-2 的 UI 节点树应消费自研 `graph/*` 事件，不再依赖 subagent 事件。
`graph/*` 事件类型：node-start / node-end / node-error / edge-traversed /
loop-iteration / checkpoint-written。
```

3. 在「给 MVP-2 的输入」表中，将「事件流归属」列为一独立行

**验收标准**：
- [ ] 门禁 4 描述中包含「实现偏离说明」段
- [ ] 明确标注「通过 subagent 事件实现」
- [ ] 明确 MVP-2 的 `graph/*` 事件流归属

**预估**：0.5d


### FIX.4 验证 `agentRouteDefaults` 生效

**目标**：写验证脚本检查 6 个子代理 session 的 model 字段是否等于角色 YAML 指定，确认 🐛 Discussion #4311/#4313 的规避有效。

**背景**：MVP-1 文档说「角色 provider `start()` 注入角色字段」，但无证据表明 `agentRouteDefaults` 真的生效。子代理可能继承了主 Agent 的模型而非角色 YAML 指定的。这是 🐛 规避依赖，必须验证。

**交付物**：
- `test-env/verify-agent-route.mjs`（验证脚本）
- `docs/phase-f/FIX.4-agentRouteDefaults验证.md`（验证报告）

**操作步骤**：

**Step 1：编写验证脚本**

`test-env/verify-agent-route.mjs`：

```javascript
#!/usr/bin/env node
/**
 * FIX.4 验证脚本：检查子代理 session 的 model 字段
 * 是否等于角色 YAML 中指定的 model.model
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DSH_HOME = process.env.DSH_HOME;
if (!DSH_HOME) {
  console.error('❌ 未设置 DSH_HOME');
  process.exit(1);
}

const sessionsDir = join(DSH_HOME, 'sessions');
if (!existsSync(sessionsDir)) {
  console.error(`❌ sessions 目录不存在: ${sessionsDir}`);
  process.exit(1);
}

// 1. 读取所有角色 YAML，建立 roleId → model 映射
const rolesDir = resolve(__dirname, '../roles');
const roleModelMap = new Map();
for (const file of readdirSync(rolesDir).filter(f => f.endsWith('.yaml'))) {
  const content = readFileSync(join(rolesDir, file), 'utf-8');
  const idMatch = content.match(/^id:\s*(.+)$/m);
  const providerMatch = content.match(/provider:\s*(.+)$/m);
  const modelMatch = content.match(/model:\s*(.+)$/m);
  if (idMatch && providerMatch && modelMatch) {
    roleModelMap.set(idMatch[1].trim(), {
      provider: providerMatch[1].trim(),
      model: modelMatch[1].trim(),
    });
  }
}

console.log(`📋 已加载 ${roleModelMap.size} 个角色定义：`);
for (const [id, m] of roleModelMap) {
  console.log(`   ${id}: ${m.provider} / ${m.model}`);
}

// 2. 扫描所有 session 文件，提取 model 字段
let checked = 0;
let passed = 0;
let failed = 0;
const failures = [];

for (const sessionFile of readdirSync(sessionsDir)) {
  if (!sessionFile.endsWith('.json') && !sessionFile.endsWith('.jsonl')) continue;

  const content = readFileSync(join(sessionsDir, sessionFile), 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      // 提取 provider/model 字段（subagent/descriptor 或 agent/start 事件）
      const provider = event.provider ?? event.agentOptions?.provider;
      const model = event.model ?? event.agentOptions?.model;
      const roleId = event.roleId ?? event.agentName;

      if (!provider || !model || !roleId) continue;

      checked++;
      const expected = roleModelMap.get(roleId);
      if (!expected) continue;

      if (provider === expected.provider && model === expected.model) {
        passed++;
        console.log(`✅ ${roleId}: ${provider} / ${model}`);
      } else {
        failed++;
        const msg = `${roleId}: 期望 ${expected.provider}/${expected.model}，实际 ${provider}/${model}`;
        failures.push(msg);
        console.error(`❌ ${msg}`);
      }
    } catch {
      // 忽略非 JSON 行
    }
  }
}

console.log('\n═══════════════════════════════════════');
console.log(`📊 检查结果：`);
console.log(`   检查数：${checked}`);
console.log(`   通过数：${passed}`);
console.log(`   失败数：${failed}`);
console.log('═══════════════════════════════════════');

if (failed > 0) {
  console.error('\n❌ 验证失败：');
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}

if (checked === 0) {
  console.warn('⚠️ 未找到任何子代理 session 的 model 字段，请先跑一次真实链');
  process.exit(2);
}

console.log('\n✅ FIX.4 验证通过：所有子代理 model 与角色 YAML 一致');
```

**Step 2：跑一次真实链（如果已有 session 可跳过）**

```powershell
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'
$env:HUOSHAN_186_API_KEY = '<从主环境读取>'
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile weave-headless `
  "请调用 weave_run_chain 工具，user_input 为 '做一个计算器'"
```

**Step 3：运行验证脚本**

```powershell
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'
node test-env/verify-agent-route.mjs
```

**Step 4：写验证报告**

`docs/phase-f/FIX.4-agentRouteDefaults验证.md`，包含：
- 验证脚本路径
- 运行命令
- 输出结果（检查数/通过数/失败数）
- 6 个子代理的 roleId → provider/model 映射表
- 结论：规避有效 / 规避无效

**验收标准**：
- [ ] 验证脚本能运行
- [ ] 6 个子代理 session 的 model 字段全部等于角色 YAML 指定
- [ ] 验证报告归档到 `docs/phase-f/`
- [ ] 若验证失败，必须记录实际 model 值并标注为 🐛 规避失败

**预估**：1d｜**阻塞 MVP-2**：✅ 是


### FIX.5 验证 `max_concurrent_children` 映射

**目标**：补单元测试验证 `compileRoleToProvider` 输出的 `depthLimit` 等于角色 YAML 的 `max_concurrent_children`。

**背景**：MVP-2 引入并行分支时，`max_concurrent_children` 是防广度爆炸的第一道闸门。如果映射不生效，MVP-2 发现时会很难定位。

**交付物**：
- `tests/unit/role-loader.concurrency.spec.ts`（新增单测）
- `docs/phase-f/FIX.5-max_concurrent_children验证.md`（验证报告）

**操作步骤**：

**Step 1：编写单元测试**

`tests/unit/role-loader.concurrency.spec.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { compileRoleToProvider } from '../../src/l3-roles/role-loader.js';
import type { RoleDefinition } from '../../src/shared/types.js';

describe('FIX.5 max_concurrent_children 映射', () => {
  const baseRole: RoleDefinition = {
    schema_version: '1.0',
    id: 'test-role',
    name: '测试角色',
    system_prompt_ref: 'test.md',
    traits: [],
    capabilities: [],
    tools: [],
    model: { provider: 'test-provider', model: 'test-model' },
    memory_scope: 'private',
    lifecycle: 'on-demand',
    max_concurrent_children: 8,
    quality_gate: [],
    token_budget: 10000,
    handoff: { upstream: [], downstream: [], edge_type: 'seq' },
  };

  it('depthLimit 应等于 max_concurrent_children', () => {
    const provider = compileRoleToProvider(baseRole, {
      skillsDir: '/tmp/skills',
      // 需要 mock skill 文件读取
      skillContent: 'test persona',
    } as never);

    expect(provider.capabilities.depthLimit).toBe(8);
  });

  it('max_concurrent_children 为 1 时正确映射', () => {
    const role = { ...baseRole, max_concurrent_children: 1 };
    const provider = compileRoleToProvider(role, {
      skillsDir: '/tmp/skills',
      skillContent: 'test persona',
    } as never);

    expect(provider.capabilities.depthLimit).toBe(1);
  });

  it('max_concurrent_children 为 100 时正确映射', () => {
    const role = { ...baseRole, max_concurrent_children: 100 };
    const provider = compileRoleToProvider(role, {
      skillsDir: '/tmp/skills',
      skillContent: 'test persona',
    } as never);

    expect(provider.capabilities.depthLimit).toBe(100);
  });
});
```

> **注**：若 `compileRoleToProvider` 当前签名不支持 `skillContent` 注入，需要先重构为可注入的接口，或改为通过临时文件系统读取。

**Step 2：运行测试**

```powershell
cd 3pluginCode
pnpm test tests/unit/role-loader.concurrency.spec.ts
```

**Step 3：写验证报告**

`docs/phase-f/FIX.5-max_concurrent_children验证.md`，包含：
- 测试文件路径
- 测试结果（通过/失败）
- 3 个用例的输入输出
- 结论：映射生效 / 未生效

**验收标准**：
- [ ] 单元测试覆盖 3 个用例
- [ ] `depthLimit` === `max_concurrent_children`
- [ ] 测试通过
- [ ] 若映射未生效，必须记录实际值

**预估**：0.5d｜**阻塞 MVP-2**：⚠️ 影响并发设计


### FIX.6 产物路径约束升级为契约级

**目标**：在 checkpoint 契约中强制 `graphId` 和产物根路径从 `ctx` 获取，禁止 `process.cwd()`。

**背景**：MVP-1 的产物路径依赖 `process.cwd()`，落在 DSH 启动目录而非用户会话工作区。这违反 G3 可恢复要求，MVP-3 的 `art://` 引用会读不到产物。

**交付物**：更新 `docs/04-MVP与设计契约.md`

**操作步骤**：

**Step 1：在 checkpoint 契约中增加约束**

在 `04-MVP与设计契约.md` 的 `§4.2 checkpoint 契约` 中增加：

```markdown
**产物路径约束（FIX.6，MVP-2 强制）**：

- `graphId` 和产物根路径**必须**从 `ctx`（会话工作区）获取，**禁止**使用 `process.cwd()`
- `graphId` 由引擎生成（格式：`graph-{timestamp}-{random}`）
- 产物根路径从 `ctx.workspace` 或 `ctx.session.workspace` 获取（具体 API 待 RES.3 确认）
- 所有 `art://` 引用基于产物根路径解析
- 单元测试必须覆盖：不同会话工作区下，产物落盘到正确路径

**为什么是契约级约束**：
- `process.cwd()` 返回 DSH 进程启动目录，与用户会话工作区无关
- checkpoint 恢复时若路径错误，会读不到产物
- MVP-3 的 `art://` 引用依赖此约束
```

**Step 2：在 MVP-2 任务中引用此约束**

在 `MVP-2 任务拆解` 的 T4（checkpoint 契约）中增加：

```markdown
**前置约束**：FIX.6 的产物路径约束必须已写入 `04-MVP与设计契约.md`。
```

**验收标准**：
- [ ] checkpoint 契约包含「产物路径约束」段
- [ ] 明确禁止 `process.cwd()`
- [ ] MVP-2 的 T4 引用此约束

**预估**：0.5d｜**阻塞 MVP-2**：✅ 是


### FIX.7 角色 persona 根因分析升级为 MVP-2 设计输入

**目标**：在阶段总结中明确「核心能力 + 任务适配层」分离方向。

**背景**：MVP-1 的井字棋任务暴露了「R2 产出 8.8KB 架构文档、R4 产出 16.9KB 详细设计」的过度工程问题。根因不是「角色选择」，而是「角色 Skill 的设计假设错误」——R1-R8 是为大型 TS 工程项目设计的。

**交付物**：更新 `docs/MVP-1/MVP-1阶段总结与遗留.md`

**操作步骤**：

**Step 1：升级 P1-坑1 为独立章节**

在「给 MVP-2 的输入」表中，将「角色 persona 根因」从一行扩展为独立章节：

```markdown
### 角色 Skill 设计方向（FIX.7）

**问题本质**：R1-R8 的 Skill 来自 `1skillCode`，是为**大型 TS 工程项目**设计的。
面对轻量任务（如井字棋），角色会产出大量「正确但无用」的文档。

**根因**：角色 Skill 缺少「任务类型适配层」。核心能力（如需求分析）与任务类型
（如轻量/标准/大型）耦合在同一个 Skill 文件中。

**MVP-2 设计输入**：
- 建议引入「核心能力层 + 任务适配层」分离
  - 核心能力层：该角色的不变职责（方法论、输出结构）
  - 任务适配层：按任务类型配置的深度、输出格式、工具集
- 示例（R4 设计师）：
  - CORE.md：详细设计方法论
  - adapters/lightweight.md：轻量任务（单文件、跳过 UML）
  - adapters/standard.md：标准任务（完整设计文档）
  - adapters/enterprise.md：企业级（含 DDD 建模）

**MVP-2 是否实现**：暂不实现（SKILL 系列延后），但 MVP-2 的 `roleRef`
设计必须预留「适配层」扩展点。
```

**Step 2：在 MVP-2 任务拆解中预留扩展点**

在 T8（StateGraph 引擎骨架）的 `addSubagent` 设计中增加：

```markdown
**扩展点预留**：`SubagentNodeOptions.provider` 字段未来可扩展为
`provider: string | { roleRef: string; adapter: string }`，支持角色适配层。
MVP-2 只实现 `string` 形式。
```

**验收标准**：
- [ ] 阶段总结包含「角色 Skill 设计方向」独立章节
- [ ] 明确「核心能力 + 任务适配层」分离方向
- [ ] MVP-2 的 T8 预留扩展点

**预估**：0.5d｜**阻塞 MVP-2**：⚠️ 影响角色设计


## 三、RES 系列任务详细拆解

### RES.10 `dsh-state-graph` / `dsh-agent-graph` 设计逻辑调研

**目标**：提炼两个参考项目的核心设计逻辑，为 MVP-2 的 StateGraph 引擎设计提供依据。

**交付物**：`docs/phase-f/RES.10-引擎设计调研.md`

**操作步骤**：

**Step 1：调研 `dsh-state-graph`**

从 GitHub 仓库 `zerosloney/dsh-state-graph` 阅读源码，提炼以下设计点：

| 调研点 | 需要回答的问题 |
|---|---|
| 声明式拓扑 | `addNode` / `addEdge` / `addConditionalEdge` 的签名和实现 |
| 纯函数增量补丁 | 节点返回 `Partial<State>` 后，引擎如何合并？ |
| 迭代熔断 | 默认值、触发时机、错误处理 |
| checkpoint 回调 | 签名、时机、宿主对接方式 |
| 审批门节点 | `addApprovalGate` 的实现 |
| 子代理节点 | `addSubagent` 如何委托给 `ctx.subagents.start` |
| `ctx.graph` 服务 | 如何注册到 Cordis |
| Fan-out/Fan-in | 条件路由返回数组时的处理 |

**Step 2：调研 `dsh-agent-graph`**

从 GitHub 仓库 `wrc093/dsh-agent-graph` 阅读源码，提炼以下设计点：

| 调研点 | 需要回答的问题 |
|---|---|
| bounded rework | 节点发现上游不足时如何返回？provided/declined/forwarded 的语义 |
| 结构化交接 | `summary` / `artifacts` / `openIssues` 的结构 |
| 分层全局账本 | README → index → node sections → details 的组织方式 |
| fail-fast | 首个节点失败时的行为 |
| 图文档验证 | 运行前校验哪些内容 |

**Step 3：写调研报告**

`docs/phase-f/RES.10-引擎设计调研.md`，包含：

```markdown
# RES.10 引擎设计调研

## 一、dsh-state-graph 设计逻辑

### 1.1 核心接口
（列出 NodeHandler / ConditionHandler / GraphExecutionResult 签名）

### 1.2 状态合并
（描述合并策略、冲突处理）

### 1.3 checkpoint 回调
（描述回调签名、时机、宿主对接）

### 1.4 子代理节点
（描述 addSubagent 如何委托给 ctx.subagents）

### 1.5 ctx.graph 服务注册
（描述注册方式）

## 二、dsh-agent-graph 设计逻辑

### 2.1 bounded rework 协议
（描述 provided/declined/forwarded 语义）

### 2.2 结构化交接
（描述 summary/artifacts/openIssues 结构）

### 2.3 分层全局账本
（描述组织方式）

### 2.4 fail-fast 行为
（描述首个节点失败时的行为）

## 三、对 MVP-2 的启示

（列出哪些设计可直接采用、哪些需调整、哪些留到 MVP-3）
```

**验收标准**：
- [ ] 报告覆盖 `dsh-state-graph` 的 8 个调研点
- [ ] 报告覆盖 `dsh-agent-graph` 的 5 个调研点
- [ ] 报告包含「对 MVP-2 的启示」章节
- [ ] 报告归档到 `docs/phase-f/`

**预估**：1.5d｜**阻塞 MVP-2**：✅ 是


### RES.3 跨版本 API 复测

**目标**：确认当前 DSH 版本的实际 API 名，避免 MVP-2/3 的消息总线设计基于错误的 API 名。

**背景**：MVP-1 采信 `sendMessage`，但评审报告曾出现 `followup` / `reportFrom`。需要复测确认。

**交付物**：`docs/phase-f/RES.3-API复测.md`

**操作步骤**：

**Step 1：确认版本**

```powershell
dsh --version
npm ls @deepseek-ai/dsh-subagent
```

**Step 2：检查类型定义**

定位 `@deepseek-ai/dsh-subagent` 的 `types.ts`：

```powershell
$subagentPkg = "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh-subagent"
Get-ChildItem $subagentPkg -Recurse -Filter "types.ts" | Select-Object FullName
```

检查以下类型：

| 类型 | 需要确认的内容 |
|---|---|
| `ContinuableStartSpec` | 字段列表 |
| `SubagentProvider` | 字段列表（`capabilities` / `inheritsParentContext` / `agentRouteDefaults`） |
| `SubagentRuntime` | 公开方法（`start` / `startContinuable` / `followup` / `sendMessage` / `reportFrom` / `interrupt`） |
| `SubagentStartRequest` | 字段列表（`persona` / `toolFilter` / `agentOptions` / `maxDepth`） |

**Step 3：运行时验证**

写一个最小脚本，调用 `ctx.subagents` 的每个疑似方法，验证哪些存在：

```javascript
// test-env/probe-subagent-api.mjs
const runtime = ctx.subagents;
const methods = ['start', 'startContinuable', 'followup', 'sendMessage', 'reportFrom', 'interrupt'];
for (const m of methods) {
  console.log(`${m}: ${typeof runtime[m]}`);
}
```

**Step 4：写复测报告**

`docs/phase-f/RES.3-API复测.md`，包含：

```markdown
# RES.3 跨版本 API 复测

## 一、版本信息
- DSH: <version>
- dsh-subagent: <version>

## 二、API 名确认

| 疑似 API 名 | 实际存在 | 签名 |
|---|---|---|
| start | ✅/❌ | ... |
| startContinuable | ✅/❌ | ... |
| followup | ✅/❌ | ... |
| sendMessage | ✅/❌ | ... |
| reportFrom | ✅/❌ | ... |
| interrupt | ✅/❌ | ... |

## 三、类型定义核对

### ContinuableStartSpec
（列出字段）

### SubagentProvider
（列出字段）

## 四、结论
（明确 MVP-2/3 应使用的 API 名）
```

**验收标准**：
- [ ] 报告包含版本信息
- [ ] 报告包含 6 个疑似 API 名的存在性确认
- [ ] 报告包含类型定义核对
- [ ] 报告明确 MVP-2/3 应使用的 API 名

**预估**：0.5d｜**阻塞 MVP-2**：✅ 是


### RES.4 Cordis 热重载竞态复现

**目标**：复现 Discussion #2854 的 HMR recompose 竞态，确认 `ctx.effect()` 的正确用法，形成资源生命周期检查清单。

**交付物**：
- `test-env/probe-hot-reload.mjs`（复现脚本）
- `docs/phase-f/RES.4-热重载竞态.md`（复现报告 + 检查清单）

**操作步骤**：

**Step 1：复现竞态**

写一个最小插件，注册非 effect 管理的资源（如裸 `setTimeout`），观察热重载后的行为：

```javascript
// test-env/probe-hot-reload.mjs
// 复现脚本：注册裸 setTimeout 和 ctx.effect 包装的 setTimeout，对比热重载后行为
```

**Step 2：确认 `ctx.effect()` 正确用法**

| 场景 | 错误写法 | 正确写法 |
|---|---|---|
| 定时器 | `setTimeout(fn, 1000)` | `ctx.effect(() => { const t = setTimeout(fn, 1000); return () => clearTimeout(t); })` |
| 文件句柄 | `fs.open(path, 'r', cb)` | `ctx.effect(() => { const fd = ...; return () => fs.close(fd); })` |
| watcher | `fs.watch(path, cb)` | `ctx.effect(() => { const w = fs.watch(path, cb); return () => w.close(); })` |

**Step 3：形成资源生命周期检查清单**

```markdown
## 资源生命周期检查清单（MVP-2 强制）

| # | 资源类型 | 检查项 | 通过标准 |
|---|---|---|---|
| 1 | 定时器 | 是否用 `ctx.effect()` 包装？ | 所有 `setTimeout` / `setInterval` 都在 effect 中 |
| 2 | 文件句柄 | 是否用 `ctx.effect()` 包装？ | 所有 `fs.open` 都在 effect 中 |
| 3 | 数据库连接 | 是否用 `ctx.effect()` 包装？ | 所有 `new Database()` 都在 effect 中 |
| 4 | watcher | 是否用 `ctx.effect()` 包装？ | 所有 `fs.watch` 都在 effect 中 |
| 5 | Cordis 一等服务 | 是否直接用？ | `ctx.storageDomain` / `ctx.subagents` 直接用 |
| 6 | LIFO 释放 | 多个 effect 是否按 LIFO 释放？ | 注册顺序逆序释放 |
| 7 | disposer 幂等 | disposer 是否可重复调用？ | 重复调用无副作用 |
```

**Step 4：写复现报告**

`docs/phase-f/RES.4-热重载竞态.md`，包含：
- Discussion #2854 的复现步骤
- 裸 `setTimeout` 热重载后的行为（泄漏 / 静默禁用）
- `ctx.effect()` 包装后的行为（正常清理）
- 资源生命周期检查清单

**验收标准**：
- [ ] 复现脚本可运行
- [ ] 报告包含 Discussion #2854 的复现结果
- [ ] 报告包含资源生命周期检查清单（7 项）
- [ ] 明确 MVP-2 的 checkpoint / 并发计数必须遵守此清单

**预估**：1d｜**阻塞 MVP-2**：✅ 是


### RES.5 subagent 并发上限实测

**目标**：复现 Discussion #131 的广度爆炸，确认无内置并发闸，形成 MVP-2 的多层防护依据。

**交付物**：
- `test-env/probe-concurrency.mjs`（实测脚本）
- `docs/phase-f/RES.5-并发上限.md`（实测报告）

**操作步骤**：

**Step 1：写实测脚本**

```javascript
// test-env/probe-concurrency.mjs
// 实测：连续 spawn N 个子代理，观察内存和 CPU
```

**Step 2：复现广度爆炸**

在隔离环境中连续 spawn 56 个子代理，观察：
- 进程内存峰值
- CPU 使用率
- web UI 响应性

**Step 3：确认无内置并发闸**

检查 `dsh-subagent` 源码，确认：
- `maxDepth` 只限深度（默认 3）
- 无 `maxConcurrentChildren` 或类似限制

**Step 4：验证社区插件防护效果**

- `dsh-plugin-product-subagents` 的 `maxConcurrentChildren`
- `dsh-turn-budget` 的 `maxToolCallsPerTurn`

**Step 5：写实测报告**

`docs/phase-f/RES.5-并发上限.md`，包含：

```markdown
# RES.5 subagent 并发上限实测

## 一、复现结果
- spawn 数量：56
- 内存峰值：2.2GB
- CPU：单核满载 20min
- UI：无响应

## 二、无内置并发闸确认
- maxDepth: 3（只限深度）
- maxConcurrentChildren: 不存在
- maxTotalAgents: 不存在

## 三、社区插件防护效果
| 插件 | 机制 | 效果 |
|---|---|---|
| dsh-plugin-product-subagents | maxConcurrentChildren | ... |
| dsh-turn-budget | maxToolCallsPerTurn | ... |

## 四、MVP-2 多层防护依据
| 层级 | 机制 | 来源 |
|---|---|---|
| Provider 层 | maxConcurrentChildren | dsh-plugin-product-subagents |
| 引擎层 | 全局活跃 child 计数 | 本项目自建 |
| Agent Loop 层 | maxToolCallsPerTurn | dsh-turn-budget |
| 进程层 | 无官方方案 | 结构性限制 |
```

**验收标准**：
- [ ] 实测脚本可运行
- [ ] 报告包含复现结果（内存/CPU/UI）
- [ ] 报告确认无内置并发闸
- [ ] 报告包含 MVP-2 多层防护依据

**预估**：1d｜**阻塞 MVP-2**：✅ 是


### RES.1 `ctx.llm` usage 字段探测

**目标**：确认 `ctx.llm` 是否返回 per-call usage，字段名和格式。

**交付物**：
- `test-env/probe-llm-usage.mjs`（探测脚本）
- `docs/phase-f/RES.1-llm-usage.md`（探测报告）

**操作步骤**：

**Step 1：写探测脚本**

```javascript
// test-env/probe-llm-usage.mjs
// 调用 ctx.llm.complete，打印完整返回对象
const result = await ctx.llm.complete('说"你好"', { maxTokens: 10 });
console.log(JSON.stringify(result, null, 2));
```

**Step 2：检查返回字段**

| 疑似字段 | 是否存在 | 格式 |
|---|---|---|
| `usage.input_tokens` | ? | ? |
| `usage.output_tokens` | ? | ? |
| `usage.total_tokens` | ? | ? |
| `usage.cache_read_tokens` | ? | ? |

**Step 3：写探测报告**

`docs/phase-f/RES.1-llm-usage.md`，包含：
- 探测脚本路径
- 完整返回对象
- usage 字段确认表
- 结论：Token 采集点在 provider 层 / 节点层

**验收标准**：
- [ ] 探测脚本可运行
- [ ] 报告包含完整返回对象
- [ ] 报告明确 usage 字段是否存在
- [ ] 报告明确 Token 采集点

**预估**：0.5d｜**阻塞 MVP-2**：✅ 是


### RES.8 图版本迁移参考调研

**目标**：调研 AgentGit / CVC，提炼 state commit/revert/branching 语义。

**交付物**：`docs/phase-f/RES.8-图版本迁移.md`

**操作步骤**：

**Step 1：调研 AgentGit**

从 `browse-export.arxiv.org` 或 GitHub 阅读 AgentGit 的设计，提炼：
- state commit 的语义
- revert 的语义
- branching 的语义

**Step 2：调研 CVC（Cognitive Version Control）**

从 PyPI 阅读 CVC 的设计，提炼：
- Merkle DAG 存储
- micro-rollbacks
- 不可变性

**Step 3：映射到 `graphVersion` 字段设计**

```markdown
## graphVersion 字段设计建议

### 语义
- `graphVersion` 是图 DSL 的版本号
- 每次图 DSL 变更（增删节点/边、改条件）生成新版本
- 旧版本保留可回滚

### 迁移策略
- 检查 checkpoint 中的 `graphVersion`
- 与当前图 DSL 的 `graphVersion` 比较
- 相同：直接恢复
- 不同：提示用户选择「继续旧版本」/「迁移到新版本」

### 参考 AgentGit / CVC
- commit: 保存当前图 DSL 快照
- revert: 回滚到指定版本
- branch: 从当前版本创建分支
```

**Step 4：写调研报告**

`docs/phase-f/RES.8-图版本迁移.md`

**验收标准**：
- [ ] 报告覆盖 AgentGit 的 3 个语义
- [ ] 报告覆盖 CVC 的 3 个设计点
- [ ] 报告包含 `graphVersion` 字段设计建议
- [ ] 报告归档到 `docs/phase-f/`

**预估**：1d｜**阻塞 MVP-2**：⚠️ 影响 checkpoint 契约


## 四、执行顺序与并行策略

### 4.1 执行顺序

```
第 1 周（FIX 系列 + RES.3 并行）：
  · FIX.3 标注门禁 4 偏离（0.5d）
  · FIX.4 验证 agentRouteDefaults（1d）🔴 关键
  · FIX.5 验证 max_concurrent_children（0.5d）
  · FIX.6 产物路径契约（0.5d）🔴 关键
  · FIX.7 角色 persona 根因（0.5d）
  · RES.3 跨版本 API 复测（0.5d，可并行）
  小计：3.5d（含并行）

第 2 周（RES 系列）：
  · RES.10 dsh-state-graph 调研（1.5d）🔴 关键
  · RES.4 Cordis 热重载竞态（1d）🔴 关键
  · RES.5 并发上限实测（1d）🔴 关键
  · RES.1 ctx.llm usage（0.5d）
  · RES.8 图版本迁移调研（1d）
  小计：5d
```

**总周期**：**约 2 周**（11 个任务，~8.5d）。

### 4.2 并行策略

| 可并行组 | 任务 | 理由 |
|---|---|---|
| **组 1** | FIX.3 / FIX.5 / FIX.6 / FIX.7 / RES.3 | 都是文档类或轻量验证，无依赖 |
| **组 2** | FIX.4 | 需要跑一次真实链，耗时较长，可独立进行 |
| **组 3** | RES.10 / RES.4 / RES.5 | 都是预研类，无依赖 |
| **组 4** | RES.1 / RES.8 | 轻量探测，可并行 |


## 五、Phase F 门禁（8 项）

| # | 门禁 | 验证方式 | 对应任务 |
|---|---|---|---|
| 1 | FIX 全部完成 | 文档一致性 + 验证脚本 | FIX.3-7 |
| 2 | FIX.4 `agentRouteDefaults` 验证通过 | 6 个子代理 session 的 model 字段全部正确 | FIX.4 |
| 3 | FIX.6 产物路径契约写入 | checkpoint 契约文档有此约束 | FIX.6 |
| 4 | RES.3 跨版本 API 确认 | 复测报告明确实际 API 名 | RES.3 |
| 5 | RES.4 Cordis 热重载竞态理解 | 复现报告 + 检查清单 | RES.4 |
| 6 | RES.5 并发上限实测 | 实测报告明确并发边界 | RES.5 |
| 7 | RES.10 引擎设计调研完成 | 调研报告提炼核心设计逻辑 | RES.10 |
| 8 | RES.1 `ctx.llm` usage 确认 | 探测报告明确是否返回 usage | RES.1 |


## 六、与 MVP-2 的衔接

| Phase F 产出 | MVP-2 如何使用 |
|---|---|
| FIX.4 `agentRouteDefaults` 验证 | 模型路由可信 |
| FIX.5 `max_concurrent_children` 验证 | 并发设计 |
| FIX.6 产物路径契约 | checkpoint 契约 |
| FIX.7 角色 persona 根因 | 角色 Skill 设计方向 |
| RES.1 `ctx.llm` usage | Token 采集点 |
| RES.3 跨版本 API | 消息总线设计 |
| RES.4 Cordis 热重载竞态 | 资源生命周期约束 |
| RES.5 并发上限 | 多层防护 |
| RES.8 图版本迁移 | checkpoint 契约 |
| RES.10 `dsh-state-graph` 调研 | 引擎设计 |


## 七、给 Harness 的执行指引

### 7.1 启动前检查

```powershell
# ① 确认 DSH 版本
dsh --version

# ② 确认隔离环境
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'
Test-Path $env:DSH_HOME

# ③ 确认主环境零写入
Get-Item 'D:\dsharness\data' | Select-Object LastWriteTime
```

### 7.2 每个任务的执行规范

1. **先读任务描述**，确认输入输出和验收标准
2. **检查依赖任务是否完成**，未完成不允许开始
3. **所有操作在隔离环境执行**，主环境零写入
4. **预研报告归档到 `docs/phase-f/`**
5. **验证脚本归档到 `test-env/`**
6. **完成后更新 Phase F 进度记录**

### 7.3 遇到问题时的处理

| 问题 | 处理 |
|---|---|
| 隔离环境不存在 | 参照 `docs/MVP-1/process/隔离环境启动手册.md` 重建 |
| 真实链无法跑通 | 用 mock LLM 模式（见隔离环境启动手册 §2.1） |
| 探测脚本报错 | 检查 `ctx` 是否可用，可能需要通过插件入口注入 |
| 报告格式不确定 | 参考 `docs/MVP-1/验证报告-单链闭环.md` 的格式 |


## 八、交付物清单

| 任务 | 交付物 | 验收 |
|---|---|---|
| FIX.3 | `docs/MVP-1/MVP-1阶段总结与遗留.md` 更新 | 含偏离说明 |
| FIX.4 | `test-env/verify-agent-route.mjs` + `docs/phase-f/FIX.4-agentRouteDefaults验证.md` | 6 个子代理 model 正确 |
| FIX.5 | `tests/unit/role-loader.concurrency.spec.ts` + `docs/phase-f/FIX.5-max_concurrent_children验证.md` | 3 用例通过 |
| FIX.6 | `docs/04-MVP与设计契约.md` 更新 | 含产物路径约束 |
| FIX.7 | `docs/MVP-1/MVP-1阶段总结与遗留.md` 更新 | 含角色 Skill 设计方向 |
| RES.10 | `docs/phase-f/RES.10-引擎设计调研.md` | 覆盖 13 个调研点 |
| RES.3 | `docs/phase-f/RES.3-API复测.md` | 明确 6 个 API 名 |
| RES.4 | `test-env/probe-hot-reload.mjs` + `docs/phase-f/RES.4-热重载竞态.md` | 含 7 项检查清单 |
| RES.5 | `test-env/probe-concurrency.mjs` + `docs/phase-f/RES.5-并发上限.md` | 含多层防护依据 |
| RES.1 | `test-env/probe-llm-usage.mjs` + `docs/phase-f/RES.1-llm-usage.md` | 明确 usage 字段 |
| RES.8 | `docs/phase-f/RES.8-图版本迁移.md` | 含 graphVersion 设计建议 |


**下一步**：Harness 从 FIX.3 开始执行（可与 RES.3 并行），每个任务完成后更新进度，遇到阻塞时按 §7.3 处理。Phase F 门禁 8 项全部通过后，启动 MVP-2。