# MVP-1 详细开发计划与任务清单（Windows + DSH 0.1.15-rc2）

> 版本：v1（2026-09-22）｜环境：**Windows 11 + DSH 0.1.15-rc2 + Node 24**
> 依据：`00-开发计划.md` MVP-1 + `04-MVP与设计契约.md` + Windows 环境实测记录
> 目标：**验证角色能否作为 SubagentProvider 被正确编译、注册、执行、隔离**


## 一、环境适配说明（Windows + DSH 0.1.15-rc2）

### 1.1 环境基线

| 项 | 版本/值 | 说明 |
|---|---|---|
| OS | Windows 11 Pro | 本文档的 Windows 特例在此环境实测 |
| Node | **v24.18.1** 或 `^22.19` | DSH 要求 `^22.19.0 || >=24.0.0` |
| pnpm | **11.7.0** | 与 Node 版本必须匹配 |
| DSH | **0.1.15-rc2** | npm 全局安装 |
| Shell | PowerShell 5.1 / pwsh | Windows 上 DSH 使用 `pwsh` 工具而非 Bash |

### 1.2 Windows 特有限制

DSH 在 Windows 上有原生执行路径，但存在以下边界：

| 限制 | 说明 | 影响 MVP-1 的哪些任务 |
|---|---|---|
| **Bash 工具不可用** | Windows 上使用 PowerShell 替代 Bash | 不影响，MVP-1 不依赖 Bash 工具 |
| **无持久化 PTY** | 每次 `pwsh` 调用启动全新 Shell | 不影响，角色编译是同步操作 |
| **`workspace-write` / `read-only` 部分强制** | 读取和网络未完全限制 | 不影响，MVP-1 不涉及沙箱 |
| **Python SDK wheel 未发布 Windows 版** | 仅 Linux/macOS | 不影响，MVP-1 用 TypeScript |

### 1.3 Windows 路径处理要点

```powershell
# 插件路径转换：不要用眼睛重写路径，用 pathToFileURL
node -e "const {pathToFileURL}=require('node:url'); console.log(pathToFileURL('C:\path\to\plugin').href)"
```

**项目路径建议**：纯英文路径，避免中文路径问题。若需中文路径，使用 `dsh.ps1` 启动器。


## 二、任务清单总览（12 个任务）

| 任务 ID | 任务名称 | 交付物 | 预估 | 依赖 |
|---|---|---|---|---|
| **P1.1.0** | Windows 环境验证 | 环境验证报告 | 0.5d | 无 |
| **P1.1.1** | 插件脚手架搭建 | `package.json` + 构建配置 + `src/index.ts` | 0.5d | P1.1.0 |
| **P1.1.2** | L0-L5 目录骨架 | 目录结构 | 1d | P1.1.1 |
| **P1.1.3** | 共享类型定义 | `src/shared/types.ts` + Zod Schema | 1d | P1.1.2 |
| **P1.1.4** | 结构化日志基础设施 | `src/shared/logger.ts` | 1d | P1.1.2 |
| **P1.1.5** | 角色 YAML Schema | `src/l3-roles/role-schema.ts` | 1d | P1.1.3 |
| **P1.1.6** | 角色 Provider 编译器 | `src/l3-roles/role-loader.ts` 初版 | 2d | P1.1.5 |
| **P1.1.7** | Cordis 生命周期验证 | 最小 effect 注册/注销 + 热重载测试 | 0.5d | P1.1.1 |
| **P1.2.1** | workflowEngine 脚本 | 串行脚本 R1→R2→R4→R6→R7→R8 | 2d | P1.1.6 |
| **P1.2.2** | 记忆隔离验证 | 验证报告 | 0.5d | P1.2.1 |
| **P1.2.3** | toolFilter 验证 | 验证报告 | 0.5d | P1.2.1 |
| **P1.2.4** | 单链闭环端到端测试 | 测试脚本 + 运行记录 | 1d | P1.2.2, P1.2.3 |

**合计**：12 个任务，约 11 天，1.5 周（含并行）。


## 三、详细任务分解

### P1.1.0 Windows 环境验证

| 项 | 内容 |
|---|---|
| **目标** | 确认 DSH 0.1.15-rc2 在 Windows 上可正常运行，所有依赖工具就绪 |
| **交付物** | 环境验证报告（`docs/env-verification.md`） |
| **前置** | 无 |

**操作步骤**：

```powershell
# 1. 确认 DSH 版本
dsh --version
# 期望输出：0.1.15-rc2

# 2. 确认 Node 版本
node --version
# 期望输出：v24.x.x 或 v22.19+

# 3. 确认 pnpm 版本
pnpm --version
# 期望输出：11.x.x

# 4. 确认 DSH 安装路径
Get-Command dsh | Select-Object Source
# Windows 默认路径：C:\Users\<用户名>\.dsh\profiles\node_modules\@deepseek-ai\

# 5. 确认 web profile 可启动
dsh web --help
```

**验收标准**：
- [ ] `dsh --version` 输出 `0.1.15-rc2`
- [ ] `node --version` 满足 `^22.19.0 || >=24.0.0`
- [ ] `pnpm --version` 输出 `11.7.0` 或兼容版本
- [ ] `dsh web --help` 正常输出帮助信息


### P1.1.1 插件脚手架搭建

| 项 | 内容 |
|---|---|
| **目标** | 创建可安装的 DSH 插件骨架，双半端构建配置就绪 |
| **交付物** | `package.json` + `cordis.patch.yml` + `tsconfig.json` + `tsconfig.client.json` + `tsdown.config.ts` + `src/index.ts` + `src/client/index.tsx` |
| **前置** | P1.1.0 |
| **预估** | 0.5d |

**关键文件内容**：

**`package.json`**（双声明）：

```json
{
  "name": "dsh-agent-weave",
  "version": "0.1.0",
  "type": "module",
  "dsh": {
    "bundle": "./lib/index.js",
    "client": "./lib/client.js"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.0",
    "@deepseek-ai/dsh-subagent": "^0.0.1-rc.1"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "tsdown": "^0.22.0",
    "vitest": "^3.x",
    "zod": "^3.x"
  },
  "scripts": {
    "build": "tsc -b tsconfig.json && tsdown",
    "build:client": "tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client",
    "clean": "rm -rf lib tsconfig.tsbuildinfo"
  }
}
```

**`tsdown.config.ts`**（双产物配置，Windows 适配）：

```typescript
export default {
  name: 'dsh-agent-weave/client',
  entry: { client: 'lib/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (id) => CLIENT_EXTERNALS.includes(id),
    alwaysBundle: (id) => !CLIENT_EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-agent-weave", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
};
```

**Windows 特有注意事项**：
- Client 半入口必须是 `.tsx` 文件才能写 JSX，写成 `.ts` 会得到 `TS1005 '>' expected`
- 构建顺序：`clean → tsc host → tsdown host → tsc client → tsdown client`
- 避免使用 `npx` 临时安装，改用全局安装的 `dsh` 命令

**验收标准**：
- [ ] `pnpm build` 产出 `lib/index.js` + `lib/client.js`
- [ ] `dsh plugin --profile web add ./dsh-agent-weave` 能安装
- [ ] `dsh web` 启动后插件出现在插件列表


### P1.1.2 L0-L5 目录骨架

| 项 | 内容 |
|---|---|
| **目标** | 按全局架构基线创建目录结构，后续只填充实现不重构 |
| **交付物** | 完整目录结构 + 空 `apply` 函数 + 空 Client 插件 |
| **前置** | P1.1.1 |
| **预估** | 1d |

**目录结构**（MVP-1 只激活标注 ★ 的模块）：

```
src/
├── index.ts                    ★ Host 插件入口
├── client/
│   └── index.tsx               ★ Client 空壳（占位）
├── shared/
│   ├── types.ts                ★ 共享类型
│   ├── logger.ts               ★ 结构化日志
│   └── errors.ts               ★ 错误类型
├── l3-roles/
│   ├── role-schema.ts          ★ 角色 YAML Schema
│   └── role-loader.ts          ★ 角色 Provider 编译器
├── l1-subagent/                （占位）
├── l2-engine/                  （占位）
├── l4-visual/                  （占位）
├── l5-observability/           （占位）
└── observers/                  （占位）
```

**Host 入口骨架**（`src/index.ts`）：

```typescript
import type { Context } from '@deepseek-ai/cordis';

export const name = 'dsh-agent-weave';
export const inject = ['subagents', 'skills'];

export interface Config {
  rolesDir?: string;
  skillsDir?: string;
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.logger.info('weave', '插件已加载', { rolesDir: config.rolesDir });
}
```

**Client 入口骨架**（`src/client/index.tsx`）：

```tsx
import type { Context } from '@deepseek-ai/cordis';

export const name = 'dsh-agent-weave-client';

export function apply(ctx: Context): void {
  // MVP-1 空壳，MVP-4 实现
}
```

**验收标准**：
- [ ] 所有目录存在
- [ ] `src/index.ts` 导出空 `apply`；`src/client/index.tsx` 导出空 client 插件
- [ ] `pnpm build` 通过，产出 `lib/index.js` + `lib/client.js`


### P1.1.3 共享类型定义

| 项 | 内容 |
|---|---|
| **目标** | 定义核心 TypeScript 类型 + Zod Schema |
| **交付物** | `src/shared/types.ts` + Zod Schema |
| **前置** | P1.1.2 |
| **预估** | 1d |

**核心类型**：

```typescript
import { z } from 'zod';

export interface RoleDefinition {
  schema_version: string;
  id: string;
  name: string;
  system_prompt_ref: string;
  traits: string[];
  capabilities: string[];
  tools: string[];
  model: { provider: string; model: string };
  memory_scope: 'private' | 'shared';
  lifecycle: 'resident' | 'on-demand' | 'hybrid';
  max_concurrent_children: number;
  quality_gate: string[];
  token_budget: number;
  handoff: {
    upstream: string[];
    downstream: string[];
    edge_type: 'seq' | 'cond';
  };
  observers?: ObserverConfig[];
}

export interface SubagentProvider {
  name: string;
  capabilities: {
    persona: string;
    toolFilter: string[];
    agentOptions: { provider: string; model: string };
    outputSchema?: unknown;
    depthLimit?: number;
  };
  inheritsParentContext: boolean;
}

export const RoleDefinitionSchema = z.object({
  schema_version: z.literal('1.0'),
  id: z.string().min(1),
  name: z.string().min(1),
  system_prompt_ref: z.string().min(1),
  traits: z.array(z.string()),
  capabilities: z.array(z.string()),
  tools: z.array(z.string()),
  model: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }),
  memory_scope: z.enum(['private', 'shared']),
  lifecycle: z.enum(['resident', 'on-demand', 'hybrid']),
  max_concurrent_children: z.number().int().positive(),
  quality_gate: z.array(z.string()),
  token_budget: z.number().int().positive(),
  handoff: z.object({
    upstream: z.array(z.string()),
    downstream: z.array(z.string()),
    edge_type: z.enum(['seq', 'cond']),
  }),
  observers: z.array(ObserverConfigSchema).optional(),
});
```

**验收标准**：
- [ ] 类型定义完整，`pnpm tsc --noEmit` 无错误
- [ ] Zod Schema 校验通过示例 YAML，拒绝非法 YAML
- [ ] 边界条件：`schema_version` 必须为 `"1.0"`；`model.provider` 和 `model.model` 都必须显式指定


### P1.1.4 结构化日志基础设施

| 项 | 内容 |
|---|---|
| **目标** | 实现结构化日志 + AsyncLocalStorage 关联 + 脱敏工具 |
| **交付物** | `src/shared/logger.ts` |
| **前置** | P1.1.2 |
| **预估** | 1d |

**核心接口**：

```typescript
interface LogEntry {
  ts: number;
  level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  component: string;
  msg: string;
  trace_id?: string;
  node_id?: string;
  role_id?: string;
  error?: { name: string; message: string; stack?: string };
  data?: Record<string, unknown>;
}

export function withTrace<T>(
  ctx: { trace_id: string; node_id?: string },
  fn: () => T,
): T;

export function truncate(s: string, max?: number): string;
export function ref(path: string): string;
export function fingerprint(s: string): string;
```

**验收标准**：
- [ ] LogEntry 接口完整
- [ ] `trace_id` 通过 AsyncLocalStorage 贯穿
- [ ] 脱敏工具（truncate/ref/fingerprint）可用
- [ ] 禁止记录完整 prompt、凭证、PII


### P1.1.5 角色 YAML Schema

| 项 | 内容 |
|---|---|
| **目标** | 定义角色 YAML 的 Zod Schema |
| **交付物** | `src/l3-roles/role-schema.ts` |
| **前置** | P1.1.3 |
| **预估** | 1d |

**验收标准**：
- [ ] 含 `schema_version` / `system_prompt_ref` / `model`（完整对象）/ `memory_scope` / `lifecycle` / `max_concurrent_children` / `observers`
- [ ] Zod Schema 校验通过示例 YAML
- [ ] 拒绝非法 YAML（缺少必填字段、类型错误）


### P1.1.6 角色 Provider 编译器

| 项 | 内容 |
|---|---|
| **目标** | 将角色 YAML 编译为可注册的 SubagentProvider |
| **交付物** | `src/l3-roles/role-loader.ts` 初版 |
| **前置** | P1.1.5 |
| **预估** | 2d |

**核心函数签名**：

```typescript
/**
 * 将角色 YAML 编译为 SubagentProvider。
 *
 * 🐛 必须显式传入完整 { provider, model } 对象：
 *    DSH Discussion #4311 确认子代理会继承 session 创建时冻结的默认路由，
 *    运行中切换模型不会传播到子代理，且错误被静默吞没。
 *    DSH Discussion #4313 确认 spawn 可能路由到 deepseek-official 错账户。
 *
 * @param role - 通过 Zod Schema 校验的角色定义
 * @param options - 编译选项（skillsDir 等）
 * @returns 可注册到 ctx.subagents 的 Provider
 * @throws {RoleLoadError} skill 文件不存在或读取失败
 */
export function compileRoleToProvider(
  role: RoleDefinition,
  options: { skillsDir: string },
): SubagentProvider;
```

**实现步骤**：
1. 解析 `system_prompt_ref` 路径（相对路径基于 `skillsDir` 解析）
2. 读取 skill 文件（不存在则抛 `RoleLoadError`）
3. 映射字段：`name ← role.id`，`persona ← skill 内容`，`toolFilter ← role.tools`，`agentOptions ← { provider, model }`，`depthLimit ← max_concurrent_children`，`inheritsParentContext ← (memory_scope === 'shared')`
4. 返回 Provider

**路径逃逸防护**：`system_prompt_ref` 解析后的路径必须位于 `skillsDir` 之内。

**验收标准**：
- [ ] R6 YAML → 可注册 Provider
- [ ] `model` 传完整 `{ provider, model }` 对象，不能只传 model 名
- [ ] `toolFilter` 映射正确
- [ ] `inheritsParentContext=false`
- [ ] 路径逃逸防护生效


### P1.1.7 Cordis 生命周期验证

| 项 | 内容 |
|---|---|
| **目标** | 验证 `ctx.effect()` 在插件热重载时正确清理资源 |
| **交付物** | 最小 effect 注册/注销 + 热重载测试 |
| **前置** | P1.1.1 |
| **预估** | 0.5d |

**验证内容**：

```typescript
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const timer = setInterval(() => {}, 1000);
    return () => clearInterval(timer);
  });
}
```

**验收标准**：
- [ ] `ctx.effect()` 返回的 disposer 在插件卸载时被调用
- [ ] 多个 effect 按 LIFO 顺序释放
- [ ] 插件热重载后无定时器泄漏
- [ ] `ctx.get('skills')` 可选服务探测返回正确结果


### P1.2.1 workflowEngine 脚本

| 项 | 内容 |
|---|---|
| **目标** | 用 workflowEngine 串行执行 R1→R2→R4→R6→R7→R8 |
| **交付物** | 脚本 + 产物落盘到 `productions/<角色>/` |
| **前置** | P1.1.6 |
| **预估** | 2d |

**脚本结构**：

```typescript
// 使用 DSH workflowEngine 的 agent() 钩子
async function runChain(userInput: string) {
  phase('需求分析');
  const prd = await agent(`你是 R1 需求分析师。用户需求：${userInput}`, {
    provider: 'R1-requirement',
  });
  await writeArtifact('R1-requirement', 'prd.md', prd);

  phase('架构设计');
  const arch = await agent(
    `你是 R2 架构师。基于 PRD 设计架构。PRD 摘要：${truncate(prd, 500)}。完整 PRD 见：art://R1-requirement/prd.md`,
    { provider: 'R2-architect' },
  );
  // ... R4 → R6 → R7 → R8
}
```

**关键设计**：
- 每个 `agent()` 调用的是独立的子代理 Session（`inheritsParentContext=false`）
- 下游 prompt 只携带上游产出的摘要 + 文件路径
- 产物落盘到 `productions/<角色ID>/`
- 任一 `agent()` 抛错则 fail-fast

**验收标准**：
- [ ] 脚本能跑通，产物落盘到 `productions/<角色ID>/`
- [ ] 一句话需求输入，自动走完 R1→R8
- [ ] 产出 PRD + 架构 + 代码 + 测试报告
- [ ] chat 中可见 workflow 节点


### P1.2.2 记忆隔离验证

| 项 | 内容 |
|---|---|
| **目标** | 确认 R3 与 R5 的 Session 不共享 context |
| **交付物** | 验证报告 |
| **前置** | P1.2.1 |
| **预估** | 0.5d |

**验证方法**：
1. 启动 R3 和 R5 两个子代理
2. 检查各自的 Session 日志
3. 确认 R3 的 context 不会出现在 R5 的 Session 中

**验收标准**：
- [ ] R3 与 R5 的 Session 不共享 context
- [ ] `inheritsParentContext=false` 生效


### P1.2.3 toolFilter 验证

| 项 | 内容 |
|---|---|
| **目标** | 确认 R6 只能看到自己的工具 |
| **交付物** | 验证报告 |
| **前置** | P1.2.1 |
| **预估** | 0.5d |

**验收标准**：
- [ ] R6 只能看到自己的工具
- [ ] `tools`→`toolFilter` 映射生效


### P1.2.4 单链闭环端到端测试

| 项 | 内容 |
|---|---|
| **目标** | 一句话需求输入，自动走完 R1→R8，产出完整交付物 |
| **交付物** | 测试脚本 + 运行记录 |
| **前置** | P1.2.2, P1.2.3 |
| **预估** | 1d |

**验收标准**：
- [ ] 一句话需求输入，自动走完 R1→R8
- [ ] 产出 PRD + 架构 + 代码 + 测试报告
- [ ] chat 中可见 workflow 节点


## 四、依赖关系与并行策略

```
P1.1.0 环境验证
    ↓
P1.1.1 脚手架搭建 ──→ P1.1.2 目录骨架 ──→ P1.1.3 共享类型
    │                        │                  │
    ↓                        ↓                  ↓
P1.1.7 生命周期验证    P1.1.4 日志基础设施   P1.1.5 角色 Schema
                             │                  │
                             └──────────────────┘
                                        │
                                        ↓
                              P1.1.6 Provider 编译器
                                        │
                                        ↓
                              P1.2.1 workflowEngine 脚本
                                        │
                              ┌─────────┴─────────┐
                              ↓                   ↓
                       P1.2.2 记忆隔离     P1.2.3 toolFilter
                              │                   │
                              └─────────┬─────────┘
                                        ↓
                              P1.2.4 端到端测试
```

**并行点**：P1.1.4 与 P1.1.5 可并行；P1.2.2 与 P1.2.3 可并行。


## 五、Windows 特有风险与缓解

| 风险 | 等级 | 缓解 | 对应任务 |
|---|---|---|---|
| **npx 安装卡死** | 🔴 | 使用 `npm install -g @deepseek-ai/dsh` 全局安装，避免 `npx` | P1.1.0 |
| **pnpm dlx 报 readStream 错误** | 🔴 | 使用全局安装的 `dsh` 命令，避免 `pnpm dlx` | P1.1.0 |
| **构建增量状态损坏** | 🟡 | `pnpm run clean` 后重新构建 | P1.1.1 |
| **Client 入口非 .tsx** | 🟡 | 入口文件必须是 `.tsx` 才能写 JSX | P1.1.1 |
| **路径逃逸** | 🔴 | 编译期校验 `system_prompt_ref` 路径在 `skillsDir` 内 | P1.1.6 |
| **model 传参不完整** | 🔴 | 代码审查 + 单元测试强制检查 `agentOptions` 是完整对象 | P1.1.6 |
| **Cordis 双副本** | 🟡 | 使用 scoped Cordis（`@deepseek-ai/cordis`），不保留 unscoped `cordis` import | P1.1.1 |
| **热重载资源泄漏** | 🟡 | 所有资源 `ctx.effect()` 注册 + 热重载测试 | P1.1.7 |


## 六、MVP-1 门禁（四项）

| # | 门禁 | 验证方式 | 不通过的后果 |
|---|---|---|---|
| 1 | **多角色顺序跑通真实小任务** | 端到端测试脚本 | 角色协作闭环不成立，MVP-2 无法开始 |
| 2 | **产物落盘** | 检查 `productions/<角色ID>/` 目录 | 交接机制不成立 |
| 3 | **记忆隔离验证通过** | R3 与 R5 的 Session 不共享 | G4 命门失效，全盘设计需重审 |
| 4 | **chat 中可见 workflow 节点** | DSH Web 界面检查 | workflowEngine 集成失败 |

**门禁通过后**：MVP-1 完成，可以启动 MVP-2（自研 StateGraph 引擎）。


## 七、工时估算

| 任务 ID | 任务名称 | 预估 |
|---|---|---|
| P1.1.0 | Windows 环境验证 | 0.5d |
| P1.1.1 | 插件脚手架搭建 | 0.5d |
| P1.1.2 | L0-L5 目录骨架 | 1d |
| P1.1.3 | 共享类型定义 | 1d |
| P1.1.4 | 结构化日志基础设施 | 1d |
| P1.1.5 | 角色 YAML Schema | 1d |
| P1.1.6 | 角色 Provider 编译器 | 2d |
| P1.1.7 | Cordis 生命周期验证 | 0.5d |
| P1.2.1 | workflowEngine 脚本 | 2d |
| P1.2.2 | 记忆隔离验证 | 0.5d |
| P1.2.3 | toolFilter 验证 | 0.5d |
| P1.2.4 | 单链闭环端到端测试 | 1d |
| **合计** | | **~11d（1.5 周）** |

> 注：P1.1.4 与 P1.1.5 可并行；P1.2.2 与 P1.2.3 可并行。实际关键路径约 9d。


## 八、与后续 MVP 的衔接

| MVP-1 产出 | MVP-2 如何使用 |
|---|---|
| `SubagentProvider` 编译逻辑 | MVP-2 的 StateGraph 节点通过 `roleRef` 引用这些 Provider |
| 角色 YAML Schema | MVP-2 的图 DSL 中 `roleRef` 指向已注册的角色 |
| 结构化日志基础设施 | MVP-2 的 RunLedger 事件流复用日志的 `trace_id` 关联 |
| 交付物落盘机制 | MVP-2 的 `art://` 工件引用直接基于 `productions/<角色ID>/` 目录 |
| 记忆隔离验证 | MVP-2 的 StateGraph 节点执行继续复用 `inheritsParentContext=false` |