/**
 * 问题四「图容错」单测。
 *
 * 覆盖：
 * - 修复1：quality_gate 产物验证（非空/至少 N 个/不验证 tsc）
 * - 修复3：内存化图控制（pause/resume/stop/waitForResume）
 * - 引擎接入：质量门失败 → 节点失败 → 整图停（不再空跑后续节点）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createStateGraph } from '../../src/l2-engine/state-graph'
import { validateNodeOutput } from '../../src/l2-engine/node-validator'
import { getGraphControl, clearGraphControl } from '../../src/l2-engine/graph-control'

describe('问题四修复1：quality_gate 产物验证', () => {
  it('产物为空 → 非空门失败', () => {
    const r = validateNodeOutput({}, ['develop.md 非空'])
    expect(r.passed).toBe(false)
    expect(r.failures[0]).toContain('产物为空')
  })

  it('有产物 → 非空门通过', () => {
    const r = validateNodeOutput({ artifacts: { dev: '/a/dev.md' } }, ['develop.md 非空'])
    expect(r.passed).toBe(true)
  })

  it('至少 N 个产物数量校验', () => {
    expect(validateNodeOutput({ artifacts: { a: '1', b: '2' } }, ['至少 3 个代码文件落地']).passed).toBe(false)
    expect(validateNodeOutput({ artifacts: { a: '1', b: '2', c: '3' } }, ['至少 3 个代码文件落地']).passed).toBe(true)
  })

  it('tsc/单测门不拦截（交给角色自身）', () => {
    expect(validateNodeOutput({}, ['tsc 0 error']).passed).toBe(true)
  })
})

describe('问题四修复3：内存化图控制', () => {
  beforeEach(() => clearGraphControl('g-ctrl'))

  it('pause 后 waitForResume 阻塞，resume 唤醒', async () => {
    const ctrl = getGraphControl('g-ctrl')
    ctrl.pause()
    expect(ctrl.isPaused()).toBe(true)
    let resolved = false
    const waiter = ctrl.waitForResume().then(() => { resolved = true })
    await new Promise((r) => setTimeout(r, 30))
    expect(resolved).toBe(false)
    ctrl.resume()
    await waiter
    expect(resolved).toBe(true)
    expect(ctrl.isPaused()).toBe(false)
  })

  it('stop 唤醒等待者并标记 stopped', async () => {
    const ctrl = getGraphControl('g-ctrl')
    ctrl.pause()
    const waiter = ctrl.waitForResume()
    ctrl.stop()
    await waiter
    expect(ctrl.isStopped()).toBe(true)
  })
})

describe('问题四修复1+2：质量门失败 → 整图停', () => {
  it('子代理产物为空（质量门）→ 节点失败 → 后续节点不跑', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-gate-'))
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
          const childId = `child-${++seq}`
          const text = spec.provider === 'R6-developer' ? '' : 'PRD 内容' // dev 产出空
          setTimeout(() => {
            for (const cb of [...endListeners]) {
              cb({ id: childId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text }] })
            }
          }, 0)
          return { childId: childId as never, messageId: 'm' as never }
        },
        sendMessage: async () => 'm' as never,
      },
      effect: (fn: () => unknown) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
      on: (name: string, cb: (info: unknown) => void) => { if (name === 'subagent/end') endListeners.push(cb as never); return () => {} },
      off: (name: string, cb: (info: unknown) => void) => { if (name === 'subagent/end') { const i = endListeners.indexOf(cb as never); if (i >= 0) endListeners.splice(i, 1) } },
    } as never
    try {
      const g = createStateGraph<Record<string, unknown>>(ctx, 25, 8, root)
      g.addSubagent('req', { provider: 'R1-requirement', artifactName: 'prd.md', qualityGate: ['prd.md 非空'] })
      g.addSubagent('dev', { provider: 'R6-developer', artifactName: 'dev.md', qualityGate: ['dev.md 非空'] })
      g.addEdge('req', 'dev')
      const r = await g.run(
        { messages: [], user_input: '任务' } as Record<string, unknown>,
        { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'h', agent: { sessionId: 'p' } as never },
      )
      // dev 产物为空 → 质量门失败 → 图暂停（问题五：可恢复，而非裸 node-error）
      expect(r.success).toBe(false)
      expect(r.error?.message).toContain('质量门未过')
      expect(r.data?.paused).toBe(true)
      // 暂停快照落盘（问题五：供 weave_graph_resume 恢复）
      expect(existsSync(join(root, 'pauses', `${r.graphId}.json`))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('未配 qualityGate 时产物空不拦截（兼容旧行为）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-nogate-'))
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
          const childId = `child-${++seq}`
          setTimeout(() => {
            for (const cb of [...endListeners]) cb({ id: childId, stopReason: 'completed', lastAssistantMessage: [] })
          }, 0)
          return { childId: childId as never, messageId: 'm' as never }
        },
        sendMessage: async () => 'm' as never,
      },
      effect: (fn: () => unknown) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
      on: (name: string, cb: (info: unknown) => void) => { if (name === 'subagent/end') endListeners.push(cb as never); return () => {} },
      off: (name: string, cb: (info: unknown) => void) => { if (name === 'subagent/end') { const i = endListeners.indexOf(cb as never); if (i >= 0) endListeners.splice(i, 1) } },
    } as never
    try {
      const g = createStateGraph<Record<string, unknown>>(ctx, 25, 8, root)
      g.addSubagent('dev', { provider: 'R6-developer', artifactName: 'dev.md' })
      g.addEdge('dev', '__END__')
      const r = await g.run(
        { messages: [], user_input: '任务' } as Record<string, unknown>,
        { checkpoint: async () => {}, graphVersion: '0.1.0', graphSchemaHash: 'h', agent: { sessionId: 'p' } as never },
      )
      expect(r.success).toBe(true) // 无质量门不拦截
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
