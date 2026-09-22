# Windows 环境验证报告（P1.1.0）

> 版本：v1（2026-09-22）｜任务：P1.1.0 Windows 环境验证
> 执行环境：Windows 11 + 本机实测
> 依据：`docs/MVP-1/1-DevTask.md` P1.1.0

## 一、验证结果总表

| 项 | 期望值 | 实测值 | 结果 |
|---|---|---|---|
| DSH 版本 | 0.1.15-rc2（文档标注） | **0.1.5-rc.2** | ⚠️ 差异（见 §二） |
| Node 版本 | `^22.19.0 \|\| >=24.0.0` | **v22.23.2** | ✅ |
| pnpm 版本 | `>=11`（DevTask 写 11.7.0） | **12.3.4** | ✅ |
| `dsh web --help` | 正常输出帮助信息 | 正常输出 | ✅ |

## 二、DSH 版本差异说明（重要）

| 项 | 内容 |
|---|---|
| 文档标注 | `1-DevTask.md` / `README.md` 均写 **0.1.15-rc2** |
| 实测值 | `dsh --version` → **0.1.5-rc.2** |
| 包版本 | `@deepseek-ai/dsh` = 0.1.5-rc.2；`@deepseek-ai/dsh-subagent` = 0.1.5-rc.2；`@deepseek-ai/cordis` = 4.0.2 |
| 结论 | 以实测 0.1.5-rc.2 为准；脚手架 peerDependencies 版本按实测线声明；若与文档 0.1.15-rc2 存在 API 差异，以官方源码为准并记录 |

## 三、DSH 安装位置与运行方式

| 项 | 值 |
|---|---|
| `dsh` 命令 | **不在 PATH**（`Get-Command dsh` 失败） |
| bin 实际位置 | `%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js`（junction → `D:\dsharness\sof\deepseek-harness\apps\cli`） |
| DSH_HOME | `D:\dsharness\data`（含 profiles/sessions/skills/storages 等） |
| 调用方式 | `node <dsh-bin.js> --profile web ...`（或经启动器） |

### 关键环境事实（影响测试隔离设计）

1. **`dsh web` 运行时会写 DSH_HOME**：实测 `prepareProfile` 阶段写入 `D:\dsharness\data\profiles\web\cordis.yml`。
2. **因此任何真实 DSH 运行（插件安装/启动/热重载）都必须使用隔离 DSH_HOME**，避免污染本机 `D:\dsharness\data`（用户主环境）。
3. 隔离方式：测试时设置 `DSH_HOME=<3pluginCode>/test-env/<case>/dsh-home`，在隔离目录内执行 `dsh` 全流程；主环境零写入。

## 四、Windows 特有边界复核

| 限制 | 影响 | 结论 |
|---|---|---|
| Bash 工具不可用 | MVP-1 不依赖 Bash 工具 | ✅ 无影响 |
| 无持久化 PTY | 每次 `pwsh` 调用全新 Shell | ✅ 角色编译是同步操作 |
| Python SDK wheel 未发布 Windows 版 | MVP-1 用 TypeScript | ✅ 无影响 |
| 路径处理 | 用 `pathToFileURL` 转换插件路径，不要手写反斜杠转义 | 记入开发规约 |

## 五、P1.1.0 验收核对

- [x] `dsh --version` → 0.1.5-rc.2（与文档 0.1.15-rc2 有差异，已记录）
- [x] `node --version` → v22.23.2，满足 `^22.19.0`
- [x] `pnpm --version` → 12.3.4，满足 `>=11`
- [x] `dsh web --help` 正常输出帮助信息
- [x] 确认 DSH 安装位置与 DSH_HOME 路径
- [x] 确认隔离测试必要性并确定隔离方案（隔离 DSH_HOME）

## 六、后续开发使用基线

| 项 | 值 |
|---|---|
| 插件 peerDependencies | `@deepseek-ai/cordis` `^4.0.0`（实测 4.0.2）；`@deepseek-ai/dsh-subagent` `^0.1.5-rc.2` |
| 构建 | tsc（Host）+ tsdown（Client）；NodeNext ESM；相对导入带 `.js` |
| 测试隔离 | 隔离 DSH_HOME = `<项目>/test-env/<case>/dsh-home`；真实 DSH 运行绝不写 `D:\dsharness\data` |
| 三方参考代码 | 由用户下载至 `docs/MVP-1/reference-gitignore/`，不自行动手下载 |

---
> 证据：`dsh --version` → `0.1.5-rc.2`；`node --version` → `v22.23.2`；`pnpm --version` → `12.3.4`；`dsh web --help` 正常输出（含 ocr 插件加载日志）。
