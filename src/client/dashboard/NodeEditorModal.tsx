/**
 * 节点编辑器浮层（MVP-5B UI 重构：从 CanvasEditor 抽出，由 BoardOverlays 统一挂载）。
 */
import { useState } from 'react'
import type { EditorNode } from './canvas-model.js'

export function NodeEditorModal({
  node, roles, onSave, onDelete, onClose,
}: {
  node: EditorNode
  roles: Array<{ id: string; name: string }>
  onSave: (n: EditorNode) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<EditorNode>({ ...node })

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
