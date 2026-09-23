# Git Commit 规范（references · R6-ts-developer）

> 固化来源：PM 确认的提交规范（2026-09-19），全项目 git commit 强制遵循。

## 格式

```
<type>(<scope>): <subject>
```

## type（必填，仅允许以下标识）

| type | 含义 |
|---|---|
| `feat` | 新功能（feature） |
| `fix` | 修复 bug——产生 diff 并自动修复此问题，适合一次提交直接修复 |
| `to` | 修复 bug——只产生 diff 不自动修复，适合多次提交；最终修复提交用 `fix` |
| `docs` | 文档（documentation） |
| `style` | 格式（不影响代码运行的变动） |
| `refactor` | 重构（非新增功能、非修改 bug 的代码变动） |
| `perf` | 优化（提升性能、体验） |
| `test` | 增加测试 |
| `chore` | 构建过程或辅助工具的变动 |
| `revert` | 回滚到上一个版本 |
| `merge` | 代码合并 |
| `sync` | 同步主线或分支的 Bug |

## scope（可选）

- 说明 commit 影响的范围（数据层、控制层、视图层等，视项目而定）。
- 影响多个 scope 时可用 `*` 代替。

## subject（必填）

- commit 目的的简短描述，**不超过 50 个字符**。
- 建议使用中文。
- **结尾不加句号或其他标点符号**。

## 示例

```
fix(DAO): 用户查询缺少 username 属性
feat(Controller): 用户查询接口开发
docs(skill): 新增软件开发工作流 skill 资产
chore(tools): 新增 keyword-gate 门禁脚本
```

## 提交纪律

- 一次提交只做一件事（按 type/scope 分组，不混提）。
- 写操作授权门：`git commit` 前确认提交内容与 message 符合本规范；message 生成后执行前显式确认。
