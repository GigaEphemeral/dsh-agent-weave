# RES.4 Cordis 热重载竞态复现报告

> 任务：RES.4 Cordis 热重载竞态复现｜状态：**✅ 完成**｜2026-09-22
> 结论：**复现成功**——非 effect 管理的资源在热重载（dispose+recompose）后泄漏/累积；
> `ctx.effect()` 包装的资源随 fiber.dispose 正常清理。MVP-2 的资源生命周期检查清单（7 项）见 §五。

## 一、复现脚本

- 路径：`test-env/probe-hot-reload.mjs`
- 运行命令：`node test-env/probe-hot-reload.mjs`
- 原理：用真实 Cordis **4.0.2**（与 DSH 0.1.5-rc.2 同版本）内存态 Context 模拟 HMR 机制，
  零 LLM 消耗、不触碰 DSH_HOME。

## 二、复现步骤与结果

### 场景 A：裸 setInterval（非 effect 管理）

```
【场景 A】裸 setInterval（非 effect 管理）
  运行中 ticks=2
  dispose 后 20ms ticks=4（此前 2）→ ❌ 继续运行 = 泄漏
```

插件 `fiber.dispose()`（= HMR 的 dispose 阶段）后，裸定时器**继续 tick**——资源未释放。

### 场景 B：ctx.effect 包装 setInterval（正确写法）

```
【场景 B】ctx.effect 包装 setInterval（正确）
  运行中 ticks=2
  dispose 后 20ms ticks=2（此前 2）→ ✅ 已停止 = 正确清理
```

`ctx.effect(() => { const t = setInterval(...); return () => clearInterval(t) })` 后，
dispose 时 disposer 被调用，定时器停止。

### 场景 C：插件重载（模拟 HMR recompose：dispose 旧 fiber → 新建 fiber）

```
【场景 C】插件重载（模拟 HMR recompose：dispose 旧 fiber → 新建 fiber）
  第 1 轮：leaked=1 managed=1
  重载后：leaked=4 managed=2
  二次重载后：leaked=9 managed=3
  结论：裸资源 leaked=9（多轮重载后持续累积=泄漏）；
        effect 资源 managed=3（仅最后一轮计数=随 dispose 清理）
```

三轮重载后：裸定时器累积到 9 次 tick（每次重载新开一个、旧的永不停），
effect 定时器只有 3 次 tick（每轮 dispose 清理、只计最后一轮）——**泄漏机制与
Discussion #2854 描述一致**。

## 三、HMR recompose 机制确认（源码级）

`cordis-plugin-hmr/lib/index.js`（隔离环境 profiles 中 0.1.5-rc.2）：

```js
const reload = (plugin, runtime) => {
    for (const oldFiber of runtime.fibers) {
        const fiber = oldFiber.parent.registry.plugin(plugin, oldFiber._config, ...); // 重建
        ...
    }
};
// reload 前：this.ctx.registry.delete(plugin)  // dispose 旧 fiber
// reload 后：this.ctx.emit("hmr/reload", reloads)
```

- reload = **dispose 旧 fiber + 重建新 fiber**
- dispose 只清理 **effect 注册**的资源；裸资源（`setTimeout`/`fs.open`/watcher 等）
  不归 Cordis 管 → 泄漏 / 与重建的新实例产生竞态（案例：第三方 bundle 插件 boot 后 ~3s 被静默禁用）

## 四、ctx.effect() 正确用法对照

| 场景 | 错误写法 | 正确写法 |
|---|---|---|
| 定时器 | `setTimeout(fn, 1000)` | `ctx.effect(() => { const t = setTimeout(fn, 1000); return () => clearTimeout(t); })` |
| 文件句柄 | `fs.open(path, 'r', cb)` | `ctx.effect(() => { const fd = fs.openSync(path, 'r'); return () => fs.closeSync(fd); })` |
| watcher | `fs.watch(path, cb)` | `ctx.effect(() => { const w = fs.watch(path, cb); return () => w.close(); })` |

## 五、资源生命周期检查清单（MVP-2 强制，7 项）

| # | 资源类型 | 检查项 | 通过标准 |
|---|---|---|---|
| 1 | 定时器 | 是否用 `ctx.effect()` 包装？ | 所有 `setTimeout` / `setInterval` 都在 effect 中 |
| 2 | 文件句柄 | 是否用 `ctx.effect()` 包装？ | 所有 `fs.open` / `fs.openSync` 都在 effect 中 |
| 3 | 数据库连接 | 是否用 `ctx.effect()` 包装？ | 所有 `new Database()` / 连接池都在 effect 中 |
| 4 | watcher | 是否用 `ctx.effect()` 包装？ | 所有 `fs.watch` / 文件监听都在 effect 中 |
| 5 | Cordis 一等服务 | 是否直接用？ | `ctx.storageDomain` / `ctx.subagents` / `ctx.llm` 直接用（框架管生命周期） |
| 6 | LIFO 释放 | 多个 effect 是否按 LIFO 释放？ | 注册顺序逆序释放（已由 `tests/lifecycle/cordis-effect.spec.ts` 验证） |
| 7 | disposer 幂等 | disposer 是否可重复调用？ | 重复调用无副作用（同上单测验证） |

> **已有单测佐证**：`tests/lifecycle/cordis-effect.spec.ts`（P1.1.7）已覆盖
> disposer 调用 / LIFO / 幂等 / 真实定时器清理 / 异步 effect——RES.4 复现脚本与之互补，
> 专门演示「裸资源 vs effect 资源」在重载场景下的差异。

## 六、结论

| 项 | 结果 |
|---|---|
| 复现脚本可运行 | ✅ `test-env/probe-hot-reload.mjs` |
| Discussion #2854 机制 | ✅ 复现（裸资源重载后泄漏/累积） |
| `ctx.effect()` 正确用法 | ✅ 确认（dispose 自动清理） |
| 资源生命周期检查清单 | ✅ 7 项（见 §五） |
| 阻塞 MVP-2 状态 | ✅ 解除 |

## 七、给 MVP-2 的输入

1. **checkpoint / 并发计数必须遵守此清单**：引擎的迭代计数、超时定时器、RunLedger 句柄
   全部用 `ctx.effect()` 包装；`ctx.storageDomain` 直接用（一等服务）。
2. **热重载测试入门禁**：MVP-2 门禁含「热重载后无资源泄漏」——用本脚本的机制扩展为
   插件级验证（启动隔离 web → 改源码触发热重载 → 检查无泄漏）。
3. **disposer 返回**：effect 回调**必须返回 disposer**（或显式返回清理函数），
   否则与裸资源无异——代码评审检查点。

---
**关联**：`tests/lifecycle/cordis-effect.spec.ts`（P1.1.7）、`docs/探索/04-MVP与设计契约.md` §4.2 资源生命周期约束
