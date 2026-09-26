# MVP-5B 阶段总结（方案 B · 结构化交接单）

> 版本：v1（2026-09-26 第 1 轮）｜状态：✅ 代码层完成（B1-B7 全过，388 测试全绿）
> 依据：`docs/MVP-5B/MVP-5planB.md`（设计定稿）｜前置：MVP-5 代码层完成

## 完成清单（按 planB 批次）

| 批次 | 交付 | 验证 |
|---|---|---|
| **B1 数据结构层** | `handoff-schema.ts`（纯 schema+parseFrontMatter+validateEnvelope）、`handoff.ts` 重写（parse/merge/build+IO+兼容层）、`project-memory.ts` 重写（持有 envelope+新 API+deprecated 兼容） | handoff.spec（22）+ project-memory.spec（6） |
| **B2 引擎接入** | state-graph 节点启动注入 buildHandoffSection、节点完成 parse→write handoff.json→mergeEnvelope；graph-run/resume 接入；节点目录改 `productions/<node>/` | handoff-inject.spec（2，验收 10.2 三场景） |
| **B3 门禁回写** | environment-gate 返回 PreflightResult（verified/unmet+Error.unmet）；output-gate 返回 scannedArtifacts（hash/size）并回写 envelope | environment-gate.spec + mvp5-phase0.spec |
| **B4 角色契约** | 6 个 SKILL.md：全量 front-matter 契约（facts/artifacts/environment/openIssues）+【必读】上游交接单 +【必写】你的交接单；清除演示数据（腾讯/3.14.6） | 反例 10.4#3 平台代码 0 领域术语 |
| **B5 恢复快照** | PauseSnapshot.projectMemorySnapshot（latest+byNode）；resume 优先快照重建、缺省扫描 handoff.json | problem5-resume.spec 新增 1 |
| **B6 前端交互** | provider-registry（dynamic/yaml-scan/static 三级探测）、/providers /capabilities /tools /handoff REST、RoleEditor（全动态候选）、HandoffViewer、常驻挂载 shell.overlay、主区挤压+PATCH drafting、节点编辑器（双击弹窗）、+新建/⚙编辑 | provider-registry.spec（6）+ routes.spec 新增 4 |
| **B7 验收** | verify-mvp5.ps1 更新；全量 388 测试；反例 10.4 检查 | typecheck 0 + build 通过 |

## 代码规模与测试

- 测试总量：**352 → 388**（+36，新增 handoff.spec 22 / handoff-inject 2 / provider-registry 6 / routes +4 / problem5 +1 / phase0 +1）
- `pnpm typecheck`：0 error｜`pnpm build`：通过（client bundle 112KB）
- `test-env/verify-mvp5.ps1`：一键复验

## 关键设计决策落地（planB §7）

| # | 决策 | 落地 |
|---|---|---|
| 1 | handoff.json 由引擎写 | state-graph 完成节点后 writeHandoffJson |
| 5 | front-matter 而非独立 JSON | parseFrontMatter 严格校验（缺必填/非法枚举 → 整段拒绝） |
| 7 | 面板挤压主区而非覆盖 | body.weave-panel-open → main margin-right 720px |
| 8 | 常驻挂载而非依赖 dashboard | 挂真实 Slot 树 `shell.overlay`（文档占位 app.root 不存在） |
| 9 | 进入面板即 drafting | WeaveEditPanel openTask → PATCH status=drafting |
| 11 | 依赖方向严格单向 | schema ← handoff ← project-memory ← state-graph；反例 #4 验证 |

**用户决策**：unmet 合并采用**累积式**（prev 未解决继续传递，curr verified 同 key 才移除）；节点目录按文档改为 `productions/<节点>/`（无 graph-artifacts 中间层）。

## 遗留（真实环境项，用户 3081 实测）

| 项 | 说明 |
|---|---|
| 真实 LLM E2E | 一句话 → weave_propose_task → 面板编辑 → 开始 → 交接单累积 → HandoffViewer 展示 |
| 角色编辑器保存 | 新建角色落盘 roles/<id>.yaml → 角色库可见 → 画布可拖入 |
| handoff 注入实测 | 下游 prompt 含【上游交接单】；上游 verified 不重复探测；unmet 阻塞暂停 |
| 恢复场景 | 暂停 → 恢复后 projectMemorySnapshot 重建，交接单不丢 |
| PR-5.6 自动激活 | shell.overlay 常驻挂载已实现；宿主自动打开看板仍待真实环境确认 |
| mvp1-chain 演示数据 | `src/l2-engine/mvp1-chain.ts` 含 MVP-1 遗留演示术语（腾讯/ETF），planB 反例 #3 平台新代码已 0 术语；该文件为遗留单链演示，未在本阶段重构（B1-B7 范围外） |

## 部署

按用户提供的重部署步骤：清 profile 已装包 → pnpm store prune → 卸载 → 重装 dist/dsh-agent-weave-0.2.9.tgz → `node $dshBin --profile weave-test --port 3081`。
