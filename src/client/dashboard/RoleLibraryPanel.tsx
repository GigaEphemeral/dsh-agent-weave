/**
 * 角色库面板（MVP-5 Phase A：描述/排序/搜索）。
 */
import { useEffect, useState } from 'react'

export interface RoleLibraryEntry {
  id: string
  name: string
  description?: string
  order?: number
  tags: string[]
  suggests_next?: Array<{ roleRef: string; label?: string; reason?: string }>
}

export interface DraggableRole {
  id: string
  name: string
  suggests_next?: RoleLibraryEntry['suggests_next']
}

export function RoleLibraryPanel() {
  const [roles, setRoles] = useState<RoleLibraryEntry[]>([])
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'order' | 'name'>('order')

  useEffect(() => {
    const params = new URLSearchParams({ sort })
    if (search.trim()) params.set('search', search.trim())
    fetch(`/api/weave/roles?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setRoles(Array.isArray(d) ? d : []))
      .catch(() => setRoles([]))
  }, [search, sort])

  return (
    <div className="role-library-panel">
      <h3>角色库（{roles.length}）</h3>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input
          placeholder="搜索角色..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, fontSize: 12 }}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as 'order' | 'name')} style={{ fontSize: 12 }}>
          <option value="order">按顺序</option>
          <option value="name">按名称</option>
        </select>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
        {roles.length === 0 && <div style={{ color: '#888', fontSize: 12 }}>（暂无角色）</div>}
        {roles.map((r) => (
          <div
            key={r.id}
            title={r.description ?? ''}
            draggable
            onDragStart={(e) => {
              const payload: DraggableRole = { id: r.id, name: r.name, suggests_next: r.suggests_next }
              e.dataTransfer.setData('application/weave-role', JSON.stringify(payload))
              e.dataTransfer.effectAllowed = 'copy'
            }}
            style={{ border: '1px solid #eee', borderRadius: 6, padding: '4px 8px', fontSize: 12, cursor: 'grab' }}
          >
            <div><strong>{r.name}</strong> <span style={{ color: '#888' }}>{r.id}</span></div>
            {r.description && <div style={{ color: '#666' }}>{r.description}</div>}
            {r.tags.length > 0 && <div style={{ color: '#999' }}>{r.tags.join(' · ')}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
