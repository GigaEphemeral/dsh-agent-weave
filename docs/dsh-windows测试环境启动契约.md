# Windows PowerShell 下启动隔离测试环境操作手册

> 版本：v1.0 ｜ 2026-09-23
> 适用：DSH 插件开发者，需要在不影响主环境的前提下，用独立 `DSH_HOME` 启动 web / headless 测试环境
> 环境：Windows + PowerShell 5.1 + Git Bash（可选）+ pnpm


## 一、目标与设计原则

**目标**：为 DSH 插件开发提供一个与主环境**数据隔离**的测试环境，用于可视化验收、失败复现和回归测试。

**设计原则**：
- **数据隔离**：使用独立的 `$DSH_HOME`，主环境 `~/.dsh` 零写入
- **端口隔离**：测试环境用 `3081`，主环境保持 `3080`
- **模型可选**：可切换本地 Ollama（零 token 成本）或远端 provider
- **可重复**：全部通过 PowerShell 命令可重建，不依赖手工操作


## 二、占位符与全量替换说明

> ⚠️ **以下路径均为占位符，请按你本机实际情况全量替换后再执行命令。**
> 建议在 PowerShell 里先定义一次变量，后续命令直接引用。

| 占位符 | 含义 | 示例（本文档用户环境） |
| :--- | :--- | :--- |
| `<DSH_REPO>` | DSH 源码仓库根目录 | `D:\dsharness\sof\deepseek-harness` |
| `<PROJECT_ROOT>` | 你的插件项目根目录 | `D:\dsharness\agentDev\...\3pluginCode` |
| `<TEST_HOME>` | 测试环境数据目录 | `<PROJECT_ROOT>\test-env\dsh-home` |
| `<PLUGIN_TGZ>` | 插件打包产物 tgz 的绝对路径 | `<PROJECT_ROOT>\dist\dsh-agent-weave-0.1.0.tgz` |
| `<DSH_BIN>` | DSH CLI 的 `bin.js` | `$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js` |
| `<DSH_VER>` | DSH 版本号 | `0.1.5-rc.2` |
| `<PLUGIN_NAME>` | 插件包名 | `dsh-agent-weave` |
| `<WEB_PROFILE>` | web 全量测试 profile 名 | `weave-test` |
| `<HEADLESS_PROFILE>` | headless 测试 profile 名 | `weave-headless` |

**统一变量定义（在每个新 PowerShell 窗口开头执行一次）**：

```powershell
# ⚠️ 全部替换为你本机的实际路径
$env:DSH_HOME = "<TEST_HOME>"
$DSH_BIN       = "<DSH_BIN>"
$PROJECT_ROOT  = "<PROJECT_ROOT>"
$DSH_VER       = "<DSH_VER>"
$PLUGIN_TGZ    = "<PLUGIN_TGZ>"
```

> 这些变量**只在当前 PowerShell 窗口有效**，关闭窗口后需重新定义。


## 三、前置检查

**在任意目录下执行：**

```powershell
# 1. DSH CLI 是否存在
Test-Path $DSH_BIN

# 2. 插件 tgz 是否存在
Test-Path $PLUGIN_TGZ

# 3. Ollama 是否运行（若用本地模型）
try {
    $r = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing -TimeoutSec 3
    Write-Host "Ollama OK: $($r.StatusCode)"
} catch {
    Write-Host "Ollama 不可用：$_"
}

# 4. 端口占用检查（测试环境用 3081）
netstat -ano | findstr :3081
```

**预期**：前两项 `True`；Ollama 返回 `200`；3081 未被占用。


## 四、完整操作步骤

### 步骤 0：清理旧测试环境（可选）

**在任意目录下执行：**

```powershell
# 停掉可能残留的 dsh 进程
Get-Process node -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*dsh*" } |
    Format-Table Id, CommandLine -AutoSize
# 确认后按 PID 精确杀：
# Stop-Process -Id <PID> -Force

# 备份旧环境
if (Test-Path $env:DSH_HOME) {
    $backup = "$env:DSH_HOME.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Move-Item $env:DSH_HOME $backup
    Write-Host "已备份到: $backup"
}

# 新建空目录
New-Item -ItemType Directory -Force -Path "$env:DSH_HOME\profiles" | Out-Null
New-Item -ItemType Directory -Force -Path "$env:DSH_HOME\sessions" | Out-Null
```

> **注意**：不要盲目 `Get-Process node | Stop-Process`，可能误杀其他 node 服务。


### 步骤 1：创建 Profile 骨架

**在 `$env:DSH_HOME\profiles\<WEB_PROFILE>` 目录下创建 `package.json`：**

```powershell
$profileDir = "$env:DSH_HOME\profiles\weave-test"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$pkgContent = @'
{
  "name": "dsh-profile-weave-test",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-agent-weave"
      ]
    }
  },
  "dependencies": {
    "@deepseek-ai/dsh-base": "0.1.5-rc.2",
    "@deepseek-ai/dsh-web-app": "0.1.5-rc.2",
    "dsh-agent-weave": "file:<PLUGIN_TGZ 的绝对路径，正斜杠>"
  }
}
'@
[System.IO.File]::WriteAllText("$profileDir\package.json", $pkgContent, $utf8NoBom)
```

**在同目录下创建 `cordis.patch.yml`：**

```powershell
$patchContent = @'
# 测试 profile 补丁层
# patchReload 用 startup，避免 live 模式对 HMR 的依赖
- id: patch-reload
  config:
    mode: startup
'@
[System.IO.File]::WriteAllText("$profileDir\cordis.patch.yml", $patchContent, $utf8NoBom)
```

> ⚠️ **必须用 `[System.IO.File]::WriteAllText` 配合 `UTF8Encoding($false)`**，不要用 `Set-Content -Encoding UTF8`（PowerShell 5.1 会写 BOM，pnpm 会报 `Invalid package.json`）。


### 步骤 2：安装依赖

**切换到 profile 目录，执行：**

```powershell
cd $profileDir
pnpm install
```

**如果报 `ERR_PNPM_IGNORED_BUILDS`，执行交互式批准：**

```powershell
pnpm approve-builds
# 空格全选 → 回车 → yes
```

> 这一步会编译 `koffi` / `node-pty` / `protobufjs` / `@google/genai` / `@deepseek-ai/dsh-subprocess-local` 等原生模块。**这一步不做，spawn provider 会在后续加载时静默失败。**


### 步骤 3：安装 subagent 相关包

**在 profile 目录下执行：**

```powershell
pnpm add @deepseek-ai/dsh-subagent@<DSH_VER>
pnpm add @deepseek-ai/dsh-subagent-spawn-in-process@<DSH_VER>
pnpm add @deepseek-ai/dsh-subagent-in-process-driver@<DSH_VER>
```

**验证三个包都在：**

```powershell
Test-Path ".\node_modules\@deepseek-ai\dsh-subagent"
Test-Path ".\node_modules\@deepseek-ai\dsh-subagent-spawn-in-process"
Test-Path ".\node_modules\@deepseek-ai\dsh-subagent-in-process-driver"
```


### 步骤 4：验证 spawn 插件可被 import

**在 profile 目录下执行：**

```powershell
node --input-type=module -e "import('@deepseek-ai/dsh-subagent-spawn-in-process').then(m => { console.log('name:', m.name); console.log('default.name:', m.default?.name); console.log('apply 是函数:', typeof m.apply === 'function' || typeof m.default?.apply === 'function'); console.log('inject:', m.inject || m.default?.inject); })"
```

**预期**：`name` 或 `default.name` 为 `subagent-spawn-in-process`，`apply 是函数: true`。


### 步骤 5：启动测试环境

#### 5.1 启动 headless 快速验证（推荐先做）

**在 `<PROJECT_ROOT>` 目录下执行：**

```powershell
cd $PROJECT_ROOT
node $DSH_BIN --profile weave-headless "只回复：收到" 2>&1 |
    Select-String -Pattern "注册角色|找不到底层|spawn|图引擎"
```

**预期**：看到 `注册角色 R1-requirement` 等 6 行日志，且**没有** `找不到底层 subagent provider`。

#### 5.2 启动 web 全量模式

**在 `<PROJECT_ROOT>` 目录下执行：**

```powershell
cd $PROJECT_ROOT
node $DSH_BIN --profile weave-test --port 3081
```

浏览器打开终端打印的 URL（带 token）。


### 步骤 6：可视化验收

**web chat 输入：**

```
请调用 weave_graph_watch 工具，参数 path 为 workflows/visual-demo.yaml，并完整输出工具返回的终端视图文本
```

**预期**：看到每个节点的执行事件流（当前节点 / 迭代 / retry / 耗时 / Token / checkpoint）。


### 步骤 7：完全清理

**在任意目录下执行：**

```powershell
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*dsh*" } | Stop-Process -Force
Remove-Item -Recurse -Force $env:DSH_HOME
Test-Path $env:DSH_HOME   # 应为 False
```


## 五、根因与踩坑记录

> 本部分记录本次搭建过程中实际踩过的坑，以及每个坑对应的根因和解决方案。

### 🕳️ 坑 1：`Invalid package.json`

**现象**：
```
$ pnpm install
Invalid package.json in package.json
```

**根因**：`package.json` 被写入了 **UTF-8 BOM**（`EF BB BF`）。pnpm / Node 解析 JSON 时不认 BOM。

**触发方式**：用 `Set-Content -Encoding UTF8` 写文件。PowerShell 5.1 的 `-Encoding UTF8` **总是带 BOM**。

**修复**：
```powershell
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("绝对路径", $内容, $utf8NoBom)
```

**验证 BOM 是否消失**：
```powershell
$pkgPath = (Resolve-Path ".\package.json").Path
[System.IO.File]::ReadAllBytes($pkgPath)[0..2] | ForEach-Object { '{0:X2}' -f $_ }
# 应为 7B（即 {），不应为 EF
```

**附带坑**：`[System.IO.File]::ReadAllBytes(".\package.json")` 的相对路径会被解析到 **.NET 进程的当前目录**（通常是 `C:\Users\<用户名>`），而不是 PowerShell 的 `$PWD`。必须用 `Resolve-Path` 转绝对路径。


### 🕳️ 坑 2：`a BOM must not appear inside a document`

**现象**：
```
Failed to parse pnpm-workspace.yaml: error: line 7 column 1: a BOM must not appear
inside a document
  7 | ﻿onlyBuiltDependencies:
    | ^ a BOM must not appear inside a document
```

**根因**：`pnpm-workspace.yaml` **被多次写入**，前一次残留的模板内容（`set this to true or false`）和后来追加的内容叠加，且中间被插入了 BOM。

**触发方式**：手动编辑 `pnpm-workspace.yaml`，或用 `Set-Content -Encoding UTF8` 反复覆盖。

**修复**：
1. **不要手动编辑 `pnpm-workspace.yaml`**，它由 pnpm 自己管理
2. 删掉它：`Remove-Item .\pnpm-workspace.yaml -Force`
3. 用交互式批准重建：`pnpm approve-builds`（空格全选 → 回车 → yes）

> `pnpm approve-builds` 执行后会**重新生成** `pnpm-workspace.yaml`，所以 `Test-Path` 返回 `True` 是**正确行为**，不是错误。


### 🕳️ 坑 3：`ERR_PNPM_IGNORED_BUILDS`

**现象**：
```
Error: ERR_PNPM_IGNORED_BUILDS
  × installing dependencies
  ╰─▶ Ignored build scripts: @deepseek-ai/dsh-subprocess-local@..., koffi@..., node-pty@..., protobufjs@..., @google/genai@...
  help: Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

**根因**：pnpm 默认不信任 native 依赖的构建脚本，需要显式批准。

**修复**：
```powershell
pnpm approve-builds
# 交互界面里用空格全选，回车确认，输入 yes
```

**关键提醒**：这一步**必须完成**。如果不做，`koffi` / `node-pty` / `dsh-subprocess-local` 等原生模块不会编译，spawn provider 后续会**静默失败**（不报错，但注册不上）。


### 🕳️ 坑 4：`hmr.registerConfig is not a function`

**现象**：web 完整模式启动后立即崩溃退出。

**根因**：profile 的 `patchReload` 被设置为 `live`，但测试环境里 HMR 插件是 `disabled: true`，导致 `live` 模式调用 `hmr.registerConfig` 时找不到该函数。

**修复**：在 profile 的 `cordis.patch.yml` 里显式设置：
```yaml
- id: patch-reload
  config:
    mode: startup
```

**与 headless 保持一致**：`headless` profile 默认就是 `startup`，所以不会触发此崩溃。


### 🕳️ 坑 5：`spawn provider 未注册`

**现象**：
```
{"level":"error","component":"weave","msg":"找不到底层 subagent provider，跳过角色注册（图命令不受影响）","data":{"base_provider":"spawn"}}
```

**根因**：**两个问题叠加**：
1. **原生模块未编译**：`pnpm approve-builds` 一直被 BOM 问题挡住，导致 `dsh-subprocess-local` / `koffi` / `node-pty` 未构建
2. **spawn 相关三包缺失**：`dsh-subagent` + `dsh-subagent-spawn-in-process` + `dsh-subagent-in-process-driver` 未安装

**修复**：先解决 BOM → 执行 `pnpm approve-builds` → 安装三个 spawn 相关包 → 重启。

**验证成功的标志**：日志里出现 `注册角色 R1-requirement` 等 6 行 role-loader 日志，且**没有** `找不到底层 subagent provider`。


### 🕳️ 坑 6：`--patch` 无法加载未安装的插件

**现象**：
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'dsh-approval-gate' imported from ...\profiles\web\
```

**根因**：`--patch` 只加载**已安装**的插件配置层，不会自动从 npm / GitHub 下载包。

**修复**：
- **正式安装**：`dsh plugin --profile web add <包名>`
- **本地调试**：先用 `dsh plugin add` 把插件链接进 profile，再用 `--patch` 做配置覆盖


### 🕳️ 坑 7：`--dump-config` 有配置但运行时不加载

**现象**：`--dump-config` 显示 spawn 插件在配置树里，但完整启动日志里**没有** spawn 插件的加载痕迹（成功或失败都没有）。

**根因**：Cordis 加载器要求模块 export 的 `name`（或 `default.name`）与 patch 中声明的 `id` / `name` 匹配。不匹配时**可能静默跳过**，不报错。

**排查方法**：
```powershell
node --input-type=module -e "import('@deepseek-ai/dsh-subagent-spawn-in-process').then(m => { console.log('name:', m.name); console.log('default.name:', m.default?.name); })"
```
把实际 `name` 与 patch 里的 `name` 对比，改 patch 为实际值。


### 🕳️ 坑 8：端口占用 `EADDRINUSE`

**现象**：
```
Error: listen EADDRINUSE: address already in use 127.0.0.1:3080
```

**根因**：主环境或上一次测试进程仍在占用端口。

**修复**：
```powershell
netstat -ano | findstr :3080
# 拿到 PID 后
taskkill //PID <PID> //F
# 或改用其他端口
node $DSH_BIN --profile weave-test --port 3081
```


## 六、常见错误速查表

| 报错关键字 | 根因 | 快速修复 |
| :--- | :--- | :--- |
| `Invalid package.json` | 文件有 UTF-8 BOM | 用 `UTF8Encoding($false)` 重写 |
| `a BOM must not appear` | `pnpm-workspace.yaml` 混入 BOM | 删掉它，`pnpm approve-builds` 重建 |
| `ERR_PNPM_IGNORED_BUILDS` | native 构建脚本未批准 | `pnpm approve-builds` |
| `hmr.registerConfig is not a function` | patchReload 为 live 但 HMR disabled | 改为 `mode: startup` |
| `spawn provider 未注册` | spawn 三包缺失 或 原生模块未编译 | 装三包 + approve-builds |
| `Cannot find package` | 插件未安装，`--patch` 找不到 | 先 `dsh plugin add` |
| `EADDRINUSE` | 端口被占用 | 换端口 或 `taskkill` |
| `Failed to fetch ...timed out` | npm 源网络超时 | `pnpm config set registry https://registry.npmmirror.com` |


## 七、附录：隔离性说明

**已隔离**：
- 数据目录（`$DSH_HOME` 独立）
- Profile 的 `node_modules` 独立
- 会话日志、缓存、凭据独立

**未隔离**：
- DSH CLI 安装树（共享 `~/.dsh/profiles/node_modules`）
- Ollama 服务（共享 `localhost:11434`）
- 系统 CPU / 内存 / 磁盘

**同时启动**：主环境用 3080，测试环境用 3081，即可并行运行。两个环境共享同一个 Ollama，高频推理时注意排队。


## 八、最小可执行清单（TL;DR）

```powershell
# 0. 变量（每个新窗口都要定义）
$env:DSH_HOME = "<TEST_HOME>"
$DSH_BIN       = "<DSH_BIN>"
$PROJECT_ROOT  = "<PROJECT_ROOT>"
$PLUGIN_TGZ    = "<PLUGIN_TGZ>"
$DSH_VER       = "0.1.5-rc.2"

# 1. 创建 profile 目录 + package.json + cordis.patch.yml（见步骤 1）
# 2. cd $profileDir; pnpm install
# 3. pnpm approve-builds（空格全选 → 回车 → yes）
# 4. pnpm add @deepseek-ai/dsh-subagent@$DSH_VER
#    pnpm add @deepseek-ai/dsh-subagent-spawn-in-process@$DSH_VER
#    pnpm add @deepseek-ai/dsh-subagent-in-process-driver@$DSH_VER
# 5. cd $PROJECT_ROOT
#    node $DSH_BIN --profile weave-headless "只回复：收到"
#    预期看到 "注册角色 R1-requirement" 且无 spawn 错误
# 6. node $DSH_BIN --profile weave-test --port 3081
```

---

# 九、待优化项（2026-09-23 登记）

> 目标：减少"反复排查同一类环境问题"的时间与 token 消耗。

| # | 待优化项 | 现状 | 建议 |
|---|---|---|---|
| 1 | **排查过程自动化** | 每次环境问题手工逐条排查（dump-config / 日志 / 依赖树） | 写 `test-env/diagnose-profile.ps1`：一键输出插件树关键行 + spawn 三包存在性 + build-scripts 状态 + 角色注册日志 |
| 2 | **"禁止多轮次反复排查"纪律** | 本次 spawn 排查绕了多轮（依赖→构建→peer→插件树） | 固化规则：同一问题若 3 轮内未定位，立即记录当前假设 + 停手，请求用户协助或重读契约文档 §五 根因表 |
| 3 | **profile 依赖树版本化** | weave-test/weave-headless 的 package.json 依赖靠手工维护 | 将完整 package.json（含 dsh-base + spawn 三包 + cordis + driver）纳入 git，重装用 `pnpm install` 一步到位，避免依赖漂移 |
| 4 | **build-scripts 审批前置** | `ERR_PNPM_IGNORED_BUILDS` 每次都手工 approve | 在契约文档步骤 2 后固定 `pnpm approve-builds`（全选），并验证 `pnpm-workspace.yaml` 的 allowBuilds 已写 true |
| 5 | **插件重装流程自动化** | remove + add 手工执行，且 .pnpm 实体可能不更新 | 写 `test-env/reinstall-plugin.ps1`：build → pack → remove → add → 强制覆盖 .pnpm 实体 lib → headless 冒烟验证 |
| 6 | **trace 进度观测固化** | trace 落盘已实现（S9），但观测命令靠手工 | 新增 `weave_graph_tail` 工具 + 文档化 `Get-Content -Wait` 用法（已完成，见 MVP-3 指南） |

**已落地**：#6（weave_graph_tail + 文档）；#3 部分（契约文档已含完整依赖清单）。

---

**文档结束**。如需针对 headless profile 的独立操作步骤，可参照步骤 1~5，把 `dsh-web-app` 换成 `dsh-headless`，profile 名换成 `weave-headless` 即可。