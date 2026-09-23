# Slot 问题整体处理方案

## 一、问题全景图

你从"页面报错"到"按钮出来"经历了 **5 个独立问题叠加**，表面都是 "slots" 报错或"按钮不出来"，但根因不同。按触发顺序：

```
问题1：inject 未声明        → 页面报 "cannot get property slots without inject"
问题2：加载器读错文件        → 页面报 "at new apply (index.js:15:23)"
问题3：bundle 形态不兼容     → 加载器读对了，但 module.exports 被覆盖
问题4：wrapper 覆盖 require  → esbuild banner 把 factory 形参 require 覆盖
问题5：加载器扫描不到包      → Network 里没有 client.js 请求
```

**5 个问题全部解决，按钮才出来。任何一环错，表现都是"没反应"或"slots 报错"。**

---

## 二、5 个问题逐一定位

### 问题 1：`inject` 未声明

| 项 | 内容 |
|---|---|
| **症状** | Console: `cannot get property "slots" without inject` |
| **根因** | Cordis fiber 守卫：访问 `ctx.xxx` 前必须在 `inject` 声明 |
| **修复文件** | `src/client/index.tsx` |
| **修复内容** | `export const inject = ['slots']` |

---

### 问题 2：加载器读错文件（关键，最隐蔽）

| 项 | 内容 |
|---|---|
| **症状** | 加了 `inject` 后仍报同样错，栈显示 `at new apply (index.js:15:23)` |
| **根因** | DSH client 加载器**根本没读你的 `lib/client.js`**，而是 fallback 到 `main: "./lib/index.js"`（Host 产物）。Host 端的 `apply` 没有 `inject`，所以被 Cordis 拒绝 |
| **为什么 fallback** | `package.json` 的 `dsh.client` 字段不完整，加载器不知道这个包有独立的 client bundle |
| **修复文件** | `package.json` |
| **修复内容** | 补全 `dsh.client` 的 `platform` / `inject` / `external` 三个字段（见 §三） |

---

### 问题 3：bundle 形态不兼容

| 项 | 内容 |
|---|---|
| **症状** | 加载器读对了 `lib/client.js`，但运行时报错或入口失效 |
| **根因** | tsdown 的 ESM→CJS 转换生成 `module.exports = __toCommonJS(client_exports)`，**覆盖**了 intro 里 `var exports = module.exports` 指向的旧对象。DSH loader 读新 module.exports 里没有 inject/apply |
| **修复文件** | `scripts/build-client.mjs` |
| **修复内容** | 用 esbuild 打包成 IIFE，手写 `window.__ModuleLoader__.load({ id, factory })` wrapper（照官方 `dsh-state-graph` 形态） |

---

### 问题 4：wrapper 覆盖 `require`

| 项 | 内容 |
|---|---|
| **症状** | esbuild build script 加了 `banner` 后 factory 抛错被静默吞掉，日志全无 |
| **根因** | banner 里 `var require = ...` 会 hoist 到 factory 函数顶部，**覆盖形参 `require`**，让 esbuild 生成的 `require("react")` 调到了错误的 fallback 函数 |
| **修复文件** | `scripts/build-client.mjs` |
| **修复内容** | 删掉 `banner` 配置。让 `require("react")` 沿作用域链命中 factory 的形参 `require` |

---

### 问题 5：加载器扫描不到包（最底层，是 MVP-4 UI 集成的真正门槛）

| 项 | 内容 |
|---|---|
| **症状** | 一切都对，但浏览器 Network 里**没有 `/plugins/dsh-agent-weave/client.js` 请求**，Console 没有任何 `[weave-client]` 日志 |
| **根因** | DSH 的 client 加载清单（`/plugins/??...` 那串 URL）**不是**扫 profile 的 `node_modules`，而是读 `dsh-web-app/cordis.patch.yml` 里显式声明的 roster。你的包不在 roster 里，就不被加载 |
| **修复文件** | `package.json` 的 `dsh.client` 字段 |
| **修复内容** | 完整声明 `platform` / `inject` / `external`，让 `dsh-client-modules` 扫到你的包并写入 `__DSH_BOOT__` |

---

## 三、完整修复清单

### 文件 1：`package.json`（最关键）

```json
{
  "name": "dsh-agent-weave",
  "version": "0.2.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": {
      "types": "./lib/client/index.d.ts",
      "default": "./lib/client.js"
    }
  },
  "files": ["lib", "cordis.patch.yml", "roles", "skills", "README.md"],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-slots"
      ],
      "external": [
        "react",
        "react/jsx-runtime"
      ]
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json && node scripts/build-client.mjs",
    "pack": "npm pack --pack-destination ./dist"
  }
}
```

**三个 `dsh.client` 字段的作用**：
- `platform: "web"` → 告诉加载器这是浏览器端插件
- `inject: [...]` → 声明 client bundle 依赖的官方包名（bundle 到达顺序）
- `external: [...]` → 声明从 shell 冻结模块表解析的模块（不内联进 bundle）

**`exports["./client"].default` 是 dsh.client 通道入口**，指向 `lib/client.js`。

---

### 文件 2：`src/client/index.tsx`

```tsx
import type { Context } from '@deepseek-ai/cordis'
import { WeaveDashboardButton } from './dashboard/WeaveDashboardButton.js'
import { WeaveDashboardView } from './dashboard/WeaveDashboardView.js'

// ✅ 必须导出：插件名 + 依赖声明 + apply
export const name = 'dsh-agent-weave-client'
export const inject = ['slots']   // ← Cordis 运行时服务依赖，与 dsh.client.inject 不同

interface SlotsLike {
  inject(name: string, register: () => (() => void) | undefined): void
  register(options: Record<string, unknown>, component: unknown): () => void
}

type ClientContext = Context & { slots?: SlotsLike }

export function apply(ctx: Context): void {
  const slots = (ctx as ClientContext).slots
  if (!slots) return

  // D1：页头按钮
  slots.inject('conversation.session.header.actions', () =>
    slots.register(
      { name: 'conversation.session.header.actions', id: 'weave-dashboard-toggle', label: () => 'Weave 看板', order: 0 },
      WeaveDashboardButton,
    ),
  )

  // D3：主区切换
  slots.inject('conversation.view', () =>
    slots.register(
      { name: 'conversation.view', id: 'weave-dashboard', label: () => 'Weave 看板', order: 10 },
      WeaveDashboardView,
    ),
  )
}
```

---

### 文件 3：`scripts/build-client.mjs`（关键，形态必须对）

```javascript
// scripts/build-client.mjs
// esbuild 打包 src/client 为 IIFE，再包进 DSH ModuleLoader 契约的 wrapper。
import { build } from 'esbuild'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const indent = (text, prefix) =>
  text.split('\n').map((l) => (l ? prefix + l : l)).join('\n')

const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'iife',
  globalName: 'WeaveClientBundle',
  platform: 'browser',
  target: 'es2024',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
  write: false,
  logLevel: 'info',
  // ❌ 不要 banner：会 hoist `var require` 覆盖 factory 形参
})

const bundleText = result.outputFiles[0].text

const out = `window.__ModuleLoader__.load({
  id: "dsh-agent-weave",
  factory: function (require) {
${indent(bundleText, '    ')}
    return WeaveClientBundle;
  },
});
`

mkdirSync(dirname('lib/client.js'), { recursive: true })
writeFileSync('lib/client.js', out, 'utf8')
console.log('[build-client] lib/client.js:', out.length, 'bytes')
```

**形态三要素**：
1. `id` 必须等于包名 `"dsh-agent-weave"`
2. `factory` 必须是**普通函数**（不能箭头函数）
3. `return WeaveClientBundle` 把 esbuild IIFE 的命名导出对象作为 `module.exports`

---

### 文件 4：`cordis.patch.yml`

```yaml
- insert:
    - id: dsh-agent-weave
      name: dsh-agent-weave   # 必须等于包名
```

**`name` 必须等于包名**，因为 `dsh-client-modules` 用 `require.resolve('<name>/package.json')` 解析包路径。

---

## 四、验证流程（5 步逐层确认）

```powershell
# 1. 构建产物形态
Get-Content lib\client.js -TotalCount 10
# 期望：
#   window.__ModuleLoader__.load({
#     id: "dsh-agent-weave",
#     factory: function (require) {
#       "use strict";
#       var WeaveClientBundle = (() => {

# 2. 打包 + 安装
pnpm build && pnpm pack
$dshBin --profile weave-test plugin add ./dist/dsh-agent-weave-0.2.0.tgz

# 3. 确认 profile 里装的是新产物
Get-Content "test-env\dsh-home\profiles\weave-test\node_modules\dsh-agent-weave\lib\client.js" -TotalCount 5

# 4. 确认 package.json 的 dsh.client 三字段齐全
Get-Content "test-env\dsh-home\profiles\weave-test\node_modules\dsh-agent-weave\package.json" -Raw |
  Select-String -Pattern '"client"' -Context 0,12

# 5. 启动 DSH，浏览器 F12
node $dshBin --profile weave-test --port 3081
# Network 过滤 dsh-agent-weave → 应有 client.js 请求 200
# Console 过滤 weave-client → 应有 module loaded / apply done
```

---

## 五、排查清单（下次遇到同类问题）

按顺序对照 Console 最后一条日志：

| 最后看到 | 说明 | 修复 |
|---|---|---|
| **完全没 `[weave-client]`** | 加载器扫不到 | 检查 `dsh.client.platform/inject/external` 三字段 |
| **`module loaded` 后停** | Cordis 拒绝激活 | 检查 `export const inject = ['slots']` |
| **`apply invoked` + `no slots`** | slots 服务名不对 | 检查 DSH 版本里 slots 的服务名 |
| **`register start` 后没 `callback fired`** | 挂载点名字不对 | 探测 DSH 实际挂载点（`conversation.session.header.actions` 等） |
| **`callback fired` 但页面无按钮** | `register` 参数错 | 对照官方 `ui-*` 插件签名 |
| **全绿但组件不渲染** | React 组件问题 | 检查组件返回 null 或渲染报错 |

---

## 六、防再犯的心智模型

**DSH Client 插件三件套**：

```
┌──────────────────────────────────────────────────────────┐
│ 1. package.json                                          │
│    dsh.client.{platform, inject, external} ← 加载器扫我  │
│    exports["./client"] ← 我 bundle 在哪                  │
│                                                          │
│ 2. lib/client.js                                         │
│    window.__ModuleLoader__.load({ id: 包名, factory })   │
│    ← 加载器执行我                                        │
│                                                          │
│ 3. src/client/index.tsx                                  │
│    export const name / inject / function apply           │
│    ← Cordis 激活我                                       │
└──────────────────────────────────────────────────────────┘
```

**三层缺一不可**：
- 缺 1 → 加载器扫不到，无请求
- 缺 2 或形态错 → 加载器读了但执行失败
- 缺 3 或 inject 缺 → Cordis 拒绝激活

**"slots 报错" 两种含义**（容易混淆）：
- `cannot get property "slots" without inject` → 问题 1/2（inject 未声明或读错文件）
- `no slots` → 服务名不对或服务未就绪

---

## 七、一句话总结

**你踩的 5 个坑，本质是"DSH Client 插件三件套"每一层都缺过：`package.json` 的 `dsh.client` 声明不全（问题 2、5）→ `lib/client.js` 形态不对（问题 3、4）→ `src/client/index.tsx` 的 inject 没声明（问题 1）。三个环节全部打通，按钮才出来。核心心智：加载器扫 `package.json` 找 bundle → 加载 `lib/client.js` 找 factory → Cordis 读 `src/client/index.tsx` 找 inject/apply。三层都必须对。**