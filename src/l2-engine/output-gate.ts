/**
 * Output Gate（MVP-5 问题 1/3：角色职责越界 + 交付物不可验证；MVP-5B B3：产物扫描回写）。
 *
 * 角色 YAML 可声明 output 约束（仅 .md / 禁止扩展名 / 禁止内容特征）。
 * 节点产物落盘后立即校验；失败抛错 → 引擎分类为 permission-denied → 图暂停。
 *
 * MVP-5B B3 变更：返回 scannedArtifacts（引擎补全 hash/sizeBytes/相对路径），
 * 供引擎把"节点实际产出"回写进 handoff envelope（即使 LLM 未在 front-matter 声明）。
 *
 * 注意：按 MVP-5 决策 #5 移除工作区扫描，Output Gate 只校验节点自身产物目录
 * （职责边界以 SKILL.md 约束 + 工具白名单为主，这里做引擎层兜底）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ArtifactRef } from './handoff-schema.js'

export interface OutputGateOptions {
  /** 产物文件必须为 .md（设计评审类角色）。 */
  only_markdown?: boolean | undefined
  /** 禁止出现的文件扩展名（如 .py / .ts / .bat）。 */
  forbidden_extensions?: string[] | undefined
  /** 禁止出现在产物正文中的正则特征（如 "pip install"、"import fastapi"）。 */
  forbidden_content_patterns?: string[] | undefined
}

export interface OutputGateResult {
  passed: boolean
  failures: string[]
  /** B3：扫描到的节点产物（path 相对 artifactsRoot；hash/sizeBytes 引擎补全）。 */
  scannedArtifacts: ArtifactRef[]
}

/** 扫描选项（B3）。 */
export interface OutputGateScanOptions {
  /** 节点产物目录（绝对路径；扫描该目录下全部文件，不含 handoff.json）。 */
  nodeDir?: string | undefined
  /** 产物根目录（path 相对此根补全；缺省不转换相对路径）。 */
  artifactsRoot?: string | undefined
}

const HANDOFF_FILE = 'handoff.json'

function kindOf(path: string): ArtifactRef['kind'] {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  if (ext === 'md') return 'doc'
  if (['ts', 'js', 'py', 'tsx', 'jsx', 'go', 'rs', 'java', 'c', 'cpp'].includes(ext)) return 'code'
  if (['spec.ts', 'test.ts'].some((s) => path.toLowerCase().endsWith(s))) return 'test'
  if (['sh', 'bat', 'ps1', 'mjs', 'cjs'].includes(ext)) return 'script'
  if (['json', 'yaml', 'yml', 'toml', 'ini', 'env'].includes(ext)) return 'config'
  return 'data'
}

function sha256OfFile(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

/** 扫描节点目录下的产物文件（排除 handoff.json；每个文件补 hash/sizeBytes）。 */
function scanNodeDir(nodeDir: string, artifactsRoot: string | undefined): ArtifactRef[] {
  let entries: string[]
  try {
    entries = readdirSync(nodeDir)
  } catch {
    return []
  }
  const refs: ArtifactRef[] = []
  for (const name of entries) {
    if (name === HANDOFF_FILE) continue
    const abs = join(nodeDir, name)
    if (!existsSync(abs) || !statSync(abs).isFile()) continue
    const path = artifactsRoot ? relative(artifactsRoot, abs).replace(/\\/g, '/') : abs
    refs.push({
      path,
      kind: kindOf(name),
      summary: '',
      hash: sha256OfFile(abs),
      sizeBytes: statSync(abs).size,
    })
  }
  return refs
}

/**
 * 校验节点产物是否越界；同时扫描产物目录（B3）。
 */
export function checkOutputGate(
  gate: OutputGateOptions | undefined,
  artifactPath: string | undefined,
  artifactText: string,
  scan: OutputGateScanOptions = {},
): OutputGateResult {
  const failures: string[] = []
  const lower = artifactPath?.toLowerCase() ?? ''

  if (gate) {
    if (gate.only_markdown === true && !lower.endsWith('.md')) {
      failures.push(`输出门禁未过: 本角色只允许产出 .md 文档，实际 ${artifactPath ?? '(未落盘)'}`)
    }
    for (const ext of gate.forbidden_extensions ?? []) {
      if (lower.endsWith(ext.toLowerCase())) {
        failures.push(`输出门禁未过: 禁止产出 .${ext.replace(/^\./, '')} 文件，实际 ${artifactPath ?? '(未落盘)'}`)
      }
    }
    for (const pattern of gate.forbidden_content_patterns ?? []) {
      if (new RegExp(pattern).test(artifactText)) {
        failures.push(`输出门禁未过: 产物正文出现越界特征 "${pattern}"`)
      }
    }
  }

  const scannedArtifacts = scan.nodeDir ? scanNodeDir(scan.nodeDir, scan.artifactsRoot) : []
  return { passed: failures.length === 0, failures, scannedArtifacts }
}
