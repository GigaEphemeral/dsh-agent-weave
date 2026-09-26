/**
 * 边类型选择器（ui修复2 §P2）：端口拖出连边后弹出，选 seq/cond/loop。
 *
 * - seq：普通顺序边
 * - cond：条件边（需 when 表达式）
 * - loop：循环回退边（需 maxIter）
 */
import { useState } from 'react'

export type EdgePickType = 'seq' | 'cond' | 'loop'

export function EdgeTypePicker({
  fromId, toId, onPick, onCancel,
}: {
  fromId: string
  toId: string
  onPick: (e: { type: EdgePickType; when?: string; maxIter?: number }) => void
  onCancel: () => void
}) {
  const [type, setType] = useState<EdgePickType>('seq')
  const [when, setWhen] = useState('')
  const [maxIter, setMaxIter] = useState(3)

  const confirm = (): void => {
    if (type === 'cond' && !when.trim()) { window.alert('条件边需要 when 表达式'); return }
    onPick({ type, ...(type === 'cond' ? { when: when.trim() } : {}), ...(type === 'loop' ? { maxIter } : {}) })
  }

  return (
    <div className="weave-modal-mask" onClick={onCancel}>
      <div className="weave-modal" style={{ width: 380 }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <div className="modal-kicker">连接</div>
            <div className="modal-title">{fromId} → {toId}</div>
          </div>
          <button className="modal-close" onClick={onCancel}>×</button>
        </header>
        <div className="modal-body">
          <div className="field">
            <label>边类型</label>
            <div className="edge-type-options">
              <label className={`edge-type-opt${type === 'seq' ? ' active' : ''}`}>
                <input type="radio" name="edge-type" checked={type === 'seq'} onChange={() => setType('seq')} />
                <strong>顺序</strong><span>前后执行</span>
              </label>
              <label className={`edge-type-opt${type === 'cond' ? ' active' : ''}`}>
                <input type="radio" name="edge-type" checked={type === 'cond'} onChange={() => setType('cond')} />
                <strong>条件</strong><span>满足 when 才走</span>
              </label>
              <label className={`edge-type-opt${type === 'loop' ? ' active' : ''}`}>
                <input type="radio" name="edge-type" checked={type === 'loop'} onChange={() => setType('loop')} />
                <strong>循环</strong><span>最多回退 maxIter 次</span>
              </label>
            </div>
          </div>
          {type === 'cond' && (
            <div className="field">
              <label>when 表达式</label>
              <input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="如 state.quality == 'failed'" />
            </div>
          )}
          {type === 'loop' && (
            <div className="field">
              <label>maxIter（最大回退次数）</label>
              <input type="number" min={1} value={maxIter} onChange={(e) => setMaxIter(Number(e.target.value) || 1)} />
            </div>
          )}
        </div>
        <footer className="modal-foot">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn primary" onClick={confirm}>连接</button>
        </footer>
      </div>
    </div>
  )
}
