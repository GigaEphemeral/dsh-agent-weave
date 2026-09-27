/**
 * 内置默认图（Bugs-v3：让主 agent 99% 场景不用写 YAML）。
 *
 * 节点 id 用有意义的词（requirement/architecture/design/develop/test/quality），
 * **不写 artifactName**（让角色 YAML 决定：prd.md / arch.md / design.md / ...）。
 */

export const DEFAULT_GRAPH_YAML = `version: "1"
graphVersion: "1.0.0"
graphSchemaHash: "placeholder"
entryPoint: requirement
maxIterations: 25
nodes:
  - { id: requirement,  roleRef: R1-requirement, nodeType: role }
  - { id: architecture, roleRef: R2-architect,   nodeType: role }
  - { id: design,       roleRef: R4-designer,    nodeType: role }
  - { id: develop,      roleRef: R6-developer,   nodeType: role }
  - { id: test,         roleRef: R7-tester,      nodeType: role }
  - { id: quality,      roleRef: R8-quality,     nodeType: role }
edges:
  - { from: requirement,  to: architecture, type: seq }
  - { from: architecture, to: design,       type: seq }
  - { from: design,       to: develop,      type: seq }
  - { from: develop,      to: test,         type: seq }
  - { from: test,         to: quality,      type: seq }
checkpoint: { strategy: node-level, storage: fs }
metadata:
  source: yaml
  createdAt: "2026-09-24T00:00:00Z"
  updatedAt: "2026-09-24T00:00:00Z"
`

export const DEFAULT_GRAPH_FILENAME = 'weave-default.yaml'

export function isPlaceholderHash(hash: string | undefined): boolean {
  return !hash || hash === 'placeholder' || hash === 'demo' || hash === ''
}
