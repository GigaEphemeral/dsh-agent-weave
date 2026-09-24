/**
 * 问题五「断点恢复 + 向上通知」单测。
 *
 * 覆盖：
 * - classifyError 分类（permission/dependency/token/fatal）
 * - 引擎 catch：需人工介入 + artifactsRoot → 暂停快照落盘 + emit paused + data.paused
 * - 暂停快照读写/删除
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createStateGraph } from '../../src/l2-engine/state-graph'
import { classifyError } from '../../src/l2-engine/error-classifier'
import { writePauseSnapshot, readPauseSnapshot, removePauseSnapshot } from '../../src/l2-engine/pause-snapshot'

const RO = { graphVersion: '0.1.0', graphSchemaHash: 'hash' }

describe('问题五修复2：错误分类', () => {
  it('permission → permission-denied + 需介入', () => {
    const c = classifyError(new Error('EACCES: permission denied, write D:/x'))
    expect(c.reason).toBe('permission-denied')
    expect(c.needsUserIntervention).toBe(true)
    expect(c.details.deniedOperation).toBe('write D:/x')
  })

  it('not found → dependency-missing', () => {
    expect(classifyError(new Error('command not found: tsc')).reason).toBe('dependency-missing')
  })

  it('token/budget → budget-exceeded', () => {
    expect(classifyError(new Error('token budget exceeded')).reason).toBe('budget-exceeded')
  })

  it('普通错误 → tool-error-fatal', () => {
    expect(classifyError(new Error('boom')).reason).toBe('tool-error-fatal')
  })
})

describe('问题五修复3：引擎 catch 暂停', () => {
  it('节点抛错 + artifactsRoot → 暂停快照落盘 + data.paused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-pause-'))
    const ctx = new Context()
    const g = createStateGraph<Record<string, unknown>>(ctx, 25, 8, root)
    g.addNode('boom', async () => { throw new Error('EACCES: permission denied, write D:/x') })
    g.addEdge('boom', '__END__')
    try {
      const r = await g.run(
        { messages: [] } as Record<string, unknown>,
        { checkpoint: async () => {}, ...RO },
      )
      expect(r.success).toBe(false)
      expect(r.data?.paused).toBe(true)
      expect(r.data?.pauseReason).toBe('permission-denied')
      // 快照落盘
      const snapshotFile = join(root, 'pauses', `${r.graphId}.json`)
      expect(existsSync(snapshotFile)).toBe(true)
      const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'))
      expect(snapshot.pausedNode).toBe('boom')
      expect(snapshot.pauseReason).toBe('permission-denied')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('无 artifactsRoot → 普通 node-error（不落盘）', async () => {
    const ctx = new Context()
    const g = createStateGraph<Record<string, unknown>>(ctx, 25, 8)
    g.addNode('boom', async () => { throw new Error('boom') })
    g.addEdge('boom', '__END__')
    const r = await g.run(
      { messages: [] } as Record<string, unknown>,
      { checkpoint: async () => {}, ...RO },
    )
    expect(r.success).toBe(false)
    expect(r.data?.paused).toBeUndefined()
  })
})

describe('问题五修复4：暂停快照读写', () => {
  const root = join(process.cwd(), 'test-env', 'runs', 'pause-snapshot-spec')
  beforeEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('写 → 读 → 删', () => {
    writePauseSnapshot(root, {
      graphId: 'g1', graphVersion: 'v', graphSchemaHash: 'h',
      pausedNode: 'dev', pausedAt: Date.now(), iteration: 3, resumeFrom: 'dev',
      pauseReason: 'permission-denied', pauseDetails: { error: 'EACCES' },
      state: { messages: ['a'] }, loopUsage: {}, childSessions: { dev: 'child-1' }, completedNodes: ['req'],
    })
    const s = readPauseSnapshot<{ messages: string[] }>(root, 'g1')
    expect(s?.pausedNode).toBe('dev')
    expect(s?.state.messages).toEqual(['a'])
    expect(s?.childSessions.dev).toBe('child-1')
    removePauseSnapshot(root, 'g1')
    expect(readPauseSnapshot(root, 'g1')).toBeNull()
  })
})
