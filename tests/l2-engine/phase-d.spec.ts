/**
 * Phase D 控制集成单测（MVP-4 P4.D.1/P1-3/P4.B.7）。
 *
 * 覆盖：
 * - PAUSE 文件 → 节点边界暂停；RESUME（删 PAUSE）→ 恢复续跑
 * - STOP 文件 → 立即终止
 * - approvalPolicy 走分级审批（allowed / 拒绝）
 * - observer 信号写 ledger + emit observer-signal
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createStateGraph } from '../../src/l2-engine/state-graph'
import { createRunLedger } from '../../src/l5-observability/run-ledger'

interface DemoState extends Record<string, unknown> {
  messages: string[]
  retry_count: number
}

const ROOT = join(process.cwd(), 'test-env', 'runs', 'phase-d-spec')

describe('P4.D.1 图级暂停/恢复/终止', () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(ROOT, { recursive: true })
  })

  it('PAUSE 文件 → 节点边界暂停；删 PAUSE → 恢复续跑', async () => {
    const ctx = new Context()
    const events: string[] = []
    const g = createStateGraph<DemoState>(ctx, 25, 8, ROOT, (evt) => events.push(evt.type))
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addEdge('a', '__END__')
    // 节点 a 执行前写入 PAUSE
    writeFileSync(join(ROOT, 'PAUSE'), '', 'utf8')
    const runPromise = g.run(
      { messages: [], retry_count: 0 },
      { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' },
    )
    // 150ms 后删除 PAUSE 触发恢复
    setTimeout(() => rmSync(join(ROOT, 'PAUSE'), { force: true }), 150)
    const result = await runPromise
    expect(result.success).toBe(true)
    expect(result.finalState.messages).toEqual(['a'])
    // 至少出现一次 paused 标记
    expect(events).toContain('graph/end')
    expect(result.data?.stopped).toBeUndefined()
  })

  it('STOP 文件 → 节点边界立即终止（success）', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx, 25, 8, ROOT)
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addEdge('a', '__END__')
    writeFileSync(join(ROOT, 'STOP'), '', 'utf8')
    const result = await g.run(
      { messages: [], retry_count: 0 },
      { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' },
    )
    expect(result.success).toBe(true)
    expect(result.data?.stopped).toBe(true)
  })
})

describe('P1-3 审批策略接入', () => {
  it('approvalPolicy allowed 放行', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx, 25, 8)
    g.addApprovalGate('gate1', { toolName: 't', reason: 'r', required: true })
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addEdge('gate1', 'a')
    g.addEdge('a', '__END__')
    const result = await g.run(
      { messages: [], retry_count: 0 },
      {
        checkpoint: async () => {},
        graphVersion: '0.1.0',
        graphSchemaHash: 'hash',
        approvalPolicy: {
          gate: async () => ({ outcome: 'allowed', audit: '批准' }),
        },
      },
    )
    expect(result.success).toBe(true)
  })

  it('approvalPolicy 拒绝 → 审批门抛错', async () => {
    const ctx = new Context()
    const g = createStateGraph<DemoState>(ctx, 25, 8)
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addApprovalGate('gate1', { toolName: 't', reason: 'r', required: true })
    g.addEdge('a', 'gate1')
    const result = await g.run(
      { messages: [], retry_count: 0 },
      {
        checkpoint: async () => {},
        graphVersion: '0.1.0',
        graphSchemaHash: 'hash',
        approvalPolicy: {
          gate: async () => ({ outcome: 'rejected', audit: '拒绝' }),
        },
      },
    )
    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('未通过')
  })
})

describe('P4.B.7 观察者信号写 ledger', () => {
  it('signaled → ledger observer-signal + emit', async () => {
    const ctx = new Context()
    const ledger = createRunLedger()
    const emitted: string[] = []
    const g = createStateGraph<DemoState>(
      ctx, 25, 8, undefined,
      (evt) => emitted.push(evt.type),
      ledger,
      undefined,
      {
        observe: (_node, _state) => ({ signaled: true, signal: { signal_level: 'yellow', observed_node: 'a', summary: '有关注项' } }),
      },
    )
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addEdge('a', '__END__')
    const result = await g.run(
      { messages: [], retry_count: 0 },
      { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'hash' },
    )
    expect(result.success).toBe(true)
    expect(emitted).toContain('graph/observer-signal')
    const sigs = ledger.events().filter((e) => e.type === 'observer-signal')
    expect(sigs).toHaveLength(1)
    expect((sigs[0]?.data as { signal_level?: string }).signal_level).toBe('yellow')
  })
})
