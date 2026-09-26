/**
 * 看板浮层容器（MVP-5B UI 重构）：用户确认 / 角色编辑 / 节点编辑。
 *
 * 通过 window CustomEvent 解耦（各 Tab/Pane 派发，这里统一挂载渲染）：
 * - weave:open-role-editor：{ roleId? } → RoleEditor
 * - weave:open-node-editor：{ nodeId, node, roles } → NodeEditorModal
 * - weave:node-saved / weave:node-deleted：保存/删除后回发事件给 CanvasEditor
 */
import { useEffect, useState } from 'react'
import { UserQuestionModal } from '../dashboard/UserQuestionModal.js'
import { RoleEditor } from '../dashboard/RoleEditor.js'
import { NodeEditorModal } from '../dashboard/NodeEditorModal.js'
import type { EditorNode } from '../dashboard/canvas-model.js'

interface RoleEditorState { roleId?: string }
interface NodeEditorState {
  nodeId: string
  node: EditorNode
  roles: Array<{ id: string; name: string }>
  roleDefault?: {
    produces?: Array<{ kind: string; name: string; contract?: string }>
    capabilities?: string[]
    tools?: string[]
  }
}

export function BoardOverlays() {
  const [roleEditor, setRoleEditor] = useState<RoleEditorState | null>(null)
  const [nodeEditor, setNodeEditor] = useState<NodeEditorState | null>(null)

  useEffect(() => {
    const onOpenRole = (e: Event): void => {
      const d = (e as CustomEvent<RoleEditorState>).detail ?? {}
      setRoleEditor(d)
    }
    const onOpenNode = (e: Event): void => {
      const d = (e as CustomEvent<NodeEditorState>).detail
      if (d?.nodeId) setNodeEditor(d)
    }
    window.addEventListener('weave:open-role-editor', onOpenRole)
    window.addEventListener('weave:open-node-editor', onOpenNode)
    return () => {
      window.removeEventListener('weave:open-role-editor', onOpenRole)
      window.removeEventListener('weave:open-node-editor', onOpenNode)
    }
  }, [])

  return (
    <>
      <UserQuestionModal />
      {roleEditor && (
        <RoleEditor
          roleId={roleEditor.roleId}
          onClose={() => setRoleEditor(null)}
          onSaved={() => window.dispatchEvent(new CustomEvent('weave:roles-changed'))}
        />
      )}
      {nodeEditor && (
        <NodeEditorModal
          node={nodeEditor.node}
          roles={nodeEditor.roles}
          {...(nodeEditor.roleDefault !== undefined ? { roleDefault: nodeEditor.roleDefault } : {})}
          onClose={() => setNodeEditor(null)}
          onSave={(updated) => {
            window.dispatchEvent(new CustomEvent('weave:node-saved', { detail: { nodeId: nodeEditor.nodeId, node: updated } }))
            setNodeEditor(null)
          }}
          onDelete={() => {
            window.dispatchEvent(new CustomEvent('weave:node-deleted', { detail: { nodeId: nodeEditor.nodeId } }))
            setNodeEditor(null)
          }}
        />
      )}
    </>
  )
}
