/**
 * atomic-merge.ts 单测（MVP-2 T6 Exit Gate：10 用例全绿）。
 *
 * 覆盖：messages 追加 / artifacts 深合并 / retry_count 累加 / 首次写入 /
 * 相同无操作 / 冲突 reject / 冲突不产生部分 state / 3 组结合律。
 */
import { describe, expect, it } from 'vitest'
import { mergeState, MERGEABLE_FIELDS } from '../../src/l2-engine/atomic-merge'

describe('T6 原子合并引擎', () => {
  it('messages 追加合并', () => {
    const r = mergeState(
      { messages: [{ role: 'user', content: 'a' }] },
      { messages: [{ role: 'assistant', content: 'b' }] },
    )
    expect(r.success).toBe(true)
    expect(r.state?.messages).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ])
  })

  it('artifacts 深合并（对象字段合并）', () => {
    const r = mergeState(
      { artifacts: { prd: 'prd.md' } },
      { artifacts: { design: 'design.md' } },
    )
    expect(r.success).toBe(true)
    expect(r.state?.artifacts).toEqual({ prd: 'prd.md', design: 'design.md' })
  })

  it('retry_count 累加', () => {
    const r = mergeState({ retry_count: 1 }, { retry_count: 2 })
    expect(r.success).toBe(true)
    expect(r.state?.retry_count).toBe(3)
  })

  it('首次写入：直接赋值', () => {
    const r = mergeState({ a: 1 }, { b: 2 })
    expect(r.success).toBe(true)
    expect(r.state).toEqual({ a: 1, b: 2 })
  })

  it('值相同：无操作（不报冲突）', () => {
    const r = mergeState({ phase: 'dev' }, { phase: 'dev' })
    expect(r.success).toBe(true)
    expect(r.state?.phase).toBe('dev')
  })

  it('冲突：reject-on-conflict（不可合并字段值不同）', () => {
    const r = mergeState({ phase: 'dev' }, { phase: 'test' })
    expect(r.success).toBe(false)
    expect(r.conflicts).toEqual([{ field: 'phase', prev: 'dev', patch: 'test' }])
  })

  it('冲突时不产生部分 state', () => {
    const r = mergeState({ phase: 'dev', retry_count: 1 }, { phase: 'test', retry_count: 1 })
    expect(r.success).toBe(false)
    expect(r.state).toBeUndefined()
  })

  it('结合律：messages reducer(reducer(a,b),c) === reducer(a,reducer(b,c))', () => {
    const a = { messages: [{ id: 1 }] }
    const b = { messages: [{ id: 2 }] }
    const c = { messages: [{ id: 3 }] }
    const left = mergeState(mergeState(a, b).state as never, c).state
    const right = mergeState(a, mergeState(b, c).state as never).state
    expect(left).toEqual(right)
    expect(left?.messages).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('结合律：artifacts reducer(reducer(a,b),c) === reducer(a,reducer(b,c))', () => {
    const a = { artifacts: { x: 1 } }
    const b = { artifacts: { y: 2 } }
    const c = { artifacts: { z: 3 } }
    const left = mergeState(mergeState(a, b).state as never, c).state
    const right = mergeState(a, mergeState(b, c).state as never).state
    expect(left).toEqual(right)
    expect(left?.artifacts).toEqual({ x: 1, y: 2, z: 3 })
  })

  it('结合律：retry_count reducer(reducer(a,b),c) === reducer(a,reducer(b,c))', () => {
    const a = { retry_count: 1 }
    const b = { retry_count: 2 }
    const c = { retry_count: 3 }
    const left = mergeState(mergeState(a, b).state as never, c).state
    const right = mergeState(a, mergeState(b, c).state as never).state
    expect(left).toEqual(right)
    expect(left?.retry_count).toBe(6)
  })

  it('MERGEABLE_FIELDS 恰好三项', () => {
    expect([...MERGEABLE_FIELDS].sort()).toEqual(['artifacts', 'messages', 'retry_count'])
  })
})
