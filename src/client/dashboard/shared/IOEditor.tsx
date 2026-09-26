/**
 * 通用 I/O 编辑组件（ui修复2 §P1.1，角色/节点复用）。
 *
 * - 角色编辑器用：showInheritOption=false，直接编辑 produces
 * - 节点编辑器用：showInheritOption=true，三态（继承 / 覆盖）
 */
import { useState } from 'react'
import type { ConsumeItem, ProduceItem, ProducedKind } from '../canvas-model.js'

const KINDS: ProducedKind[] = ['doc', 'code', 'test', 'script', 'config', 'data']

export interface IOEditorProps {
  value: ProduceItem[] | undefined
  onChange: (v: ProduceItem[] | undefined) => void
  /** true 时显示「继承 / 覆盖」三态切换；false 直接编辑。 */
  showInheritOption?: boolean
}

export function IOEditor({ value, onChange, showInheritOption = false }: IOEditorProps) {
  // undefined = 继承；null = 显式清空（[]）；否则覆盖清单
  const [mode, setMode] = useState<'inherit' | 'clear' | 'override'>(
    value === undefined ? 'inherit' : value.length === 0 ? 'clear' : 'override',
  )
  const items = value ?? []

  const setModeAndEmit = (m: 'inherit' | 'clear' | 'override'): void => {
    setMode(m)
    if (m === 'inherit') onChange(undefined)
    else if (m === 'clear') onChange([])
  }

  const updateItem = (i: number, patch: Partial<ProduceItem>): void => {
    const next = items.map((x, idx) => (idx === i ? { ...x, ...patch } : x))
    onChange(next)
  }

  const addItem = (): void => {
    onChange([...items, { kind: 'doc', name: '' }])
    setMode('override')
  }

  const removeItem = (i: number): void => {
    onChange(items.filter((_, idx) => idx !== i))
  }

  return (
    <div className="io-editor">
      {showInheritOption && (
        <div className="inherit-toggle">
          <label className="checkbox">
            <input type="radio" name="io-mode" checked={mode === 'inherit'} onChange={() => setModeAndEmit('inherit')} />
            完全继承角色（默认）
          </label>
          <label className="checkbox">
            <input type="radio" name="io-mode" checked={mode === 'clear'} onChange={() => setModeAndEmit('clear')} />
            显式清空（本项目不交产物）
          </label>
          <label className="checkbox">
            <input type="radio" name="io-mode" checked={mode === 'override'} onChange={() => setMode('override')} />
            覆盖（本项目按此清单）
          </label>
        </div>
      )}

      {(mode === 'override' || !showInheritOption) && (
        <div className="io-list">
          {items.length === 0 && <div className="io-empty">（空清单）</div>}
          {items.map((p, i) => (
            <div key={i} className="io-row">
              <select
                value={p.kind}
                onChange={(e) => updateItem(i, { kind: e.target.value as ProducedKind })}
              >
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <input
                placeholder="文件名（如 requirement.md）"
                value={p.name}
                onChange={(e) => updateItem(i, { name: e.target.value })}
              />
              <input
                placeholder="契约（可选）"
                value={p.contract ?? ''}
                onChange={(e) => updateItem(i, { contract: e.target.value })}
              />
              <button type="button" className="io-remove" onClick={() => removeItem(i)}>×</button>
            </div>
          ))}
          <button type="button" className="io-add" onClick={addItem}>+ 添加产出</button>
        </div>
      )}
    </div>
  )
}

/** 消费项编辑器（consumes；角色编辑器用，直接编辑）。 */
export function ConsumeEditor({
  value, onChange,
}: {
  value: ConsumeItem[] | undefined
  onChange: (v: ConsumeItem[] | undefined) => void
}) {
  const items = value ?? []
  const updateItem = (i: number, patch: Partial<ConsumeItem>): void => {
    onChange(items.map((x, idx) => (idx === i ? { ...x, ...patch } : x)))
  }
  return (
    <div className="io-editor">
      <div className="io-list">
        {items.length === 0 && <div className="io-empty">（无消费产物）</div>}
        {items.map((c, i) => (
          <div key={i} className="io-row">
            <input
              placeholder="kind（如 doc）"
              value={c.kind}
              onChange={(e) => updateItem(i, { kind: e.target.value })}
              style={{ width: 80 }}
            />
            <input
              placeholder="name（如 requirement.md）"
              value={c.name}
              onChange={(e) => updateItem(i, { name: e.target.value })}
            />
            <input
              placeholder="from（上游节点，可选）"
              value={c.from ?? ''}
              onChange={(e) => updateItem(i, { from: e.target.value })}
            />
            <button type="button" className="io-remove" onClick={() => onChange(items.filter((_, idx) => idx !== i))}>×</button>
          </div>
        ))}
        <button type="button" className="io-add" onClick={() => onChange([...items, { kind: 'doc', name: '' }])}>+ 添加消费</button>
      </div>
    </div>
  )
}
