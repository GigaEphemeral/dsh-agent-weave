/**
 * MVP-5B：ProjectMemory 重写后的兼容层单测。
 *
 * 行为变更（相对 MVP-5）：
 * - toPromptSection() 转发 buildHandoffSection（结构化交接单格式，非旧"项目事实"格式）
 * - conflicts() 返回 ProjectFact[]（confidence === 'conflict'），不再返回 FactConflict[]
 * - front-matter 解析改为严格校验（任一条非法 → 整段 null，不部分解析）
 */
import { describe, expect, it } from 'vitest'
import { extractFactsFromMarkdown, ProjectMemory } from '../../src/l2-engine/project-memory'

describe('extractFactsFromMarkdown（兼容）', () => {
  it('解析产物顶部 YAML front-matter 的 facts 数组', () => {
    const md = `---\nfacts:\n  - key: env.python.version\n    category: environment\n    value: "3.14.6"\n    confidence: confirmed\n    summary: "Python 3.14.6 已安装"\n  - key: api.tencent.qt.status\n    category: api\n    value: available\n    confidence: confirmed\n    summary: "腾讯行情 API 可达"\n---\n\n# 需求文档\n`
    const facts = extractFactsFromMarkdown(md, 'R1-requirement')
    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({ key: 'env.python.version', category: 'environment', source: 'R1-requirement' })
  })

  it('无 front-matter 时返回空数组', () => {
    expect(extractFactsFromMarkdown('# 普通文档', 'R1-requirement')).toEqual([])
  })

  it('非法 front-matter（缺必填/非法 category）→ 空数组（严格全拒）', () => {
    const md = `---\nfacts:\n  - key: ok\n    category: environment\n    value: yes\n    summary: fine\n  - category: unknown\n    value: x\n    summary: no-key\n  - key: bad\n    category: nonsense\n    value: x\n    summary: bad-cat\n---\n`
    // 严格校验：含非法条目 → 整段拒绝（不再部分跳过）
    expect(extractFactsFromMarkdown(md, 'R1-requirement')).toEqual([])
  })
})

describe('ProjectMemory（兼容层）', () => {
  it('setFact 后 toPromptSection 输出结构化交接单段（含来源）', () => {
    const mem = new ProjectMemory()
    mem.setFact({ key: 'env.python.version', category: 'environment', value: '3.14.6', confidence: 'confirmed', summary: 'Python 3.14.6 已安装', source: 'R1-requirement' })
    const section = mem.toPromptSection()
    // 新格式：buildHandoffSection（facts 不直接渲染为 prompt 段落——prompt 用的是 environment.verified）
    // 兼容层只保证 API 不崩、返回字符串；具体注入格式以 buildHandoffSection 为准（见 handoff.spec）
    expect(section).toContain('【上游交接单】')
    expect(mem.all()).toHaveLength(1)
  })

  it('同 key 不同 value → 后值覆盖并标记 conflict', () => {
    const mem = new ProjectMemory()
    mem.setFact({ key: 'env.python.version', category: 'environment', value: '3.14.6', confidence: 'confirmed', summary: 'Python 3.14.6', source: 'R1-requirement' })
    mem.setFact({ key: 'env.python.version', category: 'environment', value: '3.13.0', confidence: 'confirmed', summary: 'Python 3.13.0', source: 'R2-architect' })
    const all = mem.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.value).toBe('3.13.0')
    expect(all[0]?.confidence).toBe('conflict')
    // 新形态：conflicts() 返回 ProjectFact[]（conflict 项）
    const conflicts = mem.conflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.value).toBe('3.13.0')
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
