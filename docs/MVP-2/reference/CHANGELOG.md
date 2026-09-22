# Changelog

## 0.3.1

### Fixed

- **Graph Studio 入口收敛为全屏抽屉（移除设置面板分区）**：`settings.section` 入口移除——StudioView 裸挂在设置面板窄容器里画布严重受限，且与抽屉双入口造成两套"打开 Studio"路径。现在只经全屏抽屉（`shell.overlay`）进入，打开方式三选一：侧边栏底部「Graph Studio」按钮（`sidebar.footer.action` additive 槽位，点击设 hash → hashchange → 抽屉打开）、深链接 `/#graph-studio-open`、独立全屏页 `/graph-studio`。抽屉顶栏补「← 返回」按钮（与「✕ 关闭」等价，收起并清 hash）。
- **路由模式按钮误点不再丢数据**：节点卡片「执行完去哪」的 `setMode` 增加 `nextMode === mode` 早返回——再次点击当前已激活的「固定去 / 按条件走」不再清空用户配置的目标 / 规则并重置为默认值。
- **关闭抽屉中止在途运行**：StudioView 新增卸载清理 effect，关闭抽屉时 abort 在途 AbortController，避免引擎继续空跑、`hostCtx` 事件订阅泄漏与 React setState-after-unmount 警告。
- **节点改名输入接 datalist**：改名输入框加 `list="dshgs-nodelist"`（datalist 此前已渲染但无任何 input 引用），重命名时可从既有节点名自动补全，降低误建重名节点。
- **slash 命令仅支持纯业务节点 + 条件路由**：`registerCommand` 注册含审批门 / 子代理节点的图时直接抛错（fail fast），替代此前"运行时才在无 turn 上下文中失败"的模糊行为——命令执行不在 dsh turn 内，审批请求会被 dsh 以 idle ask 拒绝，子代理需要真实父 Agent 推导会话/谱系/委托深度。含这类节点的图应改用 agent 工具 / 事件处理器 / `agent/inject` 路径执行。新增 `StateGraph.listTurnBoundNodes()` 暴露受限节点清单供校验复用。

## 0.3.0

### Added

- **子代理节点**：`StateGraph.addSubagent(name, options)` 把节点委托给真实 dsh 子代理（`ctx.subagents.start`，需 dsh-subagent 运行时与 `run({ agent })` 提供父 Agent）。支持 `inputMapper` / `prompt` 模板（`{{node}}` / `{{state}}`）/ `outputSchema` 结构化输出（`resultKey`）/ 失败与取消语义（`stopReason`、`diagnostic`、部分输出）/ `agentOptions` / `maxDepth` / `toolFilter` / `persona` 透传；结果收集后自动 `dispose`。
- **子代理模型自动继承**：新增 `resolveSubagentAgentOptions`——默认自动继承父 Agent 模型（`parent.options`，dsh `resolveChildAgentOptions` 语义），父 options 缺 provider/model 时用 `ctx.agentDefaultModel.currentSelection()` **补齐缺失字段**；显式 `agentOptions` **完全覆盖**（优先级：显式 > 父 options > 默认模型兜底）。真实 harness 联调确认：子代理继承的模型可能路由失败（`PI_AI_ERROR`），此时显式指定模型即可。
- **默认 provider 配置**：插件配置新增 `defaultSubagentProvider`（默认 `spawn`），图级 `setSubagentProvider(provider)` 可覆盖；节点级 `options.provider` 优先。
- **输出解析工具**：导出 `subagentResultToPatch` / `subagentOutputText` / `fromSubagentPatch` / `resolveSubagentAgentOptions`，供子代理节点或自定义节点复用。
- **Graph Studio 可视化界面（浏览器 half）**：package.json 新增 `dsh.client` 声明与 `exports["./client"]`；`client/studio.js`（零依赖手写、React.createElement 风格）经 `scripts/build-client.mjs` 与编译后的引擎 CJS 组装为 `lib/client.js`。表单式配置（节点/静态边/条件边/入口/迭代上限）+ SVG DAG 自动布局预览（静态边实线、条件边虚线、回环绕行）+ 浏览器内运行**同一份 StateGraph 引擎**：当前节点高亮、执行计数、逐步轨迹（耗时 + 补丁增量）、终态/错误详情、可停止（AbortSignal）、localStorage 持久化、JSON 导入导出。
- **Graph Studio 两个入口**：设置面板分区（`settings.section`，与「Agent 预设」同层，窄容器快捷查看）+ **全屏抽屉**（`shell.overlay`，root 级覆盖层）：访问 `/#graph-studio-open`（或打开 `/graph-studio-open`）即铺满主界面画布，配置列 480px、DAG 独占剩余约 1400px——开阔视野用于正经设计；点「✕ 关闭」收起并清空 hash。宿主侧 `ctx.get("webServer")` 轮询等待（与 cbx 仪表盘同机制）挂载 `/graph-studio` 与 `/graph-studio-open` 两个路由（单文件 `lib/studio.html`，构建时引擎内联；无 webserver 的 profile 静默跳过）。
- **Graph Studio 易用性重构**：左栏改为「节点卡片流」——每张卡片 = 这个节点做什么 + 执行完去哪（到头/固定去/按条件走单选），边表与条件边表合并进卡片；空状态提供骨架模板（线性流水线/质量门回环）与内置示例一键起步；patch 与 counter.then 改为字段行编辑（设为/自增/判定三种值类型，不再手写 JSON）；全部路由目标改为下拉选择，并行目标按钮式追加；节点改名/删除自动同步所有边、规则目标与入口引用；字段名为空等控件层错误就地标红并阻断运行。
- **Studio JSON DSL**：`StudioGraphSpec`（`patch` / `counter` / `subagent` / `gate` 四类节点 + 规则式条件路由，支持并行目标数组 Fan-out）；`studioValidate` 结构/引用/语义校验（含"条件边优先于静态边"的可达性分析、host-only 节点与不可达节点警告）；`studioBuildGraph` 宿主与浏览器两侧共用（浏览器中 subagent/gate 节点执行到时抛教学错误）；`studioExamples` 内置三示例（代码生成质量门回环 / 并行展开汇聚 / 子代理委托）。patch 值支持 `{"$inc": n}` 自增与 `{"$test": {field, op, value}}` 判定（均基于节点执行前状态快照）。
- **引擎单源共享**：`StateGraph`、graph/* 事件类型与子代理工具抽取到 `src/engine.ts`（公共 API 经 `index.ts` 重导出，形状不变）；随机 id 改用 `globalThis.crypto`，去除唯一 Node 依赖（`node:crypto`），宿主与浏览器跑同一份引擎代码。
- 测试新增 16 项（DSL 判定求值/校验全分支/三示例运行/counter/$inc/$test 快照语义/host-only 教学错误/事件流 + 客户端 bundle 装载契约），共 67 项。

## 0.2.0

首次发布前的完整加固轮。

### Added

- **声明式图定义**：`ctx.graph.fromDefinition(spec)` 与链式 API 等价的对象形式，支持配置驱动与命令集成。
- **dsh 命令集成**：`ctx.graph.registerCommand(def)` 把图注册为 slash 命令（`ctx.commands` 鸭子类型检测，零新依赖）；`rawInput` 默认 JSON 解析为初始状态，执行后返回轨迹文本。
- **节点级 checkpoint**：`run(initialState, { checkpoint })` 每次节点补丁合并后回调 `{ graphId, node, state, iteration }`，宿主可接入 dsh 持久化。
- **审批门节点**：`StateGraph.addApprovalGate(name, options)` 执行前请求 `ctx.approval` 一次性授权（需 dsh-user-approval 插件与 `run({ agent })`；拒绝/取消/无应答按节点错误路径上报）。
- 测试新增 13 项（fromDefinition / registerCommand / checkpoint / approval gate 全分支），共 38 项。

### ⚠️ Breaking / 行为变化

- peer 依赖为 `@deepseek-ai/cordis` `^4.0.1`。
- **取消终态事件统一**：`graph/start` 之后的取消在任意时点都补发一次 `graph/error` 后上抛（节点执行中的取消先发 `graph/node-error` 过程诊断、再发 `graph/error` 终态）。此前取消落点不同则终态事件不一致——节点段只有 `graph/node-error`、路由段 `graph/error`、个别时点甚至没有任何终态事件。`graph/start` 之前的预取消保持无事件。
- `addEdge` / `addConditionalEdge` 对同一 `from` 重复注册由静默覆盖改为抛错（与 `addNode` 一致）。

### Added

- 测试套件（node:test，stub ctx 驱动真实引擎）：线性图/条件边/迭代熔断/异常路径/取消终态/入口与重复注册校验/`logTrajectory` 日志分支。
- CI 增加 `npm run smoke` 步骤。

### Fixed

- **`npm run smoke` 从未执行冒烟脚本**：`node --test` 的默认文件发现不包含 `smoke/` 目录，改为显式 `node smoke/run.mjs`；同时移除会杀死测试进程的 `process.exit(0)`。
- **观察者异常误归类**：`graph/node-end` 的发射原先位于节点 try 块内，`graph/*` 监听器抛错（cordis `emit` 同步传播监听器异常）会被当作节点业务错误上报；已将补丁合并与事件发射移出 try 块，并明确"监听器不得抛错"契约。
- **非法路由目标 double-emit**：校验分支与 catch 各发一次 `graph/error`，改为校验只抛错、由 catch 统一补发。
- 路由非法目标的错误消息对 BigInt/循环引用等不可 JSON 序列化返回值不再自抛 `TypeError`。
- `run()` 内不可达的 `maxIterations` 重复断言移除（构造器已校验且之后不可变）。
- `graphId` 从 3 字节（16M 碰撞域）扩到 8 字节。
- README 修正：示例代码未定义变量、graphId 语义（实例标识 → 每次执行标识）、过期用例数。
- README 措辞收敛（子图/并发汇聚未内置）。
