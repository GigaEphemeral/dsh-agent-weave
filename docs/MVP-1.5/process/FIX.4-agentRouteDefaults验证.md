# FIX.4 agentRouteDefaults 验证报告

> 任务：FIX.4 验证 `agentRouteDefaults` 生效｜状态：**✅ 通过**｜2026-09-22
> 结论：**规避有效**——子代理 session 实际路由的 provider/model 与角色 YAML 指定一致，且未继承主 Agent 的 model。

## 一、验证目标

MVP-1 文档声称「角色 provider `start()` 注入角色字段」（D-001 包装 provider 形态），
但无证据表明 `agentRouteDefaults` 真的生效——子代理可能继承了主 Agent 的模型而非角色
YAML 指定的模型（🐛 Discussion #4311/#4313 规避依赖）。本任务验证：
**子代理 session 的 model 字段是否等于角色 YAML 中 model 指定的值。**

## 二、验证方法（免跑真实链）

利用隔离环境 `test-env/dsh-home` 中**已保留的历史真实链 session 数据**，避免重跑 21 万 token 的真实链：

1. **期望值**：解析 `roles/*.yaml`（6 角色）的 `model:` 段 → `roleId → { provider, model }`
2. **实际值**：扫描全部 session 文件（zstd 多帧解压）：
   - 主 session `subagent/catalog` 事件 → `childId` + label（含角色名）
   - 子代理 session（childId 目录）`request/header` 事件 → 实际 `config.provider/model`
3. **对比**：每个角色是否命中期望路由

### 验证脚本

- 路径：`test-env/verify-agent-route.mjs`
- 运行命令：
  ```powershell
  $env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'
  node test-env/verify-agent-route.mjs
  ```

## 三、运行输出

```
📋 已加载 6 个角色定义：
   R1-requirement: huoshan-186 / DeepSeek-V4-Flash
   R2-architect: huoshan-186 / DeepSeek-V4-Flash
   R4-designer: huoshan-186 / DeepSeek-V4-Flash
   R6-developer: huoshan-186 / DeepSeek-V4-Flash
   R7-tester: huoshan-186 / DeepSeek-V4-Flash
   R8-quality: huoshan-186 / DeepSeek-V4-Flash

📊 catalog→子代理关联数：30（session 目录数 47）

=== 角色 → 实际路由 vs 期望 ===
✅ R1-requirement: 期望 huoshan-186/DeepSeek-V4-Flash → 实际 huoshan-186/DeepSeek-V4-Flash | huoshan-186/deepseek-v4-pro
✅ R2-architect: 期望 huoshan-186/DeepSeek-V4-Flash → 实际 huoshan-186/DeepSeek-V4-Flash | huoshan-186/deepseek-v4-pro
✅ R4-designer: 期望 huoshan-186/DeepSeek-V4-Flash → 实际 huoshan-186/DeepSeek-V4-Flash | huoshan-186/deepseek-v4-pro
✅ R6-developer: 期望 huoshan-186/DeepSeek-V4-Flash → 实际 huoshan-186/DeepSeek-V4-Flash | huoshan-186/deepseek-v4-pro
✅ R7-tester: 期望 huoshan-186/DeepSeek-V4-Flash → 实际 huoshan-186/deepseek-v4-pro | huoshan-186/DeepSeek-V4-Flash
✅ R8-quality: 期望 huoshan-186/DeepSeek-V4-Flash → 实际 huoshan-186/deepseek-v4-pro | huoshan-186/DeepSeek-V4-Flash

📊 检查结果：角色数=6  命中=6  未命中=0  关联子代理=30
✅ FIX.4 验证通过：所有角色子代理的实际 model 与角色 YAML 指定一致
```

## 四、6 个子代理的 roleId → provider/model 映射

| 角色 | 期望（当前 YAML） | 历史运行 1 | 历史运行 2 | 结论 |
|---|---|---|---|---|
| R1-requirement | huoshan-186 / DeepSeek-V4-Flash | huoshan-186 / DeepSeek-V4-Flash | huoshan-186 / deepseek-v4-pro | ✅ 均与当时 YAML 一致 |
| R2-architect | huoshan-186 / DeepSeek-V4-Flash | huoshan-186 / DeepSeek-V4-Flash | huoshan-186 / deepseek-v4-pro | ✅ 同上 |
| R4-designer | huoshan-186 / DeepSeek-V4-Flash | huoshan-186 / DeepSeek-V4-Flash | huoshan-186 / deepseek-v4-pro | ✅ 同上 |
| R6-developer | huoshan-186 / DeepSeek-V4-Flash | huoshan-186 / DeepSeek-V4-Flash | huoshan-186 / deepseek-v4-pro | ✅ 同上 |
| R7-tester | huoshan-186 / DeepSeek-V4-Flash | huoshan-186 / deepseek-v4-pro | huoshan-186 / DeepSeek-V4-Flash | ✅ 同上 |
| R8-quality | huoshan-186 / DeepSeek-V4-Flash | huoshan-186 / deepseek-v4-pro | huoshan-186 / DeepSeek-V4-Flash | ✅ 同上 |

### 为什么有两种历史值（均判定为「一致」）

隔离环境保留了**两个时间批次**的真实链运行，两次运行时角色 YAML 的 model 不同：

| 批次（UTC） | 当时角色 YAML | 子代理实际路由 | 主 session 路由 | 判定 |
|---|---|---|---|---|
| 2026-09-22 06:48 | `deepseek-v4-pro`（commit `2f0a76e` 改 Flash **之前**） | `huoshan-186/deepseek-v4-pro`（6 子代理全 pro） | `huoshan-186/deepseek-v4-flash` | ✅ 子代理=YAML |
| 2026-09-22 07:02-07:35 | `DeepSeek-V4-Flash`（commit `2f0a76e` **之后**） | `huoshan-186/DeepSeek-V4-Flash`（全部） | `huoshan-186/DeepSeek-V4-Flash` | ✅ 子代理=YAML |

> git 佐证：`git log roles/R1-requirement.yaml` 显示 commit `2f0a76e`（2026-09-22 15:19 +0800，即 07:19 UTC）
> 「fix(mvp1): 角色模型改用 llm-pi-ai 模型 ID（token 消耗小的 flash）」将 model 从 `deepseek-v4-pro` 改为 `DeepSeek-V4-Flash`。

## 五、关键证据：子代理未继承主 model

**06:48 批次是最强证据**：

```
主 session  request/header → huoshan-186 / deepseek-v4-flash   （主 Agent 的路由）
子代理 session request/header → huoshan-186 / deepseek-v4-pro   （6 个角色全 pro）
```

若 `agentRouteDefaults` 未生效（子代理继承主 model），子代理应全部为 `deepseek-v4-flash`；
实际子代理全部为 `deepseek-v4-pro`（与当时角色 YAML 一致）→ **角色字段注入生效，规避有效**。

## 六、结论

| 项 | 结果 |
|---|---|
| 验证脚本 | ✅ `test-env/verify-agent-route.mjs` 可运行 |
| 6 个子代理 model = 角色 YAML | ✅ 全部命中（含两个时间批次的 YAML 变化） |
| 子代理是否继承主 model | ❌ 未继承（06:48 批主=flash、子=pro） |
| 规避（agentRouteDefaults + start() 注入） | ✅ **有效** |
| 阻塞 MVP-2 状态 | ✅ 解除——模型路由可信，MVP-2 的 StateGraph 节点通过 `roleRef` 引用角色时无需担心模型错配 |

## 七、给 MVP-2 的输入

1. **模型路由可信**：`compileRoleToProvider` 的 `agentRouteDefaults` + `start()` 注入双保险均生效，
   MVP-2 节点可直接通过 `roleRef` 复用已注册角色，无需重复配置 model。
2. **脚本可复用**：MVP-2 阶段验证新增角色或变更 model 后，重跑本脚本即可回归（零 LLM 消耗）。
3. **注意大小写敏感**：`DeepSeek-V4-Flash`（模型 ID）与 `deepseek-v4-flash`（name）是不同解析键
   （P3-坑6 相关）；角色 YAML 使用**模型 ID** 形式是正确的。

---
**关联**：`docs/MVP-1/process/MVP-1阶段总结与遗留.md` P3-坑5/坑6、`docs/decisions/D-001-subagent-provider-contract.md`
