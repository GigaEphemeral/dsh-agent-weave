# FIX.5 max_concurrent_children 映射验证报告

> 任务：FIX.5 验证 `max_concurrent_children` 映射｜状态：**✅ 通过**｜2026-09-22
> 结论：**映射生效**——`max_concurrent_children` 正确映射为 `RoleProfile.depthLimit`（number），
> 并经 `start()` 注入请求的 `maxDepth`。`capabilities.depthLimit` 是布尔能力标志，非数字。

## 一、验证目标

MVP-2 引入并行分支时，`max_concurrent_children` 是防广度爆炸的第一道闸门。
若映射不生效，MVP-2 发现时会很难定位。本任务补单元测试验证映射链路。

## 二、真实契约（role-loader.ts 实现）

```
角色 YAML.max_concurrent_children (number)
    ↓ compileRoleProfile
RoleProfile.depthLimit (number，可选)     ← L92: ...(role.max_concurrent_children > 0 ? { depthLimit: role.max_concurrent_children } : {})
    ↓ compileRoleToProvider.start()
注入请求 maxDepth ← profile.depthLimit      ← L153
capabilities.depthLimit = true（能力标志）  ← L133
```

> **任务草案修正**：草案断言 `provider.capabilities.depthLimit` 应等于数字值（8/1/100）。
> 经查源码，`capabilities.depthLimit` 是**布尔能力标志**（表示「支持深度限制」），数字映射发生在
> `RoleProfile.depthLimit` 与 `start()` 注入的 `maxDepth`。测试按真实契约设计，同时补边界用例。

## 三、测试文件与用例

- 路径：`tests/l3-roles/role-loader.concurrency.spec.ts`
- 运行命令：`pnpm test tests/l3-roles/role-loader.concurrency.spec.ts`
- 用例（7 个）：

| # | 用例 | 输入 max_concurrent_children | 断言 |
|---|---|---|---|
| 1 | depthLimit 映射 | 8 | `profile.depthLimit === 8` |
| 2 | depthLimit 映射（最小） | 1 | `profile.depthLimit === 1` |
| 3 | depthLimit 映射（上限） | 100 | `profile.depthLimit === 100` |
| 4 | capabilities 标志 + start 注入 | 8 | `capabilities.depthLimit === true` 且 `maxDepth === 8` |
| 5 | start 注入（最小） | 1 | `maxDepth === 1` |
| 6 | start 注入（上限） | 100 | `maxDepth === 100` |
| 7 | 边界：0 时不注入 | 0 | `profile.depthLimit === undefined` 且 `maxDepth === undefined` |

## 四、测试结果

```
✓ tests/l3-roles/role-loader.concurrency.spec.ts (7 tests) 63ms
Test Files  1 passed (1)
Tests       7 passed (7)
```

全量回归（新增后）：
```
Test Files  7 passed (7)
Tests       63 passed (63)   ← 原 56 + 新增 7
```

## 五、结论

| 项 | 结果 |
|---|---|
| 单元测试覆盖 | ✅ 3 个常规值 + 3 个注入用例 + 1 个边界 = 7 用例 |
| `depthLimit`（profile）=== `max_concurrent_children` | ✅ 全部一致 |
| `start()` 注入 `maxDepth` === `max_concurrent_children` | ✅ 全部一致 |
| 边界 `max_concurrent_children=0` | ✅ 不注入（语义：无显式限制） |
| 测试通过 | ✅ 7/7，全量回归 63/63 |

## 六、给 MVP-2 的输入

1. **并发设计可信**：Provider 层通过 `maxDepth` 限制子代理深度，MVP-2 并行分支引入时
   `max_concurrent_children` 是第一道闸门，映射已验证。
2. **注意深度 vs 广度**：`maxDepth` 限制的是**子代理嵌套深度**，不是**单层并发子代理数量**。
   官方 `dsh-subagent` 无 `maxConcurrentChildren`（见 RES.5），MVP-2 的**全局并发闸**需引擎层自建
   （项目 README 风险表已列：`max_concurrent_children` + 引擎层全局活跃 child 计数）。
3. **0 语义**：YAML 未配置（0）时不注入 `maxDepth`，由官方默认值（3）兜底——MVP-2 文档需明确此语义。

---
**关联**：`src/l3-roles/role-loader.ts`、`docs/MVP-1.5/process/RES.5-并发上限.md`、项目 README 风险表
