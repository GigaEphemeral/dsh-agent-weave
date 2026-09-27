/**
 * 共享发现池（Bugs-V1 §7：publish_finding 落盘）。
 *
 * 落盘 `<artifactsRoot>/_shared/<graphId>-findings.jsonl`，一行一 JSON。
 * 下游节点可读最近发现避免重复探测。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Finding } from '../shared/types.js'

const MAX_PER_NODE = 20

export function findingsFile(artifactsRoot: string, graphId: string): string {
  return join(artifactsRoot, '_shared', `${graphId}-findings.jsonl`)
}

/** 追加一条发现（单节点超 20 条 warn 但不拒绝）。返回是否写入。 */
export function appendFinding(
  artifactsRoot: string,
  graphId: string,
  finding: Finding,
  warn?: (msg: string) => void,
): boolean {
  const dir = join(artifactsRoot, '_shared')
  mkdirSync(dir, { recursive: true })
  const file = findingsFile(artifactsRoot, graphId)
  const existing = readRecentFindings(artifactsRoot, graphId)
  const nodeCount = existing.filter((f) => f.node === finding.node).length
  if (nodeCount >= MAX_PER_NODE) {
    warn?.(`节点 ${finding.node} 发现数超上限（${MAX_PER_NODE}），本条未写入`)
    return false
  }
  appendFileSync(file, `${JSON.stringify(finding)}\n`, 'utf8')
  return true
}

/** 读取最近 N 条发现（按时间倒序）。 */
export function readRecentFindings(artifactsRoot: string, graphId: string, limit = 50): Finding[] {
  const file = findingsFile(artifactsRoot, graphId)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Finding
      } catch {
        return null
      }
    })
    .filter((f): f is Finding => f !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
}

/** 可复用发现（reusable !== false）作为下游提示。 */
export function reusableFindingsText(artifactsRoot: string, graphId: string, limit = 20): string {
  const findings = readRecentFindings(artifactsRoot, graphId, limit).filter((f) => f.reusable)
  if (findings.length === 0) return ''
  return (
    `【共享发现池（其他节点已探测，无需重复）】\n` +
    findings
      .map((f) => `  · ${f.what}（${f.node}）\n    方式: ${f.how}\n    结果: ${f.result}`)
      .join('\n')
  )
}
