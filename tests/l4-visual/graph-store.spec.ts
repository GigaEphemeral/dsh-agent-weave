/**
 * MVP-5 Phase B：图保存与复用（CRUD + 复制）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cloneSavedGraph,
  deleteSavedGraph,
  listSavedGraphs,
  loadSavedGraph,
  saveGraph,
  setGraphsDir,
} from '../../src/l4-visual/host/graph-store'
import { buildGraphFromTemplate } from '../../src/l4-visual/host/task-store'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-graphs-'))
  setGraphsDir(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('图存储', () => {
  it('保存 → 列表 → 读取 → 删除', () => {
    const spec = buildGraphFromTemplate('full-sdlc')
    const saved = saveGraph('etf-tool', spec, { name: 'ETF 工具' })
    expect(saved.graphSchemaHash.length).toBeGreaterThan(0)

    const metas = listSavedGraphs()
    expect(metas).toHaveLength(1)
    expect(metas[0]?.id).toBe('etf-tool')
    expect(metas[0]?.name).toBe('ETF 工具')

    const loaded = loadSavedGraph('etf-tool')
    expect(loaded?.spec.nodes).toHaveLength(6)
    expect(loaded?.meta.graphSchemaHash).toBe(saved.graphSchemaHash)

    expect(deleteSavedGraph('etf-tool')).toBe(true)
    expect(listSavedGraphs()).toHaveLength(0)
    expect(loadSavedGraph('etf-tool')).toBeNull()
  })

  it('保存非法图 → 抛错', () => {
    const bad = buildGraphFromTemplate('full-sdlc')
    ;(bad as { nodes?: unknown }).nodes = []
    expect(() => saveGraph('bad', bad)).toThrow()
  })

  it('复制图生成新 id 且内容一致', () => {
    saveGraph('a', buildGraphFromTemplate('quick-dev'), { name: 'A' })
    const r = cloneSavedGraph('a', 'a-copy')
    expect(r.ok).toBe(true)
    const copy = loadSavedGraph('a-copy')
    expect(copy?.spec.nodes.map((n) => n.id)).toEqual(['develop', 'test', 'quality'])
    expect(copy?.meta.name).toContain('复制')
  })
})
