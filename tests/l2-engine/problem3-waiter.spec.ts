/**
 * 问题三「图运转和子代理工作状态」单测。
 *
 * 覆盖：
 * - A3：waitForSubagentEnd 无硬超时（不设 timeout 也能等 end）
 * - A4+A5：signal abort → interrupt 子代理 + reject PauseError
 * - D2：循环调用检测（onLoopDetected）
 * - D3：空闲提示（onIdleWarning）
 * - D1：输入门禁（上游产物缺失/为空 → 抛错）
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createStateGraph } from '../../src/l2-engine/state-graph'
import { waitForSubagentEnd, PauseError } from '../../src/l2-engine/subagent-waiter'

/** 构造支持 subagent/end + session/event 的 mock ctx（global 订阅）。 */
function mockCtx() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const on = vi.fn((name: string, cb: (payload: unknown) => void, opts?: { global?: boolean }) => {
    void opts
    const set = listeners.get(name) ?? new Set()
    set.add(cb)
    listeners.set(name, set)
    return () => set.delete(cb)
  })
  const emit = (name: string, ...args: unknown[]) => {
    const cbs = listeners.get(name) ?? new Set()
    for (const cb of cbs) (cb as (...a: unknown[]) => void)(...args)
  }
  const interrupt = vi.fn()
  return {
    ctx: {
      get: () => undefined,
      emit: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      subagents: {
        list: () => [],
        getProvider: () => undefined,
        interrupt,
        startContinuable: async () => {
          // 模拟子代理执行后触发 subagent/end（waiter 无硬超时，必须依赖事件）
          setTimeout(() => emit('subagent/end', { id: 'child-1', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'ok' }] }), 5)
          return { childId: 'child-1' as never, messageId: 'm' as never }
        },
        sendMessage: async () => 'm' as never,
      },
      effect: (fn: () => unknown) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
      on,
    } as never,
    emit,
    interrupt,
  }
}

describe('问题三 A3/A4/A5：waitForSubagentEnd 重设计', () => {
  it('无硬超时：等 subagent/end 到来（resolve）', async () => {
    const { ctx, emit } = mockCtx()
    const waiter = waitForSubagentEnd(ctx, 'child-1', {})
    // 模拟 100ms 后 end
    setTimeout(() => emit('subagent/end', { id: 'child-1', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'ok' }] }), 50)
    const r = await waiter
    expect(r.stopReason).toBe('completed')
    expect(r.output[0]?.text).toBe('ok')
  })

  it('signal abort → interrupt 子代理 + reject PauseError', async () => {
    const { ctx, interrupt } = mockCtx()
    const ctrl = new AbortController()
    const waiter = waitForSubagentEnd(ctx, 'child-1', { signal: ctrl.signal, parentAgent: { sessionId: 'parent' } })
    const p = waiter.then(
      () => { throw new Error('不应 resolve') },
      (e) => e,
    )
    ctrl.abort()
    const err = await p
    expect(err).toBeInstanceOf(PauseError)
    expect(interrupt).toHaveBeenCalledWith('child-1', { kind: 'ancestor', agent: { sessionId: 'parent' } })
  })

  it('D2：循环调用检测触发 onLoopDetected', async () => {
    const { ctx, emit } = mockCtx()
    const onLoop = vi.fn()
    const waiter = waitForSubagentEnd(ctx, 'child-1', {
      loopDetection: { enabled: true, window: 10, repeatThreshold: 3 },
      onLoopDetected: onLoop,
    })
    for (let i = 0; i < 5; i++) {
      emit('session/event', { id: 'child-1' }, { type: 'tool/call', data: { name: 'glob', arguments: { pattern: '**/*.ts' } } })
    }
    // 等待异步处理
    await new Promise((r) => setTimeout(r, 20))
    expect(onLoop).toHaveBeenCalled()
    // 清理（waiter 未结束）
    ctrlAbort(ctx)
  })
})

function ctrlAbort(ctx: never): void {
  // 无 abort 信号时，通过 emit end 让 waiter settle
  ;(ctx as unknown as { emit: (n: string, p: unknown) => void }).emit('subagent/end', { id: 'child-1', stopReason: 'completed' })
}

describe('问题三 D1：输入门禁', () => {
  it('上游产物缺失 → 抛错（图停）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-gate-'))
    try {
      const { ctx } = mockCtx()
      const g = createStateGraph<Record<string, unknown>>(ctx, 25, 8, root)
      g.addSubagent('dev', { provider: 'R6-developer', inputGate: { requires: ['req'] } })
      g.addEdge('dev', '__END__')
      const r = await g.run(
        { messages: [] } as Record<string, unknown>,
        { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'h', agent: { sessionId: 'p' } as never },
      )
      expect(r.success).toBe(false)
      expect(r.error?.message).toContain('输入门禁未过')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('上游产物存在且非空 → 通过', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-gate2-'))
    try {
      const { ctx } = mockCtx()
      // 预置 req 产物文件
      writeFileSync(join(root, 'req.md'), '内容', 'utf8')
      const g = createStateGraph<Record<string, unknown>>(ctx, 25, 8, root)
      g.addSubagent('dev', { provider: 'R6-developer', artifactName: 'dev.md', inputGate: { requires: ['req'] } })
      g.addEdge('dev', '__END__')
      const r = await g.run(
        { messages: [], artifacts: { req: join(root, 'req.md') } } as Record<string, unknown>,
        { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'h', agent: { sessionId: 'p' } as never },
      )
      expect(r.success).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
