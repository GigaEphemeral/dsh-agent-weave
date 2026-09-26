/**
 * MVP-5 Phase E：Token 分账（总 + 每节点 + 每角色）。
 */
import { describe, expect, it } from 'vitest'
import { createTokenCollector, parseUsageFromSessionLine } from '../../src/l5-observability/token-collector'

describe('createTokenCollector', () => {
  it('record 按节点汇总，按角色聚合，total 正确', () => {
    const c = createTokenCollector()
    c.record('requirement', 'R1-requirement', { inputTokens: 100, outputTokens: 50 })
    c.record('requirement', 'R1-requirement', { inputTokens: 30, outputTokens: 10 })
    c.record('develop', 'R6-developer', { inputTokens: 200, outputTokens: 80, cacheReadTokens: 20 })

    expect(c.byNode('requirement')?.usage.totalTokens).toBe(190)
    expect(c.byRole('R1-requirement').totalTokens).toBe(190)
    expect(c.byRole('R6-developer').totalTokens).toBe(300)
    expect(c.total().totalTokens).toBe(490)
    expect(c.rows()).toHaveLength(2)
  })

  it('merge 合并另一收集器', () => {
    const a = createTokenCollector()
    const b = createTokenCollector()
    a.record('x', 'R1', { inputTokens: 1 })
    b.record('x', 'R1', { inputTokens: 2 })
    a.merge(b)
    expect(a.byNode('x')?.usage.inputTokens).toBe(3)
  })
})

describe('parseUsageFromSessionLine', () => {
  it('解析 assistant/message usage 字段', () => {
    const line = JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, totalTokens: 6 } } })
    expect(parseUsageFromSessionLine(line)).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, totalTokens: 6 })
  })

  it('非 assistant 行返回 null', () => {
    expect(parseUsageFromSessionLine(JSON.stringify({ type: 'tool/call' }))).toBeNull()
  })

  it('非法 JSON 返回 null', () => {
    expect(parseUsageFromSessionLine('not-json')).toBeNull()
  })
})
