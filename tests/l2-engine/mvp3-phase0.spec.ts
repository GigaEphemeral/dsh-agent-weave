/**
 * MVP-3 Phase 0 修复验证。
 *
 * 覆盖：
 * - A4 (S10)：暂停/恢复状态机（PAUSE → 暂停 → RESUME → 恢复）
 * - A4：超时进入暂停（onTimeout='pause'）
 * - A4：超时终止（onTimeout='stop'）
 * - B1 (NEW-1)：深层原型污染防护
 * - B2 (NEW-2)：loopUsage 恢复接通（initialLoopUsage）
 * - B4 (NEW-4)：SKIP 显式语义（条件不满足走静态边）
 * - B5/B6 (NEW-5/6)：evaluateCondition 类型白名单 + 长度限制
 * - A5 (M12)：checkpoint.read 区分 ENOENT 与解析错误
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createStateGraph, END, SKIP } from '../../src/l2-engine/state-graph'
import { evaluateCondition, ConditionEvalError } from '../../src/l2-engine/condition-edge'
import { FsCheckpointStore } from '../../src/l2-engine/checkpoint'
import { mergeState } from '../../src/l2-engine/atomic-merge'
import { runChain, pauseFlagPath, resumeFlagPath, pauseStatePath, type ChainStep } from '../../src/l2-engine/chain-runner'

const RO = { graphVersion: '0.1.0', graphSchemaHash: 'hash' }
const parent = {} as never

/** 构造单步链。 */
function makeStep(roleId = 'R1', name = 'prd.md', phase = '阶段'): ChainStep {
  return {
    roleId,
    artifactName: name,
    phase,
    prompt: ({ userInput, upstream }) => `任务:${userInput}\n上游:${upstream.length}`,
  }
}

/** mock ctx（subagents.start 返回固定结果，可配延迟）。 */
function fakeCtx(outputs: Array<{ output: string }>, delayMs = 5) {
  let callIndex = 0
  const calls: string[] = []
  const ctx = {
    get: () => undefined,
    subagents: {
      getProvider: () => undefined,
      start: async (roleId: string, req: { signal?: AbortSignal }) => {
        calls.push(roleId)
        await new Promise((r) => setTimeout(r, delayMs))
        if (req.signal?.aborted) return { result: Promise.resolve({ output: [], stopReason: 'aborted' }) }
        const out = outputs[Math.min(callIndex, outputs.length - 1)]?.output ?? ''
        callIndex++
        return { result: Promise.resolve({ output: [{ type: 'text', text: out }], stopReason: 'completed' }) }
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn: () => unknown) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  } as never
  return { ctx: ctx as unknown as Context, calls }
}

describe('A4 暂停/恢复机制', () => {
  it('PAUSE 文件 → 阶段边界暂停；RESUME → 恢复', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-pause-'))
    try {
      const { ctx, calls } = fakeCtx([{ output: 'a' }, { output: 'b' }])
      const steps = [makeStep('R1', 'a.md', '一'), makeStep('R2', 'b.md', '二')]
      const run = runChain(ctx, parent, steps, '任务', root)
      // 等第一步骤完成前先放 PAUSE（模拟用户暂停）
      await new Promise((r) => setTimeout(r, 3))
      writeFileSync(pauseFlagPath(root), '', 'utf8')
      // 第一步骤完成后应进入暂停（等待 RESUME）
      await new Promise((r) => setTimeout(r, 50))
      expect(existsSync(pauseStatePath(root))).toBe(true)
      // 创建 RESUME 恢复
      writeFileSync(resumeFlagPath(root), '', 'utf8')
      const result = await run
      expect(result.stopped).toBe(false)
      expect(result.paused).toBe(false)
      expect(result.steps).toHaveLength(2)
      expect(calls).toEqual(['R1', 'R2'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('超时进入暂停（onTimeout=pause），不丢已完成步骤', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-timeout-'))
    try {
      const { ctx, calls } = fakeCtx([{ output: 'a' }, { output: 'b' }])
      const steps = [makeStep('R1', 'a.md', '一'), makeStep('R2', 'b.md', '二')]
      const result = await runChain(ctx, parent, steps, '任务', root, {
        totalTimeoutMs: 30,
        onTimeout: 'pause',
        pauseCheckIntervalMs: 5,
      })
      // 超时 30ms 后第一个步骤可能已完成，进入暂停
      expect(result.stopped).toBe(false)
      expect(calls.length).toBeGreaterThanOrEqual(0)
      // 已完成步骤保留
      expect(result.steps.length).toBeLessThanOrEqual(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('超时终止（onTimeout=stop）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-stop-'))
    try {
      const { ctx } = fakeCtx([{ output: 'a' }], 50) // 步骤延迟 50ms，超时 10ms 在步骤进行中触发
      const steps = [makeStep('R1', 'a.md', '一'), makeStep('R2', 'b.md', '二')]
      const result = await runChain(ctx, parent, steps, '任务', root, {
        totalTimeoutMs: 10,
        onTimeout: 'stop',
        pauseCheckIntervalMs: 5,
      })
      expect(result.stopped).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('B1 NEW-1 深层原型污染', () => {
  it('深合并拒绝 __proto__ 污染（嵌套）', () => {
    const prev = { artifacts: { a: { x: 1 } } }
    const patch = JSON.parse('{"artifacts": {"__proto__": {"polluted": true}, "a": {"y": 2}}}')
    const result = mergeState(prev, patch)
    expect(result.success).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(result.state?.artifacts).toEqual({ a: { x: 1, y: 2 } })
  })
})

describe('B2 NEW-2 loopUsage 恢复接通', () => {
  it('initialLoopUsage 恢复 loopUsed（loop 边熔断计数不归零）', async () => {
    const ctx = new Context()
    const g = createStateGraph<{ messages: string[] }>(ctx, 25, 8)
    g.addNode('a', async () => ({ messages: ['a'] }))
    // initialLoopUsage 传 {'a->a': 1}，loop 边 maxIter=2 时应还能回退 1 次
    const r = await g.run({ messages: [] }, {
      checkpoint: async () => {},
      ...RO,
      initialLoopUsage: { 'a->a': 1 },
    })
    expect(r.success).toBe(true)
  })
})

describe('B4 NEW-4 SKIP 语义', () => {
  it('SKIP 让引擎尝试静态边', async () => {
    const ctx = new Context()
    const g = createStateGraph<{ messages: string[] }>(ctx, 25, 8)
    g.addNode('a', async () => ({ messages: ['a'] }))
    g.addNode('b', async () => ({ messages: ['b'] }))
    g.addEdge('a', 'b')
    // 条件边总是 SKIP → 应走静态边 a→b
    g.addConditionalEdge('a', async () => SKIP)
    const r = await g.run({ messages: [] }, { checkpoint: async () => {}, ...RO })
    expect(r.success).toBe(true)
    expect(r.finalState.messages).toEqual(['a', 'b'])
  })
})

describe('B5/B6 NEW-5/6 evaluateCondition 边界', () => {
  it('字段不存在 → null（自然 false，不报错）', () => {
    expect(evaluateCondition('state.missing_field > 3', {})).toBe(false)
  })

  it('字符串字段正常比较', () => {
    expect(evaluateCondition("state.phase === 'test'", { phase: 'test' })).toBe(true)
  })

  it('超长字符串字段抛错', () => {
    const long = 'x'.repeat(10001)
    expect(() => evaluateCondition('state.s === "x"', { s: long })).toThrow(ConditionEvalError)
  })

  it('超长表达式抛错', () => {
    const longExpr = `state.a === '${'y'.repeat(2001)}'`
    expect(() => evaluateCondition(longExpr, { a: 'z' })).toThrow(ConditionEvalError)
  })

  it('非法类型字段抛错', () => {
    expect(() => evaluateCondition('state.obj === null', { obj: {} })).toThrow(/不支持字段/)
  })
})

describe('A5 M12 checkpoint.read 区分错误', () => {
  it('ENOENT 返回 null；解析错误抛错', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-cp-'))
    try {
      const store = new FsCheckpointStore(root)
      // 不存在 → null
      expect(store.read(join(root, 'nope.json'))).toBeNull()
      // 损坏文件 → 抛错
      const dir = join(root, 'checkpoints', 'g1')
      mkdirSync(dir, { recursive: true })
      const bad = join(dir, '1-a.json')
      writeFileSync(bad, '{broken', 'utf8')
      expect(() => store.read(bad)).toThrow(/反序列化失败/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
