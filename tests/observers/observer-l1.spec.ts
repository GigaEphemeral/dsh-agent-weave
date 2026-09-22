/**
 * observer-l1.ts + signal.ts 单测（MVP-2 T15 Exit Gate：6 用例全绿 + 零 Token）。
 *
 * 覆盖：命名规范 / 权限（role 有 roleRef）/ 状态（retry 非负）/ 通过返回 green /
 * 零 Token（模块不 import ctx.llm）/ signal 构造。
 */
import { describe, expect, it } from 'vitest'
import { checkL1 } from '../../src/observers/observer-l1'
import { createObserverSignal } from '../../src/observers/signal'
import type { GraphNodeSpec } from '../../src/l2-engine/types'

const okNode: GraphNodeSpec = { id: 'dev', roleRef: 'R6-developer', nodeType: 'role' }

describe('T15 观察者 L1', () => {
  it('命名规范：非法 ID 被标记', () => {
    const r = checkL1({ ...okNode, id: 'Dev-1' }, {})
    expect(r.passed).toBe(false)
    expect(r.findings.some((f) => f.check === 'naming')).toBe(true)
  })

  it('权限：role 节点缺 roleRef 被标记', () => {
    const r = checkL1({ id: 'dev', nodeType: 'role' }, {})
    expect(r.passed).toBe(false)
    expect(r.findings.some((f) => f.check === 'permission')).toBe(true)
  })

  it('状态：retry_count 为负被标记', () => {
    const r = checkL1(okNode, { retry_count: -1 })
    expect(r.passed).toBe(false)
    expect(r.findings.some((f) => f.check === 'state')).toBe(true)
  })

  it('全部通过返回 green', () => {
    const r = checkL1(okNode, { retry_count: 2 })
    expect(r.passed).toBe(true)
    expect(r.signal).toBe('green')
    expect(r.findings).toHaveLength(0)
  })

  it('零 Token：模块不 import ctx.llm（fail-open 纯函数）', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const source = readFileSync(resolve('src/observers/observer-l1.ts'), 'utf8')
    expect(source).not.toMatch(/import[^;]*ctx\.llm|ctx\.llm\./)
    const signalSource = readFileSync(resolve('src/observers/signal.ts'), 'utf8')
    expect(signalSource).not.toMatch(/import[^;]*ctx\.llm|ctx\.llm\./)
  })

  it('createObserverSignal 构造完整信号（green→silent/minor→log/red→red-signal）', () => {
    const g = createObserverSignal({ observer_id: 'obs-1', observed_node: 'dev', signal_level: 'green', criteria_matched: [], summary: 'ok' })
    expect(g.signal_level).toBe('green')
    expect(g.action).toBe('silent')
    expect(g.token_used).toBe(0)

    const y = createObserverSignal({ observer_id: 'obs-1', observed_node: 'dev', signal_level: 'yellow', criteria_matched: ['x'], summary: 'warn' })
    expect(y.action).toBe('internal-log')
    expect(y.concern_level).toBe('minor')

    const r = createObserverSignal({ observer_id: 'obs-1', observed_node: 'dev', signal_level: 'red', criteria_matched: ['y'], summary: 'bad' })
    expect(r.action).toBe('send-red-signal')
    expect(r.concern_level).toBe('critical')
  })
})
