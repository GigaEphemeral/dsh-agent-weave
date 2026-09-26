/**
 * MVP-5B B6：角色编辑器（Client 侧，planB §6.3；功能问题1 §四/§五 改造）。
 *
 * - 候选值从 API 拉取（不硬编码）：
 *   provider/model：GET /api/weave/providers（带 source/warning）
 *   capabilities：GET /api/weave/capabilities（{id,label}[]）
 *   tools：GET /api/weave/tools（{id,label,desc}[]，subagent 白名单）
 *   skill：GET /api/weave/roles/:id/skill（只读展示）
 * - 基础区默认展开；高级区默认折叠（用户 80% 只改基础）
 * - 新建角色预填平台默认值
 * 保存：POST /api/weave/roles（宿主写 roles/<id>.yaml）
 */
import { useEffect, useState } from 'react'
import type { ProduceItem } from './canvas-model.js'
import { IOEditor } from './shared/IOEditor.js'

export interface ProviderInfo {
  id: string
  name: string
  models: string[]
  defaultModel: string
  source: 'dynamic' | 'yaml-scan' | 'static'
}

export interface CapabilityItem { id: string; label: string }
export interface ToolItem { id: string; label: string; desc: string }

export interface RoleEditorProps {
  roleId?: string | undefined
  onClose: () => void
  onSaved?: () => void
}

interface RoleFormData {
  id: string
  name: string
  description: string
  order: number
  tags: string
  provider: string
  model: string
  capabilities: string[]
  tools: string[]
  readable: string
  inputRequires: string
  onlyMarkdown: boolean
  forbidExtensions: string
  requiredSections: string
  forbidden: string
  produces: ProduceItem[] | undefined
}

/** 功能问题1 §4.1：平台默认值（新建角色预填）。 */
const PLATFORM_DEFAULTS: { capabilities: string[]; tools: string[]; forbidExtensions: string; onlyMarkdown: boolean; produces: ProduceItem[] | undefined } = {
  capabilities: ['read'],
  tools: ['read', 'glob', 'grep'],
  forbidExtensions: '.py,.js,.ts',
  onlyMarkdown: true,
  produces: [{ kind: 'doc', name: 'output.md', contract: '' }],
}

function makeBlank(): RoleFormData {
  return {
    id: '', name: '', description: '', order: 10, tags: '',
    provider: '', model: '',
    capabilities: [...PLATFORM_DEFAULTS.capabilities],
    tools: [...PLATFORM_DEFAULTS.tools],
    readable: '', inputRequires: '',
    onlyMarkdown: PLATFORM_DEFAULTS.onlyMarkdown,
    forbidExtensions: PLATFORM_DEFAULTS.forbidExtensions,
    requiredSections: '', forbidden: '',
    produces: PLATFORM_DEFAULTS.produces?.map((p) => ({ ...p })),
  }
}

function splitCsv(s: string): string[] {
  return s.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
}

const inputStyle: React.CSSProperties = { width: '100%', fontSize: 13, padding: '4px 6px', boxSizing: 'border-box' }

export function RoleEditor({ roleId, onClose, onSaved }: RoleEditorProps) {
  const isNew = !roleId
  const [form, setForm] = useState<RoleFormData>(makeBlank)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [providerWarning, setProviderWarning] = useState('')
  const [providerSource, setProviderSource] = useState<string>('dynamic')
  const [capabilities, setCapabilities] = useState<CapabilityItem[]>([])
  const [availableTools, setAvailableTools] = useState<ToolItem[]>([])
  const [skillContent, setSkillContent] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (patch: Partial<RoleFormData>): void => setForm((f) => ({ ...f, ...patch }))

  useEffect(() => {
    // 三处都从 API 拉（功能问题1 §2/§3：capabilities/tools 带 label；providers 带 warning）
    Promise.all([
      fetch('/api/weave/providers').then((r) => r.json()).catch(() => ({ providers: [] as ProviderInfo[], source: 'dynamic' })),
      fetch('/api/weave/capabilities').then((r) => r.json()).catch(() => ({ capabilities: [] as CapabilityItem[] })),
      fetch('/api/weave/tools').then((r) => r.json()).catch(() => ({ tools: [] as ToolItem[] })),
    ])
      .then(([p, c, tt]) => {
        const pv = p as { providers: ProviderInfo[]; overallSource?: string; warning?: string }
        setProviders(pv.providers ?? [])
        setProviderSource(pv.overallSource ?? 'dynamic')
        setProviderWarning(pv.warning ?? '')
        setCapabilities((c as { capabilities: CapabilityItem[] }).capabilities ?? [])
        setAvailableTools((tt as { tools: ToolItem[] }).tools ?? [])
      })
      .finally(() => setLoading(false))
  }, [])

  // 编辑已有角色：从角色库拉取初始值 + SKILL.md
  useEffect(() => {
    if (!roleId) return
    fetch(`/api/weave/roles?search=${encodeURIComponent(roleId)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Array<Record<string, unknown>>) => {
        const hit = list.find((x) => x.id === roleId)
        if (!hit) return
        setForm({
          id: String(hit.id ?? ''),
          name: String(hit.name ?? ''),
          description: String(hit.description ?? ''),
          order: typeof hit.order === 'number' ? hit.order : 10,
          tags: Array.isArray(hit.tags) ? (hit.tags as string[]).join(',') : '',
          provider: '',
          model: '',
          capabilities: Array.isArray(hit.capabilities) ? (hit.capabilities as string[]).map(String) : [],
          tools: Array.isArray(hit.tools) ? (hit.tools as string[]).map(String) : [],
          readable: '', inputRequires: '', onlyMarkdown: true, forbidExtensions: '', requiredSections: '', forbidden: '',
          produces: Array.isArray(hit.produces) ? (hit.produces as ProduceItem[]) : undefined,
        })
      })
      .catch(() => {})
    fetch(`/api/weave/roles/${encodeURIComponent(roleId)}/skill`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.content) setSkillContent(d.content as string) })
      .catch(() => setSkillContent(''))
  }, [roleId])

  const selectedProvider = providers.find((p) => p.id === form.provider)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const r = await fetch('/api/weave/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: form.id,
          name: form.name,
          description: form.description,
          order: form.order,
          tags: splitCsv(form.tags),
          provider: form.provider,
          model: form.model,
          capabilities: form.capabilities,
          tools: form.tools,
          readable: splitCsv(form.readable),
          inputRequires: splitCsv(form.inputRequires),
          onlyMarkdown: form.onlyMarkdown,
          forbidExtensions: splitCsv(form.forbidExtensions),
          requiredSections: splitCsv(form.requiredSections),
          forbidden: splitCsv(form.forbidden),
          produces: form.produces,
        }),
      })
      const d = (await r.json()) as { ok?: boolean; error?: string }
      if (!d.ok) {
        setError(d.error ?? '保存失败')
        return
      }
      onSaved?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="weave-modal-mask" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.4)', zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ background: '#fff', borderRadius: 12, padding: 24 }}>加载中…</div>
      </div>
    )
  }

  const sectionTitle = (): React.CSSProperties => ({ fontSize: 13, fontWeight: 600, margin: '10px 0 6px' })
  const labelStyle: React.CSSProperties = { fontSize: 12, color: '#64748b' }
  const chipStyle = (on: boolean): React.CSSProperties => ({
    fontSize: 12, padding: '3px 10px', borderRadius: 999,
    border: on ? '1px solid #2563eb' : '1px dashed #cbd5e1',
    background: on ? '#eff6ff' : '#fff',
    opacity: on ? 1 : 0.6,
    cursor: 'pointer',
  })

  return (
    <div className="weave-modal-mask" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.4)', zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 720, maxWidth: '94vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,.2)' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #e2e8f0' }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{isNew ? '新建角色' : `编辑角色 · ${roleId}`}</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer' }}>×</button>
        </header>

        <div style={{ padding: '0 16px', overflowY: 'auto', flex: 1 }}>
          {/* provider 降级警告（功能问题1 §3.2） */}
          {(providerWarning || providerSource !== 'dynamic') && (
            <div style={{ margin: '10px 0', padding: '8px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
              ⚠ {providerWarning || `Provider 列表来源：${providerSource}（非实时探测），实际可用 provider 以 DSH 环境为准`}
            </div>
          )}

          {/* ─── 基础区（默认展开） ─── */}
          <div style={sectionTitle()}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>基本信息</div>
            <label style={labelStyle}>角色 ID（必填，保存后不可改）</label>
            <input style={inputStyle} value={form.id} disabled={!isNew} onChange={(e) => set({ id: e.target.value })} placeholder="如 R3-pm" />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>名称（必填）</label>
              <input style={inputStyle} value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div style={{ width: 90 }}>
              <label style={labelStyle}>排序</label>
              <input style={inputStyle} type="number" value={form.order} onChange={(e) => set({ order: Number(e.target.value) || 0 })} />
            </div>
          </div>
          <label style={labelStyle}>描述</label>
          <input style={inputStyle} value={form.description} onChange={(e) => set({ description: e.target.value })} />
          <label style={labelStyle}>标签（逗号分隔）</label>
          <input style={inputStyle} value={form.tags} onChange={(e) => set({ tags: e.target.value })} />

          <div style={sectionTitle()}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>大模型提供者</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Provider（数据来源：/api/weave/providers）</label>
                <select style={inputStyle} value={form.provider} onChange={(e) => set({ provider: e.target.value, model: '' })}>
                  <option value="">（请选择）</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.source !== 'dynamic' ? `（来源：${p.source}）` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>模型</label>
                <select style={inputStyle} value={form.model} onChange={(e) => set({ model: e.target.value })} disabled={!selectedProvider}>
                  <option value="">（请选择）</option>
                  {selectedProvider?.models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>
            {providers.length === 0 && (
              <div style={{ fontSize: 12, color: '#f59e0b', marginTop: 4 }}>
                ⚠ 无法获取运行时 provider 列表（前端不硬编码）。请检查 DSH 环境；provider 为空时无法新建角色。
              </div>
            )}
          </div>

          {/* 能力集（功能问题1 §4.3：on 实心 / off 虚线） */}
          <div style={sectionTitle()}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>能力集（capabilities）</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {capabilities.map((c) => {
                const on = form.capabilities.includes(c.id)
                return (
                  <button
                    key={c.id}
                    className={`chip ${on ? 'on' : 'off'}`}
                    onClick={() => set({ capabilities: on ? form.capabilities.filter((x) => x !== c.id) : [...form.capabilities, c.id] })}
                    style={chipStyle(on)}
                    title={c.label}
                  >
                    {on ? '✓ ' : ''}{c.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* ─── 高级区（默认折叠） ─── */}
          <div style={{ borderTop: '1px solid #e2e8f0', margin: '12px 0 8px' }}>
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              style={{ width: '100%', textAlign: 'left', padding: '10px 0', background: 'none', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#334155' }}
            >
              {showAdvanced ? '▾' : '▸'} 高级配置
              {!showAdvanced && <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 400 }}>（工具 / 可读范围 / 产出 / 约束 / SKILL）</span>}
            </button>
          </div>

          {showAdvanced && (
            <>
              <div style={sectionTitle()}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>工具白名单（tools）</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 140, overflowY: 'auto' }}>
                  {availableTools.map((t) => {
                    const on = form.tools.includes(t.id)
                    return (
                      <button
                        key={t.id}
                        className={`chip ${on ? 'on' : 'off'}`}
                        title={t.desc}
                        onClick={() => set({ tools: on ? form.tools.filter((x) => x !== t.id) : [...form.tools, t.id] })}
                        style={chipStyle(on)}
                      >
                        {on ? '✓ ' : ''}{t.label} <code style={{ fontSize: 10.5, color: '#64748b' }}>{t.id}</code>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div style={sectionTitle()}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>可读范围（readable）</div>
                <textarea rows={2} style={inputStyle} value={form.readable} onChange={(e) => set({ readable: e.target.value })} placeholder={'每行一个 glob，如：\nsrc/**\nproductions/**'} />
              </div>

              <div style={sectionTitle()}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>输入门禁（input.requires）</div>
                <input style={inputStyle} value={form.inputRequires} onChange={(e) => set({ inputRequires: e.target.value })} placeholder={'逗号分隔的上游节点 ID'} />
              </div>

              <div style={sectionTitle()}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>产出清单（produces）</div>
                <IOEditor value={form.produces} onChange={(produces) => set({ produces })} />
              </div>

              <div style={sectionTitle()}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>输出约束（output）</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                  <input type="checkbox" checked={form.onlyMarkdown} onChange={(e) => set({ onlyMarkdown: e.target.checked })} /> 仅允许 .md
                </label>
                <label style={labelStyle}>禁止扩展名（逗号分隔）</label>
                <input style={inputStyle} value={form.forbidExtensions} onChange={(e) => set({ forbidExtensions: e.target.value })} placeholder=".py,.ts,.html" />
                <label style={labelStyle}>必需章节（逗号分隔）</label>
                <input style={inputStyle} value={form.requiredSections} onChange={(e) => set({ requiredSections: e.target.value })} />
              </div>

              <div style={sectionTitle()}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>非职责（forbidden）</div>
                <textarea rows={2} style={inputStyle} value={form.forbidden} onChange={(e) => set({ forbidden: e.target.value })} placeholder={'每行一条，如：\n禁止写代码'} />
              </div>

              {/* 功能问题1 §5.2：SKILL.md 只读展示 */}
              {roleId && (
                <div style={sectionTitle()}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>技能提示词（SKILL.md）</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>
                    （此内容为角色的系统提示词，如需修改请在对话中让主 agent 编辑 <code>skills/{roleId}/SKILL.md</code>）
                  </div>
                  <pre style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto' }}>
                    {skillContent || '（SKILL.md 未找到）'}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>

        <footer style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 16px', borderTop: '1px solid #e2e8f0' }}>
          {error && <div style={{ fontSize: 12, color: '#ef4444', alignSelf: 'center' }}>{error}</div>}
          <button onClick={onClose} style={{ padding: '6px 14px', cursor: 'pointer' }}>取消</button>
          <button onClick={() => void save()} disabled={saving || (isNew && providers.length === 0)} style={{ padding: '6px 16px', cursor: 'pointer', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6 }}>
            {saving ? '保存中…' : (isNew ? '创建' : '保存')}
          </button>
        </footer>
      </div>
    </div>
  )
}
