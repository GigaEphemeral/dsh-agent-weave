/**
 * condition-edge.ts 单测（MVP-2 T7 Exit Gate：12 用例全绿）。
 *
 * 覆盖：9 种操作符 / 非法表达式抛错 / 循环回退 / 升级审批 / 条件边优先于静态边 /
 * 无出边终止 / loop 边级 maxIter 熔断。
 */
import { describe, expect, it } from 'vitest'
import {
  ConditionEvalError,
  evaluateCondition,
  resolveNextNode,
  shouldEscalate,
  shouldRetry,
  type LoopEdgeUsage,
} from '../../src/l2-engine/condition-edge'
import type { GraphEdgeSpec } from '../../src/l2-engine/types'

describe('T7 条件表达式求值', () => {
  it('支持 >= 比较', () => {
    expect(evaluateCondition('state.retry_count >= 3', { retry_count: 5 })).toBe(true)
    expect(evaluateCondition('state.retry_count >= 3', { retry_count: 2 })).toBe(false)
  })

  it('支持 === 字符串比较', () => {
    expect(evaluateCondition("state.phase === 'test'", { phase: 'test' })).toBe(true)
    expect(evaluateCondition("state.phase === 'test'", { phase: 'dev' })).toBe(false)
  })

  it('支持 !== 比较', () => {
    expect(evaluateCondition('state.active_agent !== "none"', { active_agent: 'R6' })).toBe(true)
  })

  it('支持 && / || 逻辑', () => {
    expect(evaluateCondition('state.retry_count >= 1 && state.retry_count < 3', { retry_count: 2 })).toBe(true)
    expect(evaluateCondition('state.retry_count >= 3 || state.retry_count <= 0', { retry_count: 5 })).toBe(true)
  })

  it('支持 ! 取反与括号', () => {
    expect(evaluateCondition('!(state.retry_count >= 3)', { retry_count: 1 })).toBe(true)
  })

  it('非法字符（标识符）抛 ConditionEvalError', () => {
    expect(() => evaluateCondition('process.exit(0)', {})).toThrow(ConditionEvalError)
  })

  it('引用缺失字段 → null（自然 false，NEW-5 语义）', () => {
    expect(evaluateCondition('state.missing_field > 3', {})).toBe(false)
  })

  it('shouldRetry / shouldEscalate 边界', () => {
    expect(shouldRetry({ retry_count: 2, max_iterations: 3 })).toBe(true)
    expect(shouldRetry({ retry_count: 3, max_iterations: 3 })).toBe(false)
    expect(shouldEscalate({ retry_count: 3, max_iterations: 3 })).toBe(true)
    expect(shouldEscalate({ retry_count: 2, max_iterations: 3 })).toBe(false)
  })
})

describe('T7 节点路由', () => {
  const edges: GraphEdgeSpec[] = [
    { from: 'develop', to: 'test', type: 'seq' },
    { from: 'test', to: 'quality', type: 'seq' },
    { from: 'quality', to: 'develop', type: 'loop', maxIter: 3 },
    { from: 'quality', to: 'approval', type: 'cond', when: 'state.retry_count >= 3' },
  ]

  it('无出边 → __END__', () => {
    expect(resolveNextNode('approval', edges, {})).toBe('__END__')
  })

  it('seq 边顺序推进', () => {
    expect(resolveNextNode('develop', edges, {})).toBe('test')
    expect(resolveNextNode('test', edges, {})).toBe('quality')
  })

  it('loop 边在 maxIter 内回退', () => {
    const usage: LoopEdgeUsage = { 'quality->develop': 2 }
    expect(resolveNextNode('quality', edges, { retry_count: 2 }, usage)).toBe('develop')
  })

  it('loop 边用尽 → 升级到 approval', () => {
    const usage: LoopEdgeUsage = { 'quality->develop': 3 }
    expect(resolveNextNode('quality', edges, { retry_count: 3 }, usage)).toBe('approval')
  })

  it('loop 边用尽且无 approval → __END__', () => {
    const onlyLoop: GraphEdgeSpec[] = [{ from: 'a', to: 'a', type: 'loop', maxIter: 1 }]
    const usage: LoopEdgeUsage = { 'a->a': 1 }
    expect(resolveNextNode('a', onlyLoop, { retry_count: 1 }, usage)).toBe('__END__')
  })

  it('条件边优先于静态边（cond 满足时走 cond）', () => {
    // test 有 seq→quality 和 cond→approval 两条边；cond 满足 → 走 cond
    const mixed: GraphEdgeSpec[] = [
      { from: 'test', to: 'quality', type: 'seq' },
      { from: 'test', to: 'approval', type: 'cond', when: 'state.retry_count >= 3' },
    ]
    expect(resolveNextNode('test', mixed, { retry_count: 5 })).toBe('approval')
    expect(resolveNextNode('test', mixed, { retry_count: 1 })).toBe('quality')
  })
})
