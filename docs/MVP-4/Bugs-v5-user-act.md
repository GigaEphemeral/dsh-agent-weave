# `ask_user` 完整链路（可直接粘贴）

## 〇、链路总览（11 步）

```
1. subagent 在关键决策点调 ask_user
2. 工具 execute → pendingAskUser.set + 触发 pause trigger
3. pause trigger → interruptSubagent(打断当前 subagent)
4. subagent 被中断 → subagent/end 事件 → waitForSubagentEnd reject
5. addSubagent catch → throw → run() catch
6. run() catch 检查 pendingAskUser → 命中 → 走 ask-user 暂停流程
7. 写 PauseSnapshot（含问题详情）
8. emit graph/paused + notifyMainAgentPaused(带 askQuestion)
9. approval 卡送达主 agent → 呈现给用户
10. 用户回答 → weave_graph_resume additional_context="回答"
11. resumeGraphRealTool → sendMessage(childId, 回答) → subagent 继续
```

---

## 一、改动清单（6 个文件）

| # | 文件 | 类型 |
|---|---|---|
| 1 | `src/l2-engine/ask-user-tool.ts` | **新增** |
| 2 | `src/l2-engine/types.ts` | 加 1 行 |
| 3 | `src/l2-engine/state-graph.ts` | 5 处改动 |
| 4 | `src/index.ts` | 加 2 行 |
| 5 | `src/l3-roles/role-prompt.ts` | 重写 `ASYNC_SUBAGENT_RULES` |
| 6 | `R1-requirement/SKILL.md` | 重写工作方式段落 |

---

## 二、`src/l2-engine/ask-user-tool.ts`（**新增文件**）

```typescript
/**
 * ask_user 工具（Bugs-V5：允许 subagent 主动暂停并向用户提问）。
 *
 * 链路：
 * 1. 工具 execute → pendingAskUser.set + 触发 pause trigger
 * 2. pause trigger → interruptSubagent 打断当前 subagent
 * 3. subagent/end 事件 → waitForSubagentEnd reject → addSubagent throw → run() catch
 * 4. run() catch 检查 pendingAskUser → 命中 → 走 ask-user 暂停流程（写快照 + 通知）
 * 5. 用户回答 → weave_graph_resume additional_context → sendMessage 给同一 childId
 * 6. subagent 收到回答继续
 *
 * 为什么挂 300ms 再返回：给 interruptSubagent 一点时间生效。
 * 即使 subagent 在 300ms 内又做了操作，run() 的 catch 和正常流程都会检查
 * pendingAskUser，都能正确捕获。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { logger } from '../shared/logger.js'

export interface AskUserRequest {
  question: string
  options?: string[]
  default?: string
  impact?: string
}

export interface AskUserContext {
  getNodeCtx: () => { artifactsRoot: string | undefined; graphId: string; nodeId: string }
  triggerPause: (graphId: string, nodeId: string, question: AskUserRequest) => void
}

export function registerAskUserTool(ctx: Context, userCtx: AskUserContext): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'ask_user',
      description:
        '★ 关键决策点，暂停当前图执行，向用户提问。' +
        '\n\n【什么时候用】' +
        '\n- 需求模糊，有多个合理方案，且选择会影响下游大量工作（如"要不要 AI 对战""支持几种难度"）' +
        '\n- 涉及用户偏好/风格选择（如"UI 用暗色还是亮色"）' +
        '\n- 涉及安全/权限/预算/外部依赖的决策' +
        '\n\n【什么时候不用】' +
        '\n- 有行业标准可循（如"五子棋棋盘 15×15"、"俄罗斯方块 10×20"）' +
        '\n- 影响范围小（如"按钮圆角多少像素"）' +
        '\n- 上游已有明确约束（读上游产物即可）' +
        '\n- 一次节点最多问 **3 次**——超过就用默认假设 + 记入产物"待确认问题清单"' +
        '\n\n【调用后会发生什么】' +
        '\n- 当前图**立即暂停**（写暂停快照 + 通过审批卡通知主 agent）' +
        '\n- 用户在主 agent chat 里看到你的问题 + 选项 + 默认 + 影响' +
        '\n- 用户回答后，主 agent 调 weave_graph_resume，你会收到回答继续' +
        '\n- 用户长时间不回答，图会用 default 假设继续（**必须提供 default**）' +
        '\n\n【调用前】先输出一行"[动作] 需要用户决策：<问题摘要>"。',
      parameters: {
        question: {
          type: 'string',
          required: true,
          description: '要问用户什么（清晰、具体、一次一件事；不要问"要不要继续"这类废话）',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：预置选项（供用户快速选择，2-4 个为宜）',
        },
        default: {
          type: 'string',
          description: '默认假设（用户超时不回答时用；强烈建议必填，避免图卡死）',
        },
        impact: {
          type: 'string',
          description: '影响范围（这个决策错了会怎样，帮用户快速判断）',
        },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: value as string }]
        },
      },
      async execute(args) {
        const nodeCtx = userCtx.getNodeCtx()
        if (!nodeCtx.graphId || !nodeCtx.nodeId) {
          return '⚠ 无活动图上下文，ask_user 无法触发暂停'
        }

        const request: AskUserRequest = {
          question: String(args.question),
          ...(args.options !== undefined ? { options: args.options as string[] } : {}),
          ...(args.default !== undefined ? { default: String(args.default) } : {}),
          ...(args.impact !== undefined ? { impact: String(args.impact) } : {}),
        }

        logger.info('weave-ask-user', '节点主动提问，触发图暂停', {
          graphId: nodeCtx.graphId,
          nodeId: nodeCtx.nodeId,
          question: request.question.slice(0, 200),
          hasDefault: !!request.default,
          hasOptions: !!request.options,
        })

        // ★ 触发暂停（内部会写 pendingAskUser + interrupt 当前 subagent）
        userCtx.triggerPause(nodeCtx.graphId, nodeCtx.nodeId, request)

        // ★ 给 interrupt 一点时间生效（即使 subagent 又做了一步也无妨——
        //    run() 的 catch 和正常流程都会检查 pendingAskUser）
        await new Promise((r) => setTimeout(r, 300))

        return '⏸ 已触发图暂停，等待用户决策。请勿继续操作，等待用户回复后图会自动恢复。'
      },
    }),
  )
}
```

---

## 三、`src/l2-engine/types.ts`（**加 1 行**）

**找到 `PauseReason` 类型定义，替换为**：

```typescript
export type PauseReason =
  | 'user-pause' | 'approval-pending' | 'permission-denied'
  | 'dependency-missing' | 'budget-exceeded'
  | 'tool-error-retryable' | 'tool-error-fatal' | 'timeout'
  | 'awaiting-user-input'   // ★ Bugs-V5：节点主动 ask_user 触发的暂停
```

---

## 四、`src/l2-engine/state-graph.ts`（**5 处改动**）

### 改动 1：顶部 import 补 `interruptSubagent`

**找到**：

```typescript
import { waitForSubagentEnd, PauseError } from './subagent-waiter.js'
```

**替换为**：

```typescript
import { waitForSubagentEnd, PauseError } from './subagent-waiter.js'
import { interruptSubagent } from './subagent-events.js'
```

### 改动 2：全局表 + `getAskUserContext` 导出

**找到**（`currentNodeCtx` 定义附近）：

```typescript
/** ★ v2.0 Phase E：当前节点上下文（publish_finding 用；handler 前后设置）。 */
let currentNodeCtx: { artifactsRoot: string | undefined; graphId: string; nodeId: string } | null = null
export function getCurrentNodeCtx(): { artifactsRoot: string | undefined; graphId: string; nodeId: string } {
  return currentNodeCtx ?? { artifactsRoot: undefined, graphId: '', nodeId: '' }
}
```

**在它后面追加**：

```typescript
// ═══════════════════════════════════════════════════════════════
// ★ Bugs-V5：ask_user 支持
// ═══════════════════════════════════════════════════════════════

interface AskUserQuestion {
  question: string
  options?: string[]
  default?: string
  impact?: string
}

/** 待处理的 ask_user 请求（graphId → 请求详情）。 */
const pendingAskUser = new Map<string, {
  nodeId: string
  question: AskUserQuestion
  at: number
}>()

/** pause trigger 表（graphId → 触发函数）。 */
const graphPauseTriggers = new Map<string, (nodeId: string, question: AskUserQuestion) => void>()

/** ask_user 工具上下文（供 index.ts 注册工具用）。 */
export function getAskUserContext(): {
  getNodeCtx: () => { artifactsRoot: string | undefined; graphId: string; nodeId: string }
  triggerPause: (graphId: string, nodeId: string, question: AskUserQuestion) => void
} {
  return {
    getNodeCtx: () => currentNodeCtx ?? { artifactsRoot: undefined, graphId: '', nodeId: '' },
    triggerPause: (graphId, nodeId, question) => {
      // 1. 记录待处理请求（引擎 catch/正常流程读取）
      pendingAskUser.set(graphId, { nodeId, question, at: Date.now() })
      // 2. 触发当前节点的 pause trigger（内部会 interrupt subagent）
      const trigger = graphPauseTriggers.get(graphId)
      if (trigger) {
        trigger(nodeId, question)
      } else {
        logger.warn('weave-ask-user', 'pause trigger 未注册（节点可能已结束）', { graphId, nodeId })
      }
    },
  }
}
```

### 改动 3：`addSubagent` 内注册 pause trigger

**找到 `addSubagent` 里 `if/else` 分支结束后、`waitForSubagentEnd` 调用之前**（即 `activeChildId` 已赋值、`effectiveSignal` 定义处附近）：

```typescript
          // ★ 步骤3：新 waiter 订阅活动 → 转发 graph/node-activity / idle-warning / loop-detected
          // （问题三 A3：无硬超时；A4/A5：中止 → interrupt；D2/D3：循环/空闲仅提示）
          // ★ Bugs-V1 §9.4：图级控制信号优先（graphSignal）；缺省用 run signal
          const effectiveSignal = nodeCtx.graphSignal ?? signal
          result = await waitForSubagentEnd(nodeCtx.ctx, activeChildId, {
```

**在这段之前插入**：

```typescript
          // ★ Bugs-V5：注册 pause trigger（供 ask_user 工具调用）
          graphPauseTriggers.set(nodeCtx.graphId, (triggerNodeId, question) => {
            if (triggerNodeId !== name) {
              logger.warn('weave-ask-user', 'trigger 的 nodeId 与当前节点不符', {
                graphId: nodeCtx.graphId, expected: name, actual: triggerNodeId,
              })
              return
            }
            logger.info('weave-ask-user', 'pause trigger 触发，interrupt 当前 subagent', {
              graphId: nodeCtx.graphId, node: name, childId: activeChildId,
            })
            // ★ 打断当前 subagent：subagent/end 事件 → waitForSubagentEnd reject
            // → addSubagent throw → run() catch → 检查 pendingAskUser → 走 ask-user 暂停
            void interruptSubagent(nodeCtx.ctx, activeChildId, agent).catch((err) => {
              logger.warn('weave-ask-user', 'interrupt 失败', {
                childId: activeChildId,
                error: err instanceof Error ? err.message : String(err),
              })
            })
          })
```

### 改动 4：`run()` 正常流程检查 `pendingAskUser`

**找到 `run()` 里 `emit({ type: 'graph/node-end', ... })` 那整段**（合并 state 之后、checkpoint 之前）：

```typescript
          // S13：node-end 携带 token/retry 数据（供终端视图/HTML 报告）
          emit({
            type: 'graph/node-end',
            graphId,
            node: current,
            timestamp: Date.now(),
            durationMs: Date.now() - startTime,
            data: {
              ...(pending.usage ? { ... } : {}),
              ...(pending.retry !== null ? { retryCount: pending.retry } : {}),
            },
          })

          // RES.10 §一.4 + S4：checkpoint 在"补丁合并后、跳转前"
          await options.checkpoint({ ... })
```

**在 `emit node-end` 之后、`await options.checkpoint` 之前插入**：

```typescript
          // ★ Bugs-V5：检查 ask_user（subagent 主动提问 → 图暂停）
          if (pendingAskUser.has(graphId)) {
            const askReq = pendingAskUser.get(graphId)!
            pendingAskUser.delete(graphId)
            logger.info('weave', '图暂停（等待用户决策）', {
              graphId, node: current,
              question: askReq.question.question.slice(0, 200),
              path: 'normal-flow',
            })

            if (artifactsRoot) {
              try {
                const snapshot: PauseSnapshot<T> = {
                  graphId,
                  graphVersion: options.graphVersion,
                  graphSchemaHash: options.graphSchemaHash,
                  pausedNode: current,
                  pausedAt: Date.now(),
                  iteration,
                  resumeFrom: current,
                  pauseReason: 'awaiting-user-input',
                  pauseDetails: {
                    suggestedAction: `请回答节点 ${current} 的问题：${askReq.question.question}`,
                    contextTemplate: JSON.stringify(askReq.question),
                  },
                  state,
                  loopUsage: Object.fromEntries(loopUsed),
                  childSessions: Object.fromEntries(childIdByNode),
                  completedNodes: [...completedNodes],
                }
                writePauseSnapshot(artifactsRoot, snapshot)
              } catch (snapErr) {
                logger.warn('weave', '暂停快照落盘失败', {
                  graphId,
                  error: snapErr instanceof Error ? snapErr.message : String(snapErr),
                })
              }
            }

            emit({
              type: 'graph/paused',
              graphId,
              node: current,
              timestamp: Date.now(),
              data: {
                reason: 'awaiting-user-input',
                question: askReq.question,
                resumeFrom: current,
              },
            })

            await notifyMainAgentPaused(ctx, options.agent, {
              graphId,
              node: current,
              reason: 'awaiting-user-input',
              ...(artifactsRoot !== undefined ? { artifactsRoot } : {}),
              askQuestion: askReq.question,
            })

            return {
              graphId, success: true, finalState: state, trajectory, iterations: iteration,
              data: {
                paused: true,
                reason: 'awaiting-user-input',
                resumeFrom: current,
                question: askReq.question,
              },
            }
          }
```

### 改动 5：`run()` 的 catch 分支优先检查 `pendingAskUser`

**找到 `run()` 里 `} catch (error) {` 开头**：

```typescript
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          // ★ 问题三 B1/A4+A5 + Bugs-V1 §9.4：用户暂停（PauseError）→ 写快照 + graph/paused
          if (error instanceof PauseError) {
```

**在 `const err = ...` 之后、`if (error instanceof PauseError)` 之前插入**：

```typescript
          // ★ Bugs-V5：优先检查 ask_user（subagent 被 interrupt 导致 reject）
          if (pendingAskUser.has(graphId)) {
            const askReq = pendingAskUser.get(graphId)!
            pendingAskUser.delete(graphId)
            logger.info('weave', '图暂停（等待用户决策）', {
              graphId, node: current,
              question: askReq.question.question.slice(0, 200),
              path: 'catch-flow',
            })

            if (artifactsRoot) {
              try {
                const snapshot: PauseSnapshot<T> = {
                  graphId,
                  graphVersion: options.graphVersion,
                  graphSchemaHash: options.graphSchemaHash,
                  pausedNode: current,
                  pausedAt: Date.now(),
                  iteration,
                  resumeFrom: current,
                  pauseReason: 'awaiting-user-input',
                  pauseDetails: {
                    suggestedAction: `请回答节点 ${current} 的问题：${askReq.question.question}`,
                    contextTemplate: JSON.stringify(askReq.question),
                  },
                  state,
                  loopUsage: Object.fromEntries(loopUsed),
                  childSessions: Object.fromEntries(childIdByNode),
                  completedNodes: [...completedNodes],
                }
                writePauseSnapshot(artifactsRoot, snapshot)
              } catch (snapErr) {
                logger.warn('weave', '暂停快照落盘失败', {
                  graphId,
                  error: snapErr instanceof Error ? snapErr.message : String(snapErr),
                })
              }
            }

            emit({
              type: 'graph/paused',
              graphId,
              node: current,
              timestamp: Date.now(),
              data: {
                reason: 'awaiting-user-input',
                question: askReq.question,
                resumeFrom: current,
              },
            })

            await notifyMainAgentPaused(ctx, options.agent, {
              graphId,
              node: current,
              reason: 'awaiting-user-input',
              ...(artifactsRoot !== undefined ? { artifactsRoot } : {}),
              askQuestion: askReq.question,
            })

            return {
              graphId, success: true, finalState: state, trajectory, iterations: iteration,
              data: {
                paused: true,
                reason: 'awaiting-user-input',
                resumeFrom: current,
                question: askReq.question,
              },
            }
          }

          // ★ 用户暂停（PauseError）——原有逻辑继续
          if (error instanceof PauseError) {
```

### 改动 6：`run()` 结束时清理 + `notifyMainAgentPaused` 增强

**`run()` 结尾清理**（`emit({ type: 'graph/end', ...})` 之后）：

```typescript
      emit({ type: 'graph/end', graphId, timestamp: Date.now() })
      clearGraphControl(graphId)
      clearGraphNodeChildren(graphId)
      graphParentAgents.delete(graphId)
      // ★ Bugs-V5：清理 ask_user 状态
      graphPauseTriggers.delete(graphId)
      pendingAskUser.delete(graphId)
      return { graphId, success: true, finalState: state, trajectory, iterations: iteration }
```

**`run()` 里其他 return 点**（stopped / paused / failed 分支）也各自加两行：

```typescript
      graphPauseTriggers.delete(graphId)
      pendingAskUser.delete(graphId)
```

**`notifyMainAgentPaused` 整段替换**（文件末尾）：

```typescript
/**
 * ★ 图暂停时通知主 agent。
 *
 * 双通道：approval 卡（主 agent 立即感知）+ PAUSED 文件（前端 SSE 兜底）。
 * Bugs-V5：加 askQuestion 参数，生成问答式通知。
 */
async function notifyMainAgentPaused(
  ctx: Context,
  agent: unknown,
  info: {
    graphId: string
    node: string
    reason: string
    artifactsRoot?: string
    /** ★ Bugs-V5：ask_user 问题详情。 */
    askQuestion?: AskUserQuestion
  },
): Promise<void> {
  let reasonText: string

  if (info.askQuestion) {
    const q = info.askQuestion
    const lines: string[] = [
      `❓ 图 ${info.graphId} 在节点 ${info.node} **等待你的决策**：`,
      '',
      `【问题】`,
      q.question,
    ]
    if (q.options && q.options.length > 0) {
      lines.push('', '【选项】')
      for (const opt of q.options) lines.push(`  · ${opt}`)
    }
    if (q.default) {
      lines.push('', `【默认假设（超时不答时使用）】`, q.default)
    }
    if (q.impact) {
      lines.push('', `【影响范围】`, q.impact)
    }
    lines.push(
      '',
      '【如何回答】',
      `调用 weave_graph_resume graph_id=${info.graphId} additional_context="<你的回答>"`,
      '',
      '【主 agent 必读】',
      '1. 把上面的问题和选项**原样呈现给用户**，等待用户明确回答。',
      '2. 用户回答后，调 weave_graph_resume 并把回答放进 additional_context。',
      '3. 禁止自动重跑整图（重复消耗 token）。',
      '4. 用户长时间不回答也不催——图已暂停，不会自动往下跑。',
    )
    reasonText = lines.join('\n')
  } else {
    reasonText =
      `⚠ 图 ${info.graphId} 已在节点 ${info.node} 暂停（${info.reason}）。\n` +
      `图执行循环已停止，不会再创建下一步子代理。\n\n` +
      `【主 agent 必读】\n` +
      `1. 向用户报告暂停位置与原因，等待用户明确指示。\n` +
      `2. 禁止自动调用 weave_run_graph 重跑整个图（重复消耗 token）。\n` +
      `3. 用户指示继续时，调用 weave_graph_resume graph_id=${info.graphId}。\n` +
      `4. 用户指示放弃时，无需进一步操作。`
  }

  const approvalService = ctx.get('approval') as ApprovalServiceLike | undefined
  if (approvalService && agent) {
    try {
      await approvalService.request({
        agent,
        toolName: info.askQuestion ? 'weave.ask_user' : 'weave.graph.paused',
        reason: reasonText,
      })
      logger.info('weave', '已通过 approval 通知主 agent', {
        graphId: info.graphId,
        kind: info.askQuestion ? 'ask-user' : 'paused',
      })
      return
    } catch (err) {
      logger.warn('weave', 'approval 通知失败，走 fallback', {
        graphId: info.graphId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (info.artifactsRoot) {
    try {
      writeFileSync(join(info.artifactsRoot, 'PAUSED'), reasonText, 'utf8')
      logger.info('weave', '已写 PAUSED 文件（fallback）', { graphId: info.graphId })
    } catch (err) {
      logger.warn('weave', '写 PAUSED 失败', {
        graphId: info.graphId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
```

---

## 五、`src/index.ts`（**加 2 行**）

**顶部 import 补**（把原 `getCurrentNodeCtx` 那行合并）：

```typescript
import { registerAskUserTool } from './l2-engine/ask-user-tool.js'
import { getCurrentNodeCtx, getAskUserContext } from './l2-engine/state-graph.js'
```

**在 `registerPublishFindingTool(ctx, () => getCurrentNodeCtx())` 之后加**：

```typescript
  // ★ Bugs-V5：ask_user 工具（subagent 主动暂停问用户）
  registerAskUserTool(ctx, getAskUserContext())
```

---

## 六、`src/l3-roles/role-prompt.ts`（**重写 `ASYNC_SUBAGENT_RULES`**）

**找到**：

```typescript
/** ★ 问题6：异步 subagent 工作方式（所有角色适用）。 */
export const ASYNC_SUBAGENT_RULES = `【工作方式（所有角色适用）】
你是异步 subagent，没有与用户对话的通道。
- ❌ 不要"停下来等用户回答"——没有任何机制把回答送回来
- ❌ 不要输出"请用户确认 xxx 后再继续"——图不会因此暂停
- ✅ 遇到不明确：先按合理假设继续（标 ⚠️ + 证据等级）
- ✅ 把本该问用户的问题写入产物的"待确认问题清单"章节
- ✅ 主 agent 会把产物呈现给用户，用户回答后可决定是否重跑/resume`
```

**替换为**：

```typescript
/** ★ Bugs-V5：异步 subagent 工作方式（允许主动提问）。 */
export const ASYNC_SUBAGENT_RULES = `【工作方式（所有角色适用）】
你是异步 subagent，但**可以通过 ask_user 工具主动向用户提问**。

✅ **什么时候用 ask_user**（关键决策点）：
- 需求模糊，有**多个合理方案**，且选择会**影响下游大量工作**
  （例：五子棋"要不要 AI 对战""分几档难度"；俄罗斯方块"要不要多人模式"）
- **涉及用户偏好/风格**（例："UI 暗色还是亮色""中文还是英文界面"）
- **涉及安全/权限/预算/外部依赖**（例："允许调用外部 API 吗""预算上限多少"）

❌ **什么时候不用**：
- 有**行业标准**可循（"五子棋 15×15"、"俄罗斯方块 10×20"、"黑先白后"）
- **影响范围小**（"按钮圆角多少像素"）
- **上游已有明确约束**（读上游产物即可）

【调用 ask_user 时】
- 必须提供 default（用户超时不回答时用）—— 否则图会卡死
- 必须提供 impact（帮用户快速判断影响）
- 一次只问一件事；可给 2-4 个选项
- 一次节点**最多问 3 次**（超过用 default + 记入"待确认问题清单"）
- 调用前先输出"[动作] 需要用户决策：<问题摘要>"

【不用 ask_user 时】
- 小不确定：先按合理假设继续（标 ⚠️ + 证据等级）
- 所有不确定的假设，写入产物的"待确认问题清单"章节
`
```

---

## 七、`R1-requirement/SKILL.md`（**段落重写**）

**找到"## ⚠️ 你是异步 subagent —— 没有与用户对话的通道"这一整段，替换为**：

```markdown
## ⚠️ 工作方式：主动决策 + 主动提问

你是异步 subagent，但**可以通过 `ask_user` 工具主动向用户提问**。

### ✅ 什么时候用 ask_user

**关键决策点**（符合任一即用）：
- 需求模糊，**多个合理方案**，且选择会**影响下游大量工作**
- **涉及用户偏好/风格**（UI 色系、界面语言、交互方式）
- **涉及安全/权限/预算/外部依赖**

**典型场景**（五子棋为例）：
- ❓ "是否需要人机对战？"（影响：开发工作量 +1~2 天）
- ❓ "AI 难度分几档？"（选项：简单/中等/困难；影响：AI 算法复杂度）
- ❓ "是否需要禁手规则？"（影响：判定逻辑复杂度）
- ❓ "UI 风格偏好？"（选项：极简/拟物/暗色科技）

### ❌ 什么时候不用 ask_user

- **有行业标准**（五子棋棋盘 15×15、黑先白后、无禁手为默认）
- **影响范围小**（按钮圆角、字体大小）
- **上游已有明确约束**

### 📋 不用 ask_user 时

- 小不确定：**先按合理假设继续**（在产物里标 ⚠️ + 证据等级）
- 所有假设写入 `## 待确认问题清单` 章节

### 🔢 数量限制

**每个节点最多问 3 次**。超过 3 次就用默认假设，剩下的都记入"待确认问题清单"。

**为什么**：用户不是客服，一次问 10 个问题会烦死。挑**最重要的 1-3 个**问。

### 📞 ask_user 调用格式

```
[动作] 需要用户决策：是否需要人机对战

ask_user({
  question: "五子棋是否需要人机对战模式？",
  options: ["需要（AI 分简单/中等/困难三档）", "不需要（纯双人对战）"],
  default: "需要（AI 分三档）",
  impact: "若不支持 AI，开发工作量减少约 1~2 天；若支持，需要额外设计 AI 算法（R2 架构阶段会细化）"
})
```

**调用后**：图立即暂停 → 用户在主 agent chat 里看到问题 → 用户回答 → 图继续 → 你会收到回答。

**如果你不调用 ask_user**：按 `default` 假设继续，把该问题写入产物"待确认问题清单"。
```

---

## 八、落地步骤

### 1. 编译 + 打包 + 重装

```powershell
cd D:\dsharness\agentDev\softwareEngnieering\3pluginCode
pnpm build
npm pack --pack-destination ./dist
dsh plugin --profile weave-test add ./dist/dsh-agent-weave-*.tgz
```

### 2. 重启 + 浏览器 Ctrl+Shift+R

### 3. 验证

| # | 操作 | 期望日志 |
|---|---|---|
| 1 | 跑一个**模糊需求**的图（如只输入"做个游戏"） | `weave-ask-user` 组件日志出现 |
| 2 | — | `节点主动提问，触发图暂停` |
| 3 | — | `pause trigger 触发，interrupt 当前 subagent` |
| 4 | — | `图暂停（等待用户决策）`（path: normal-flow 或 catch-flow） |
| 5 | — | `已通过 approval 通知主 agent { kind: 'ask-user' }` |
| 6 | 主 agent chat | 出现 `❓ 图在节点 xxx 等待你的决策：...` |
| 7 | 用户回答 → 主 agent 调 resume | `weave_graph_resume additional_context="回答"` |
| 8 | — | `已向暂停节点子代理发送恢复通知` |
| 9 | — | subagent 收到回答继续跑 |

---

## 九、边界与防护

| 风险 | 防护 |
|---|---|
| subagent 滥用 `ask_user`（每步都问） | prompt 明示"最多 3 次"；后续可在工具里加计数器 |
| 用户不回答，图永久卡 | `default` 必填（prompt 强调）；主 agent 后续可 resume |
| interrupt 打断失败 | `triggerPause` 里 `.catch` 记日志；即使失败，`pendingAskUser` 已 set，subagent 正常结束时也会被 catch |
| subagent 在 interrupt 前又做一步 | 工具挂 300ms 等 interrupt；**且** `run()` 的 catch 和正常流程都检查 `pendingAskUser`，两种路径都能捕获 |
| resume 后 subagent 上下文没接到回答 | `weave_graph_resume` 已支持 `additional_context` 通过 `sendMessage` 发给同一 childId（现成机制） |
| 多节点同时 ask | 单图模式串行执行，`pendingAskUser` 按 graphId 隔离 |

---

## 十、链路设计要点（为什么这样设计）

| 设计决策 | 原因 |
|---|---|
| **工具只写 `pendingAskUser`，不直接 await approval** | approval 只支持"批准/拒绝"，不能传自由文本回答；用 interrupt + resume 支持任意文本 |
| **工具挂 300ms 后返回** | 给 `interruptSubagent` 时间生效；避免工具永久挂起导致 DSH 侧认为 subagent 未结束 |
| **`run()` 的两处（正常 + catch）都检查 `pendingAskUser`** | 覆盖两种情况：① interrupt 生效（走 catch）② subagent 收到工具返回后正常结束（走正常流程） |
| **问题详情存 `pauseDetails.contextTemplate`** | 复用现有 `PauseSnapshot` 字段（原本就是 string 类型），不新增字段 |
| **`approval.toolName` 用 `weave.ask_user`** | 与普通 `weave.graph.paused` 区分，主 agent 能识别"这是问答题不是通知" |
| **`weave_graph_resume` 的 `additional_context` 承载用户回答** | 复用现有机制，`buildResumePrompt` 已支持拼接到 prompt 里 |

**这套实现完全复用现有基础设施**（`interruptSubagent` / `waitForSubagentEnd` / `PauseSnapshot` / `notifyMainAgentPaused` / `weave_graph_resume` / `sendMessage`），**只新增一个工具 + 一张状态表 + 两处检查**。