# DSH 开发踩坑与经验（references · R6-ts-developer）

> 固化来源：本项目实际开发/测试/环境搭建中遇到的真实问题（2026-09-18~19）。
> 每条含 症状→根因→处置，便于复用。

## 1. DSH 空 cordis.patch.yml 阻断 boot
- **症状**：`dsh --profile <任意新profile> --dump-config` 报 `patches <DSH_HOME>/cordis.patch.yml must be a top-level YAML array`，boot 失败。
- **根因**：`<DSH_HOME>/cordis.patch.yml` 被写成 0 字节空文件；DSH 要求顶层数组（`[]`）。这是 DSH 初始化 bug（生成了文件但没写内容）。
- **处置**：把文件内容写成 `[]`（UTF-8 无 BOM）。已在主环境修复。**注意**：此文件是全局 home 层 patch，所有 profile 共享；修复后新 profile 才能 boot。

## 2. tsx/esbuild spawn EPERM（沙箱）
- **症状**：源码模式跑 `node --import tsx/esm apps/cli/src/bin.ts ...` 报 `Error [TransformError]: spawn EPERM`；archify 的 validate/deliver 也报 `Renderer process could not start ... EPERM`。
- **根因**：tsx 用 esbuild 子进程做转译，沙箱限制程序 spawn 子进程捕获输出（named pipe 限制）。
- **处置**：这类命令需 `sandbox_permissions: danger-full-access` 跑；无权限时不可用源码模式跑 dsh CLI（可改用已编译产物 `apps/cli/lib/bin.js`）。

## 3. 隔离 DSH 环境搭建（不污染主环境）
- **目标**：独立 profile + 独立 DSH_HOME，主环境零接触。
- **步骤**：
  1. `mkdir <隔离DSH_HOME>/profiles`，复制 `.credentials.yaml` + `settings.yaml` 副本
  2. 写 `<隔离DSH_HOME>/cordis.patch.yml` = `[]`（修复空文件 bug）
  3. `dsh --profile <name> --from-default-profile web` 创建干净 profile（仅 base+web-app）
  4. skills 复制到 `<隔离DSH_HOME>/skills/` —— standard preset 的 skill-filesystem 自动扫 `$DSH_HOME/skills`（USER_DSH_RANK），无需额外 patch
  5. `dsh --profile <name> --port <新端口> --no-open` 后台启动（避开主环境端口）
- **验证**：无 token 请求 401（鉴权生效）、带 `?token=` HTTP 200 + `__DSH_BOOT__` 注入。

## 4. Windows UTF-8（D-09）
- pwsh 跑 python/中文输出前 `$env:PYTHONIOENCODING="utf-8"`；控制台乱码设 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`；pwsh 写文件避免 Out-File 默认 BOM（读回用 `utf-8-sig`）；python 读文件 `encoding='utf-8'`。详见 `4projectProgressControl/tools/windows-utf8.md`。

## 5. token 记账（P0-2）
- 会话日志 `sessions/<workspace>/session-*/session.v3.jsonl.zstd`（多帧 zstd）含每次请求 `usage:{inputTokens,outputTokens,totalTokens,cacheReadTokens}`。
- 工具：`4projectProgressControl/tools/token-ledger.mjs`（通用：文件/目录/workspace 三态 + `--json`/`--out`）。
