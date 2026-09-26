/**
 * Environment Gate（MVP-5 问题 2：异常不退出 + 不传播；MVP-5B B3：回写结构化结果）。
 *
 * 角色 YAML 声明 environment.preflight；节点启动前执行命令检查环境前提。
 *
 * MVP-5B B3 变更：runPreflightChecks 返回 PreflightResult（verified/unmet），
 * - verified：通过的检查 → VerifiedFact（引擎实测，回写 handoff 供下游"禁止重复探测"）
 * - unmet：未通过的检查 → UnmetRequirement（本次抛错前已记录，供暂停快照/回写）
 * 失败仍抛 EnvironmentGateError（禁止静默降级契约不变）→ 引擎分类为 environment-gate → 图暂停。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { UnmetRequirement, VerifiedFact } from './handoff-schema.js'

const execFileAsync = promisify(execFile)

export interface PreflightCheck {
  /** 事实键（B3：可选；缺省用 cmd 作为 key，便于审计）。 */
  key?: string | undefined
  cmd: string
  /** stdout 必须包含的片段（缺省不检查）。 */
  expect_contains?: string | undefined
  /** 是否要求退出码为 0（缺省 true）。 */
  expect_exit_zero?: boolean | undefined
  /** 未满足时的要求描述（B3：unmet.required）。 */
  required?: string | undefined
  /** 未满足时的建议（B3：unmet.suggestion）。 */
  suggestion?: string | undefined
  /** 被阻塞的下游节点（B3：unmet.blocking）。 */
  blocking?: string[] | undefined
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
  /** B3：未通过的检查（供暂停快照携带结构化信息）。 */
  readonly unmet: UnmetRequirement[]
  constructor(message: string, options?: { cause?: unknown; unmet?: UnmetRequirement[] }) {
    super(message, options)
    this.unmet = options?.unmet ?? []
  }
}

export interface PreflightOptions {
  nodeName?: string
  runCommand?: RunCommand
}

/** B3：门禁回写结果——verified 由引擎实测（回写 handoff），unmet 待用户决策。 */
export interface PreflightResult {
  verified: VerifiedFact[]
  unmet: UnmetRequirement[]
}

function toFactKey(check: PreflightCheck): string {
  return check.key && check.key.trim() !== '' ? check.key : check.cmd
}

/**
 * 逐条执行环境前提检查。
 *
 * - 全部通过：返回 PreflightResult（verified 含每条的 key/value/cmd，source=nodeName）
 * - 任一条不满足：抛 EnvironmentGateError（携带 unmet 明细）→ 图暂停，禁止静默降级
 */
export async function runPreflightChecks(
  checks: readonly PreflightCheck[] | undefined,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const empty: PreflightResult = { verified: [], unmet: [] }
  if (!checks || checks.length === 0) return empty
  const runner = options.runCommand ?? defaultRunCommand
  const verified: VerifiedFact[] = []
  const unmet: UnmetRequirement[] = []

  for (const check of checks) {
    let result: RunCommandResult
    try {
      result = await runner(check.cmd)
    } catch (error) {
      unmet.push({
        key: toFactKey(check),
        required: check.required || '命令可执行',
        suggestion: check.suggestion || `检查命令是否可运行：${check.cmd}`,
        blocking: [...(check.blocking ?? [])],
      })
      continue
    }
    const exitOk = check.expect_exit_zero === false ? true : result.exitCode === 0
    const containsOk = check.expect_contains === undefined || result.stdout.includes(check.expect_contains)
    if (!exitOk || !containsOk) {
      const details = [
        check.expect_exit_zero === false ? '' : `退出码 ${result.exitCode}（期望 0）`,
        check.expect_contains !== undefined && !containsOk ? `输出不含 "${check.expect_contains}"` : '',
      ].filter(Boolean).join('，')
      unmet.push({
        key: toFactKey(check),
        required: check.required || details || '环境前提满足',
        suggestion: check.suggestion || '安装/配置后重试（weave_graph_resume）',
        blocking: [...(check.blocking ?? [])],
      })
      continue
    }
    // 通过 → 引擎实测事实（回写 handoff）
    verified.push({
      key: toFactKey(check),
      value: result.stdout.trim() || 'ok',
      cmd: check.cmd,
      at: Date.now(),
      source: options.nodeName ?? 'environment-gate',
    })
  }

  if (unmet.length > 0) {
    const detail = unmet.map((u) => `${u.key} 需 ${u.required}`).join('，')
    throw new EnvironmentGateError(
      `环境门禁未过（${options.nodeName ?? '节点'}）: ${detail} — 环境不满足，图暂停等待用户决策（禁止静默降级）`,
      { unmet },
    )
  }
  return { verified, unmet: [] }
}
