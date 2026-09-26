/**
 * Environment Gate（MVP-5 问题 2：异常不退出 + 不传播）。
 *
 * 角色 YAML 声明 environment.preflight；节点启动前执行命令检查环境前提。
 * 不满足 → 抛 EnvironmentGateError → 引擎分类为 environment-gate → 图暂停 → 用户决策。
 * 绝不静默降级。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface PreflightCheck {
  cmd: string
  /** stdout 必须包含的片段（缺省不检查）。 */
  expect_contains?: string | undefined
  /** 是否要求退出码为 0（缺省 true）。 */
  expect_exit_zero?: boolean | undefined
}

export interface RunCommandResult {
  stdout: string
  exitCode: number
}

export type RunCommand = (cmd: string) => Promise<RunCommandResult>

/** 默认命令执行器：Windows 用 cmd /c，其余用 /bin/sh -c。 */
export const defaultRunCommand: RunCommand = async (cmd) => {
  const isWin = process.platform === 'win32'
  const { stdout } = await execFileAsync(isWin ? (process.env.ComSpec ?? 'cmd') : '/bin/sh', isWin ? ['/c', cmd] : ['-c', cmd], {
    timeout: 15_000,
    windowsHide: true,
  })
  return { stdout: String(stdout ?? ''), exitCode: 0 }
}

export class EnvironmentGateError extends Error {
  override readonly name = 'EnvironmentGateError'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

export interface PreflightOptions {
  nodeName?: string
  runCommand?: RunCommand
}

/** 逐条执行环境前提检查；任一条失败立即抛 EnvironmentGateError。 */
export async function runPreflightChecks(
  checks: readonly PreflightCheck[] | undefined,
  options: PreflightOptions = {},
): Promise<void> {
  if (!checks || checks.length === 0) return
  const runner = options.runCommand ?? defaultRunCommand
  for (const check of checks) {
    let result: RunCommandResult
    try {
      result = await runner(check.cmd)
    } catch (error) {
      throw new EnvironmentGateError(
        `环境门禁未过（${options.nodeName ?? '节点'}）: 命令执行失败 ${check.cmd} — ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    const exitOk = check.expect_exit_zero === false ? true : result.exitCode === 0
    const containsOk = check.expect_contains === undefined || result.stdout.includes(check.expect_contains)
    if (!exitOk || !containsOk) {
      const details = [
        check.expect_exit_zero === false ? '' : `退出码 ${result.exitCode}（期望 0）`,
        check.expect_contains !== undefined && !containsOk ? `输出不含 "${check.expect_contains}"` : '',
      ].filter(Boolean).join('，')
      throw new EnvironmentGateError(
        `环境门禁未过（${options.nodeName ?? '节点'}）: ${check.cmd} ${details} — 环境不满足，图暂停等待用户决策（禁止静默降级）`,
      )
    }
  }
}
