/**
 * html-report.ts 单测（MVP-2 T13 Exit Gate）。
 *
 * 覆盖：HTML 生成 / Summary 渲染 / SVG 节点染色 / Token 分账表完整。
 */
import { describe, expect, it } from 'vitest'
import { renderHtmlReport, summarizeTokens } from '../../src/l4-visual/host/html-report'
import type { ExecutionSnapshot } from '../../src/l4-visual/host/event-bus'
import type { TrajectoryEvent } from '../../src/l2-engine/types'

function snap(overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    graphId: 'graph-1',
    current: 'dev',
    currentRole: 'R6-developer',
    iteration: 2,
    maxIterations: 25,
    retryCount: 1,
    maxRetry: 3,
    startedAt: 1000,
    elapsedMs: 5000,
    tokenUsed: 300,
    status: 'completed',
    trajectory: [
      { type: 'graph/start', graphId: 'graph-1', timestamp: 1000 },
      { type: 'graph/node-start', graphId: 'graph-1', node: 'dev', timestamp: 1000 },
      {
        type: 'graph/node-end',
        graphId: 'graph-1',
        node: 'dev',
        timestamp: 2000,
        durationMs: 1000,
        data: { tokenUsed: 200, inputTokens: 100, outputTokens: 50, cacheReadTokens: 50, role: 'R6-developer' },
      },
      { type: 'graph/end', graphId: 'graph-1', timestamp: 6000 },
    ],
    nodeStates: { dev: 'completed' },
    ...overrides,
  }
}

describe('T13 HTML 执行报告', () => {
  it('生成完整 HTML 且含 4 个 section', () => {
    const html = renderHtmlReport(snap())
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('执行摘要')
    expect(html).toContain('图结构')
    expect(html).toContain('事件时间线')
    expect(html).toContain('Token 分账')
  })

  it('Summary 显示状态/迭代/耗时/Token', () => {
    const html = renderHtmlReport(snap())
    expect(html).toContain('完成')
    expect(html).toContain('2 / 25')
    expect(html).toContain('5.0s')
    expect(html).toContain('200')
  })

  it('SVG 节点按状态染色（completed → 绿）', () => {
    const html = renderHtmlReport(snap(), [{ from: 'dev', to: 'dev' }])
    expect(html).toContain('<svg')
    expect(html).toContain('#22c55e') // completed 绿
  })

  it('Token 分账表含节点/角色/输入/输出/缓存/合计', () => {
    const tokens = summarizeTokens(snap().trajectory)
    expect(tokens).toHaveLength(1)
    const row = tokens[0]
    expect(row?.node).toBe('dev')
    expect(row?.role).toBe('R6-developer')
    expect(row?.input).toBe(100)
    expect(row?.output).toBe(50)
    expect(row?.cacheRead).toBe(50)
    expect(row?.total).toBe(200)
  })
})
