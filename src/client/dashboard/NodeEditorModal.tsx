/**
 * 节点编辑器浮层（MVP-5B UI 重构：从 CanvasEditor 抽出；ui修复2 §P1：节点级覆盖）。
 *
 * 新增两段（ui修复2）：
 * - 【必交文档】三态覆盖角色默认 produces（继承 / 清空 / 覆盖）
 * - 【能力微调】capabilities/tools 只能减不能加（灰显角色没有的）
 */
import { useState } from 'react'
import type { EditorNode } from './canvas-model.js'
import { IOEditor } from './shared/IOEditor.js'

export function NodeEditorModal({
  node, roles, roleDefault, onSave, onDelete, onClose,
}: {
  node: EditorNode
  roles: Array<{ id: string; name: string }>
  /** 角色默认（produces/capabilities/tools），供覆盖显示与「只能减」约束。 */
  roleDefault?: {
    produces?: Array<{ kind: string; name: string; contract?: string }>
    capabilities?: string[]
    tools?: string[]
  }
  onSave: (n: EditorNode) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<EditorNode>({ ...node })

  const setOverride = (patch: Partial<NonNullable<EditorNode['override']>>): void => {
    // exactOptionalPropertyTypes：跳过 undefined 值
    const clean: Partial<NonNullable<EditorNode['override']>> = {}
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (clean as Record<string, unknown>)[k] = v
    }
    setDraft({ ...draft, override: { ...(draft.override ?? {}), ...clean } })
  }

  const roleCaps = roleDefault?.capabilities ?? []
  const roleTools = roleDefault?.tools ?? []
  // 覆盖态能力集：undefined = 继承角色全部
  const overrideCaps = draft.override?.capabilities
  const overrideTools = draft.override?.tools

  const toggleCap = (cap: string): void => {
    const current = overrideCaps ?? roleCaps
    const next = current.includes(cap) ? current.filter((c) => c !== cap) : [...current, cap]
    // 只能减不能加：新加入的必须是角色本有
    setOverride({ capabilities: next.filter((c) => roleCaps.includes(c)) })
  }

  const toggleTool = (tool: string): void => {
    const current = overrideTools ?? roleTools
    const next = current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool]
    setOverride({ tools: next.filter((t) => roleTools.includes(t)) })
  }

  return (
    <div className="weave-modal-mask" onClick={onClose}>
      <div className="weave-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <div className="modal-kicker">节点 / Subagent 配置</div>
            <div className="modal-title">{node.roleName}</div>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </header>

        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label>节点 ID</label>
              <input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
            </div>
            <div className="field">
              <label>角色 (roleRef)</label>
              <select value={draft.roleRef} onChange={(e) => {
                const r = roles.find((x) => x.id === e.target.value)
                setDraft({ ...draft, roleRef: e.target.value, roleName: r?.name ?? e.target.value })
              }}>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.id}</option>)}
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>产物文件名</label>
              <input value={draft.artifactName ?? ''} placeholder={`${draft.id}.md`}
                onChange={(e) => setDraft({ ...draft, artifactName: e.target.value })} />
            </div>
            <div className="field">
              <label>模型覆盖</label>
              <input value={draft.modelOverride ?? ''} placeholder="默认"
                onChange={(e) => setDraft({ ...draft, modelOverride: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>输入门禁（上游节点 ID，逗号分隔）</label>
            <input value={draft.inputGate ?? ''} placeholder="node-a, node-b"
              onChange={(e) => setDraft({ ...draft, inputGate: e.target.value })} />
          </div>

          {/* ★ ui修复2 §P1.2：必交文档（节点级覆盖角色默认） */}
          <div className="field">
            <label>必交文档 <span className="override-badge">覆盖角色默认</span></label>
            <IOEditor
              value={draft.override?.produces}
              onChange={(produces) => setOverride(produces === undefined ? {} : { produces })}
              showInheritOption
            />
          </div>
          {/* ★ ui修复2 §P1.2：能力微调（只能减不能加） */}
          <div className="field">
            <label>能力微调 <span className="override-hint">只能减不能加</span></label>
            <div className="cap-grid">
              {roleCaps.map((cap) => {
                const on = (overrideCaps ?? roleCaps).includes(cap)
                return (
                  <label key={cap} className="checkbox">
                    <input type="checkbox" checked={on} onChange={() => toggleCap(cap)} />
                    {cap}
                  </label>
                )
              })}
              {roleCaps.length === 0 && <span className="io-empty">（角色未声明能力）</span>}
            </div>
          </div>

          {/* ★ ui修复2 §P1.2：工具白名单（只能减不能加） */}
          <div className="field">
            <label>工具白名单 <span className="override-hint">只能减不能加</span></label>
            <div className="cap-grid">
              {roleTools.map((tool) => {
                const on = (overrideTools ?? roleTools).includes(tool)
                return (
                  <label key={tool} className="checkbox">
                    <input type="checkbox" checked={on} onChange={() => toggleTool(tool)} />
                    {tool}
                  </label>
                )
              })}
              {roleTools.length === 0 && <span className="io-empty">（角色未声明工具）</span>}
            </div>
          </div>

          <div className="field">
            <label>输出约束</label>
            <label className="checkbox"><input type="checkbox" checked={draft.onlyMarkdown ?? false}
              onChange={(e) => setDraft({ ...draft, onlyMarkdown: e.target.checked })} /> 仅 .md</label>
            <label className="checkbox"><input type="checkbox" checked={draft.approval ?? false}
              onChange={(e) => setDraft({ ...draft, approval: e.target.checked })} /> 需用户审批</label>
          </div>
        </div>

        <footer className="modal-foot">
          <button className="btn danger" onClick={onDelete} style={{ marginRight: 'auto' }}>删除节点</button>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => onSave(draft)}>保存</button>
        </footer>
      </div>
    </div>
  )
}
