/**
 * MVP-5 问题 4：ProjectMemory + Facts 共享机制单测。
 */
import { describe, expect, it } from 'vitest'
import { extractFactsFromMarkdown, ProjectMemory } from '../../src/l2-engine/project-memory'

describe('extractFactsFromMarkdown', () => {
  it('解析产物顶部 YAML front-matter 的 facts 数组', () => {
    const md = `---\nfacts:\n  - key: env.python.version\n    category: environment\n    value: "3.14.6"\n    confidence: confirmed\n    summary: "Python 3.14.6 已安装"\n  - key: api.tencent.qt.status\n    category: api\n    value: available\n    confidence: confirmed\n    summary: "腾讯行情 API 可达"\n---\n\n# 需求文档\n`
    const facts = extractFactsFromMarkdown(md, 'R1-requirement')
    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({ key: 'env.python.version', category: 'environment', source: 'R1-requirement' })
  })

  it('无 front-matter 时返回空数组', () => {
    expect(extractFactsFromMarkdown('# 普通文档', 'R1-requirement')).toEqual([])
  })

  it('非法 front-matter（非对象/非法 category）被跳过', () => {
    const md = `---\nfacts:\n  - key: ok\n    category: environment\n    value: yes\n    summary: fine\n  - category: unknown\n    value: x\n    summary: no-key\n  - key: bad\n    category: nonsense\n    value: x\n    summary: bad-cat\n---\n`
    const facts = extractFactsFromMarkdown(md, 'R1-requirement')
    expect(facts).toHaveLength(1)
    expect(facts[0]?.key).toBe('ok')
  })
})

describe('ProjectMemory', () => {
  it('setFact 后 toPromptSection 输出注入段落（含来源）', () => {
    const mem = new ProjectMemory()
    mem.setFact({ key: 'env.python.version', category: 'environment', value: '3.14.6', confidence: 'confirmed', summary: 'Python 3.14.6 已安装', source: 'R1-requirement' })
    const section = mem.toPromptSection()
    expect(section).toContain('项目事实（上游已确认，请不要重复探测）')
    expect(section).toContain('✓ Python 3.14.6 已安装  [来自 R1-requirement]')
  })

  it('同 key 不同 value → 后值覆盖并标记 conflict', () => {
    const mem = new ProjectMemory()
    mem.setFact({ key: 'env.python.version', category: 'environment', value: '3.14.6', confidence: 'confirmed', summary: 'Python 3.14.6', source: 'R1-requirement' })
    mem.setFact({ key: 'env.python.version', category: 'environment', value: '3.13.0', confidence: 'confirmed', summary: 'Python 3.13.0', source: 'R2-architect' })
    const all = mem.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.value).toBe('3.13.0')
    expect(all[0]?.confidence).toBe('conflict')
    expect(mem.conflicts()).toHaveLength(1)
    expect(mem.conflicts()[0]?.previous.value).toBe('3.14.6')
  })

  it('setFacts 批量写入并可分类', () => {
    const mem = new ProjectMemory()
    mem.setFacts([
      { key: 'a', category: 'environment', value: '1', confidence: 'confirmed', summary: 'A', source: 'R1' },
      { key: 'b', category: 'api', value: 'ok', confidence: 'confirmed', summary: 'B', source: 'R1' },
    ])
    expect(mem.byCategory().get('environment')).toHaveLength(1)
    expect(mem.byCategory().get('api')).toHaveLength(1)
  })
})
