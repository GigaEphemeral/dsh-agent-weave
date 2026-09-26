/**
 * MVP-3 Phase F 端到端测试（mock subagent，零 LLM）。
 *
 * 覆盖：真实图执行（addSubagent 流转）→ handoff 交接 → Token 分账 → RunLedger →
 * 暂停恢复（PAUSE/RESUME）。串联 Phase A-E 能力。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStateGraph } from '../../src/l2-engine/state-graph'
import { createHandoff, handoffToText } from '../../src/l2-engine/handoff'
import { createTokenCollector, parseUsageFromSessionLine } from '../../src/l5-observability/token-collector'
import { createRunLedger } from '../../src/l5-observability/run-ledger'
import { createWaitFor, type MessageDelivery } from '../../src/l2-engine/wait-for'
import { createMessageBus } from '../../src/l2-engine/message-bus'

const RO = { graphVersion: '0.1.0', graphSchemaHash: 'hash' }
const fakeAgent = { sessionId: 'parent-1', options: {} }

/** mock ctx.subagents（记录调用 + 可配延迟 + 输出；startContinuable + subagent/end 事件）。 */
function mockCtx(outputs: Record<string, string>, delayMs = 2) {
  const calls: string[] = []
  const endListeners: Array<(info: { id: string; stopReason: string; lastAssistantMessage?: Array<{ type: string; text?: string }> }) => void> = []
  let seq = 0
  const ctx = {
    get: () => undefined,
    emit: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    subagents: {
      list: () => [],
      getProvider: () => undefined,
      startContinuable: async (spec: { provider: string; request: { prompt: Array<{ type: string; text: string }> }; signal?: AbortSignal }) => {
        const provider = spec.provider
        calls.push(provider)
        await new Promise((r) => setTimeout(r, delayMs))
        const text = outputs[provider] ?? `产出-${provider}`
        const childId = `child-${++seq}`
        setTimeout(() => {
          for (const cb of [...endListeners]) {
            cb({ id: childId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text }] })
          }
        }, 0)
        return { childId: childId as never, messageId: 'm1' as never }
      },
      sendMessage: async () => 'm2' as never,
    },
    effect: (fn: () => unknown) => {
      const d = fn()
      return () => { if (typeof d === 'function') d() }
    },
    on: (name: string, cb: (info: unknown) => void) => {
      if (name === 'subagent/end') endListeners.push(cb as never)
      return () => {}
    },
    off: (name: string, cb: (info: unknown) => void) => {
      if (name === 'subagent/end') {
        const i = endListeners.indexOf(cb as never)
        if (i >= 0) endListeners.splice(i, 1)
      }
    },
  } as never
  return { ctx: ctx as never, calls }
}

describe('P3.F 端到端', () => {
  it('真实图流转：需求→R1→R6 双角色，产物+分账+账本', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-e2e-'))
    try {
      const { ctx, calls } = mockCtx({ 'R1-requirement': 'PRD 内容', 'R6-developer': '代码内容' })
      const g = createStateGraph<Record<string, unknown>>(ctx, 25, 8, root)
      g.addSubagent('req', { provider: 'R1-requirement', artifactName: 'prd.md', role: 'R1-requirement' })
      g.addSubagent('dev', { provider: 'R6-developer', artifactName: 'main.py', role: 'R6-developer' })
      g.addEdge('req', 'dev')

      // RunLedger + Token 收集器
      const ledger = createRunLedger()
      const tokens = createTokenCollector()

      const r = await g.run({ messages: [], user_input: '做计算器' } as Record<string, unknown>, {
        checkpoint: async (payload) => {
          ledger.append({ type: 'checkpoint-written', graphId: payload.graphId, node: payload.node, timestamp: Date.now() })
        },
        ...RO,
        agent: fakeAgent as never,
      })
      expect(r.success).toBe(true)
      expect(calls).toEqual(['R1-requirement', 'R6-developer'])
      // 产物落盘（MVP-5B：节点目录 = <root>/<node>，无 graph-artifacts 层）
      expect(existsSync(join(root, 'req', 'prd.md'))).toBe(true)
      expect(existsSync(join(root, 'dev', 'main.py'))).toBe(true)
      // handoff
      const h = createHandoff({ summary: 'PRD 完成', artifacts: ['art://prd.md'], roleId: 'R1-requirement', nodeId: 'req', graphId: 'g', graphVersion: '0.1.0' })
      expect(handoffToText(h)).toContain('PRD 完成')
      // 分账（模拟节点上报）
      tokens.record('req', 'R1-requirement', { inputTokens: 100, outputTokens: 50 })
      tokens.record('dev', 'R6-developer', { inputTokens: 200, outputTokens: 100 })
      expect(tokens.byRole('R6-developer').totalTokens).toBe(300)
      // 账本
      expect(ledger.byGraph(r.graphId).length).toBeGreaterThan(0)
      expect(ledger.events().length).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('等待唤醒：A 等 B 消息，B 完成后唤醒（Phase B 集成）', async () => {
    const wf = createWaitFor<MessageDelivery>()
    const bus = createMessageBus({ sendImpl: async () => 'mid' })
    const p = wf.wait((m) => m.correlation_id === 'c-1')
    // 模拟 B 发消息
    const msg = bus.createMessage({ from: 'B', to: 'A', type: 'handoff', payload: { summary: '完成' }, priority: 'normal', correlation_id: 'c-1' })
    wf.wakeUp({ id: msg.id, correlation_id: msg.correlation_id, from: msg.from, to: msg.to, type: msg.type, payload: msg.payload })
    const got = await p
    expect(got.payload.summary).toBe('完成')
  })

  it('session usage 解析接入分账（RES.1 字段）', () => {
    const u = parseUsageFromSessionLine(JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } } }))
    const t = createTokenCollector()
    t.record('dev', 'R6', u ?? {})
    expect(t.byNode('dev')?.usage.inputTokens).toBe(5)
  })

  it('checkpoint 恢复 + initialLoopUsage（Phase0 NEW-2 端到端）', async () => {
    const { ctx } = mockCtx({})
    const g = createStateGraph<Record<string, unknown>>(ctx, 25, 8)
    g.addSubagent('dev', { provider: 'R6-developer' })
    const r = await g.run({ messages: [] } as Record<string, unknown>, {
      checkpoint: async () => {},
      ...RO,
      agent: fakeAgent as never,
      initialLoopUsage: { 'dev->dev': 1 },
    })
    expect(r.success).toBe(true)
  })
})
