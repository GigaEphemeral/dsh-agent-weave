/**
 * MVP-5 问题 2：Environment Gate 单测（注入 runner，不执行真实命令）。
 */
import { describe, expect, it } from 'vitest'
import { EnvironmentGateError, runPreflightChecks } from '../../src/l2-engine/environment-gate'

describe('runPreflightChecks', () => {
  it('全部满足时通过，返回 verified（B3：引擎实测事实回写）', async () => {
    const runner = async (cmd: string) => ({ stdout: cmd === 'python --version' ? 'Python 3.14.6' : 'ok', exitCode: 0 })
    const result = await runPreflightChecks([
      { key: 'env.python.version', cmd: 'python --version', expect_contains: 'Python 3' },
    ], { nodeName: 'R1-requirement', runCommand: runner })
    expect(result.unmet).toEqual([])
    expect(result.verified).toHaveLength(1)
    expect(result.verified[0]).toMatchObject({
      key: 'env.python.version',
      value: 'Python 3.14.6',
      cmd: 'python --version',
      source: 'R1-requirement',
    })
  })

  it('输出不包含期望片段 → EnvironmentGateError（环境门禁未过，携带 unmet）', async () => {
    const runner = async () => ({ stdout: 'node v22', exitCode: 0 })
    const err = await runPreflightChecks([
      { key: 'env.python.version', cmd: 'python --version', expect_contains: 'Python 3', blocking: ['node-b'] },
    ], { nodeName: 'R6-developer', runCommand: runner }).then(
      () => null,
      (e: unknown) => e as EnvironmentGateError,
    )
    expect(err).toBeInstanceOf(EnvironmentGateError)
    expect(err?.message).toContain('环境门禁未过')
    // B3：unmet 结构化信息（供暂停快照）
    expect(err?.unmet[0]).toMatchObject({ key: 'env.python.version', blocking: ['node-b'] })
  })

  it('退出码非 0 → EnvironmentGateError', async () => {
    const runner = async () => ({ stdout: '', exitCode: 1 })
    await expect(runPreflightChecks([
      { cmd: 'python --version' },
    ], { nodeName: 'R6-developer', runCommand: runner })).rejects.toBeInstanceOf(EnvironmentGateError)
  })

  it('expect_exit_zero=false 时只看输出', async () => {
    const runner = async () => ({ stdout: 'Python 3.14.6', exitCode: 1 })
    const result = await runPreflightChecks([
      { cmd: 'python --version', expect_exit_zero: false, expect_contains: 'Python 3' },
    ], { runCommand: runner })
    expect(result.unmet).toEqual([])
    expect(result.verified).toHaveLength(1)
  })

  it('空检查列表直接通过（空 verified/unmet）', async () => {
    const result = await runPreflightChecks(undefined, { runCommand: async () => ({ stdout: '', exitCode: 0 }) })
    expect(result).toEqual({ verified: [], unmet: [] })
  })
})
