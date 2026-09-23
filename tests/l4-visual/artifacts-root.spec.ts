/**
 * artifacts-root.ts 单测（MVP-4 P4.0.3，R45：不硬编码 cwd）。
 *
 * 覆盖：显式优先 / workspace 拼接 productions / cwd 兜底。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolveArtifactsRoot } from '../../src/l4-visual/host/artifacts-root'

describe('P4.0.3 产物根目录解析', () => {
  it('显式路径优先', () => {
    expect(resolveArtifactsRoot({ explicit: 'D:/custom/out' })).toBe('D:/custom/out')
  })

  it('无显式时用 workspace/productions', () => {
    expect(resolveArtifactsRoot({ workspace: 'D:/ws' })).toBe(join('D:/ws', 'productions'))
  })

  it('都缺省时回退 cwd/productions', () => {
    expect(resolveArtifactsRoot()).toBe(join(process.cwd(), 'productions'))
  })
})
