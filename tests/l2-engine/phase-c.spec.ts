/**
 * MVP-3 Phase C 验证：任务树 / handoff / RunLedger / Token 分账。
 * 零 LLM。
 */
import { describe, expect, it } from 'vitest'
import { createTaskTree } from '../../src/l2-engine/task-tree'
import { createHandoff, isValidHandoff, handoffToText } from '../../src/l2-engine/handoff'
import { createRunLedger } from '../../src/l5-observability/run-ledger'
import { createTokenCollector, parseUsageFromSessionLine } from '../../src/l5-observability/token-collector'

describe('P3.C.1 任务树', () => {
  it('根 + 子任务 + 状态 + 子树 + 序列化恢复', () => {
    const t = createTaskTree()
    t.createRoot('做 ETF 工具')
    const c1 = t.addChild('root', { summary: '搭骨架', roleId: 'R6' })
    const c2 = t.addChild('root', { summary: '写测试', roleId: 'R7' })
    expect(c1?.id).toBe('root.0')
    expect(c2?.id).toBe('root.1')
    t.setStatus('root.0', 'completed')
    t.addArtifact('root.0', 'art://main.ts')
    expect(t.get('root.0')?.status).toBe('completed')
    expect(t.subtree('root')).toHaveLength(3)
    expect(t.pending()).toHaveLength(2) // root(pending) + root.1(pending)
    // 序列化恢复
    const json = t.toJSON()
    const t2 = createTaskTree(json)
    expect(t2.get('root.1')?.summary).toBe('写测试')
  })
})

describe('P3.C.2 handoff', () => {
  it('四字段完整 + 校验 + 文本化', () => {
    const h = createHandoff({
      summary: '骨架完成', artifacts: ['art://main.ts'], openIssues: ['补测试'],
      roleId: 'R6', nodeId: 'dev', graphId: 'g1', graphVersion: '0.1.0',
    })
    expect(isValidHandoff(h)).toBe(true)
    expect(h.provenance.roleId).toBe('R6')
    const text = handoffToText(h)
    expect(text).toContain('骨架完成')
    expect(text).toContain('补测试')
    // 非法对象
    expect(isValidHandoff({ summary: 1 })).toBe(false)
  })
})

describe('P3.C.3 RunLedger', () => {
  it('只追加 + 按图过滤 + JSONL 恢复', () => {
    const l = createRunLedger()
    l.append({ type: 'graph/start', graphId: 'g1', timestamp: 1 })
    l.append({ type: 'graph/node-start', graphId: 'g1', node: 'a', timestamp: 2 })
    l.append({ type: 'graph/node-end', graphId: 'g2', node: 'b', timestamp: 3 })
    expect(l.events()).toHaveLength(3)
    expect(l.events()[1]?.seq).toBe(1)
    expect(l.byGraph('g1')).toHaveLength(2)
    // JSONL 恢复
    const l2 = createRunLedger(l.toJSONL())
    expect(l2.events()).toHaveLength(3)
  })
})

describe('P3.C.4 Token 分账', () => {
  it('按节点记录 + 按角色汇总 + 总计 + 合并', () => {
    const c = createTokenCollector()
    c.record('dev', 'R6', { inputTokens: 100, outputTokens: 50 })
    c.record('dev', 'R6', { inputTokens: 30, outputTokens: 20, cacheReadTokens: 10 })
    c.record('test', 'R7', { inputTokens: 200, outputTokens: 100 })
    expect(c.byNode('dev')?.usage.inputTokens).toBe(130)
    expect(c.byRole('R6').totalTokens).toBe(210) // 150 + 60
    expect(c.total().inputTokens).toBe(330)
    // 合并
    const c2 = createTokenCollector()
    c2.record('qa', 'R8', { inputTokens: 50, outputTokens: 50 })
    c.merge(c2)
    expect(c.rows()).toHaveLength(3)
  })

  it('解析 session 行 usage（RES.1 字段）', () => {
    const line = JSON.stringify({ type: 'assistant/message', data: { turn: 1, step: 2, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 3 } } })
    const u = parseUsageFromSessionLine(line)
    expect(u?.inputTokens).toBe(10)
    expect(u?.totalTokens).toBe(15)
    // 非 assistant/message → null
    expect(parseUsageFromSessionLine('{"type":"tool/call"}')).toBeNull()
    expect(parseUsageFromSessionLine('not json')).toBeNull()
  })
})
