/**
 * DSH subagent 事件适配层（问题三 A1/A4/A5，探测收敛版）。
 *
 * PR-1/PR-2/PR-3 探测结论（已从 harness 源码确认）：
 * - 真实结束事件：`subagent/end`（Scoped，需 { global: true }；载荷 id=childId + stopReason + lastAssistantMessage）
 * - 真实活动事件：`session/event`（Scoped，需 { global: true }；载荷 (session, event)，event.type ∈ tool/call | tool/result | assistant/message | assistant/attempt）
 * - `startContinuable` 返回 { childId, messageId }（无 result Promise）
 * - `ctx.subagents.interrupt(targetSessionId, authority)` 存在，authority = { kind:'ancestor', agent } | { kind:'user', parentSessionId }
 *
 * 多候选订阅不需要——事件名已确认。
 */
import type { Context } from '@deepseek-ai/cordis'

export interface SubagentActivity {
  kind: 'thinking' | 'tool-call' | 'tool-result' | 'assistant'
  tool?: string
  args?: string
  result?: string
  text?: string
}

export interface SubagentEndPayload {
  output: Array<{ type: string; text?: string }>
  stopReason: string
}

export interface SubagentEventHandlers {
  onActivity?: (activity: SubagentActivity) => void
  onEnd?: (payload: SubagentEndPayload) => void
  onError?: (error: Error) => void
}

/** 安全截断 JSON 片段。 */
function safeJsonSnippet(value: unknown, max = 300): string {
  let s: string
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    s = String(value)
  }
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 从 ContentBlock 数组提取文本。 */
function extractText(blocks: unknown): string {
  if (Array.isArray(blocks)) {
    return blocks
      .map((b) => {
        const blk = b as { type?: string; text?: string }
        return blk?.type === 'text' ? blk.text ?? '' : ''
      })
      .join('\n')
      .trim()
  }
  return ''
}

/**
 * 订阅指定 childId 的结束事件 + 实时活动事件。
 * 返回 disposer（ctx.on 返回值，不访问 ctx.off）。
 */
export function subscribeSubagentEvents(
  ctx: Context,
  childId: string,
  handlers: SubagentEventHandlers,
): () => void {
  const disposers: Array<() => void> = []
  const c = ctx as unknown as {
    on(
      name: string,
      cb: (...args: unknown[]) => void,
      options?: { global?: boolean },
    ): (() => void) | void
  }

  // 结束事件：subagent/end（Scoped，global 监听；载荷 info.id === childId）
  const endDispose = c.on('subagent/end', (info) => {
    const i = info as { id?: string; stopReason?: string; lastAssistantMessage?: Array<{ type: string; text?: string }> }
    if (i.id !== childId) return
    handlers.onEnd?.({
      output: i.lastAssistantMessage ?? [],
      stopReason: i.stopReason ?? 'completed',
    })
  }, { global: true })
  if (typeof endDispose === 'function') disposers.push(endDispose)

  // 活动事件：session/event（Scoped，global；载荷 (session, event)）
  const activityDispose = c.on('session/event', (session, event) => {
    const s = session as { id?: string } | undefined
    if (s?.id !== childId) return
    const e = event as { type?: string; data?: Record<string, unknown> } | undefined
    const data = e?.data ?? {}
    switch (e?.type) {
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : typeof data.tool === 'string' ? data.tool : 'tool'
        handlers.onActivity?.({
          kind: 'tool-call',
          tool: name,
          args: safeJsonSnippet(data.arguments ?? data.input ?? data.params),
        })
        break
      }
      case 'tool/result':
        handlers.onActivity?.({
          kind: 'tool-result',
          tool: typeof data.tool === 'string' ? data.tool : 'tool',
          result: safeJsonSnippet(data.output ?? data.value ?? data.content),
        })
        break
      case 'assistant/message': {
        const text = extractText(data.message ?? data.content)
        if (text) handlers.onActivity?.({ kind: 'assistant', text })
        break
      }
      case 'assistant/attempt': {
        const text = extractText(data.message ?? data.content)
        if (text) handlers.onActivity?.({ kind: 'thinking', text })
        break
      }
      default:
        break
    }
  }, { global: true })
  if (typeof activityDispose === 'function') disposers.push(activityDispose)

  return () => {
    for (const d of disposers) d()
  }
}

/**
 * 停止子代理当前轮次（DSH 原生 interrupt，问题 A4/A5）。
 * authority = { kind: 'ancestor', agent }——调用者必须是目标的活跃祖先 Agent。
 */
export async function interruptSubagent(
  ctx: Context,
  childId: string,
  parentAgent: unknown,
): Promise<void> {
  const subagents = ctx.subagents as unknown as {
    interrupt?: (targetSessionId: string, authority: unknown) => void
  }
  if (typeof subagents.interrupt !== 'function') {
    throw new Error('ctx.subagents.interrupt 不可用（PR-1 探测确认应有）')
  }
  subagents.interrupt(childId, { kind: 'ancestor', agent: parentAgent })
}
