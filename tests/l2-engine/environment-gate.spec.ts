/**
 * MVP-5 问题 2：Environment Gate 单测（注入 runner，不执行真实命令）。
 */
import { describe, expect, it } from 'vitest'
import { EnvironmentGateError, runPreflightChecks } from '../../src/l2-engine/environment-gate'

describe('runPreflightChecks', () => {
  it('全部满足时通过', async () => {
    const runner = async (cmd: string) => ({ stdout: cmd === 'python --version' ? 'Python 3.14.6' : 'ok', exitCode: 0 })
    await expect(runPreflightChecks([
      { cmd: 'python --version', expect_contains: 'Python 3' },
    ], { nodeName: 'R1-requirement', runCommand: runner })).resolves.toBeUndefined()
  })

  it('输出不包含期望片段 → EnvironmentGateError（环境门禁未过）', async () => {
    const runner = async () => ({ stdout: 'node v22', exitCode: 0 })
    await expect(runPreflightChecks([
      { cmd: 'python --version', expect_contains: 'Python 3' },
    ], { nodeName: 'R6-developer', runCommand: runner })).rejects.toMatchObject({
      name: 'EnvironmentGateError',
      message: expect.stringContaining('环境门禁未过'),
    })
  })

  it('退出码非 0 → EnvironmentGateError', async () => {
    const runner = async () => ({ stdout: '', exitCode: 1 })
    await expect(runPreflightChecks([
      { cmd: 'python --version' },
    ], { nodeName: 'R6-developer', runCommand: runner })).rejects.toBeInstanceOf(EnvironmentGateError)
  })

  it('expect_exit_zero=false 时只看输出', async () => {
    const runner = async () => ({ stdout: 'Python 3.14.6', exitCode: 1 })
    await expect(runPreflightChecks([
      { cmd: 'python --version', expect_exit_zero: false, expect_contains: 'Python 3' },
    ], { runCommand: runner })).resolves.toBeUndefined()
  })

  it('空检查列表直接通过', async () => {
    await expect(runPreflightChecks(undefined, { runCommand: async () => ({ stdout: '', exitCode: 0 }) })).resolves.toBeUndefined()
  })
})
