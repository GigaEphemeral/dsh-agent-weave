# 本地隔离测试环境（test-env）

> 按开发规约（D-10）：隔离测试环境默认不回收，跨会话保留，供用户直接访问复验。

## 用途

承载 MVP-1 的**真实 DSH 运行时验证**（角色注册 / 单链执行 / 门禁验收），
**不污染主环境**（`D:\dsharness\data` 零写入）。

## 访问方式

| 项 | 值 |
|---|---|
| 隔离 DSH_HOME | `test-env/dsh-home/`（含 `profiles/weave-headless`、`profiles/weave-test`） |
| 隔离 web（门禁 4 人工验证） | 启动后 URL 见日志 `test-env/web-gate4.log`（随机端口） |
| 端到端运行日志 | `test-env/e2e-run1.log`、`e2e-run2.log` |
| mock LLM 证据 | `test-env/probe-web.mjs`、`verify-roles.mjs`、`check-*.mjs`、`fix-pnpm-links.mjs` |
| 验证报告 | `docs/MVP-1/验证报告-单链闭环.md` |

## 启动方式

```powershell
# 前置：mock LLM server（在 harness 仓库路径启动）
node D:\dsharness\sof\deepseek-harness\packages\test-support\llm-mock-server\lib\index.js
# 需要自定义序列（tool_call + success），见 test-env/ 下的启动命令记录

# 启动隔离 web（随机端口，日志落盘）
$env:DSH_HOME = '<项目>\test-env\dsh-home'
$env:MOCK_LLM_API_KEY = 'mock-key'
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile weave-test --no-open --port 0

# headless 一次性任务（端到端单链）
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile weave-headless "调用 weave_run_chain 工具，user_input 为 '...'"
```

## 当前状态（2026-09-22）

- ✅ 角色注册验证通过（6 角色，inherits_parent_context=false）
- ✅ 端到端单链跑通（R1→R8 六阶段 completed，产物落盘 productions/）
- ✅ 四项门禁中的三项自动验证通过；门禁 4（chat 可见 workflow 节点）待人工在隔离 web 确认
- ⏳ 真实 LLM 端到端待用户提供 HUOSHAN API key 后复验

## 注意事项

- 测试数据一律保留，由 PM/用户确认后才动；禁止自动清理。
- 隔离 DSH_HOME 不提交 git（`.gitignore` 已排除 `test-env/`）。
- mock LLM 返回固定文本；真实 LLM 会产出各角色不同内容。
