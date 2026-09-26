/**
 * 用户确认弹窗（MVP-5 Phase I 通道 A：ask_user_question）。
 *
 * 监听 window 'weave:user-question'：
 *   detail: { taskId?: string, graphId?: string, question: { text: string, options?: Array<{ label: string; value: string }> } }
 * 回答后：优先 POST /api/weave/tasks/:taskId/answer；无 taskId 则仅关闭。
 */
import { useEffect, useState } from 'react'

interface Question {
  text: string
  options?: Array<{ label: string; value: string }>
}

interface UserQuestionDetail {
  taskId?: string
  graphId?: string
  question: Question
}

export function UserQuestionModal() {
  const [active, setActive] = useState<UserQuestionDetail | null>(null)
  const [custom, setCustom] = useState('')

  useEffect(() => {
    function onQuestion(e: Event): void {
      const detail = (e as CustomEvent<UserQuestionDetail>).detail
      if (detail?.question) {
        setActive(detail)
        setCustom('')
      }
    }
    window.addEventListener('weave:user-question', onQuestion)
    return () => window.removeEventListener('weave:user-question', onQuestion)
  }, [])

  if (!active) return null

  const submit = (answer: string): void => {
    const body = { answer }
    if (active.taskId) {
      void fetch(`/api/weave/tasks/${active.taskId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => {})
    }
    setActive(null)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 16, width: 420, maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,.2)' }}>
        <div style={{ fontSize: 13, color: '#64748b', marginBottom: 4 }}>节点需要你的确认</div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>{active.question.text}</div>
        {active.question.options && active.question.options.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {active.question.options.map((opt) => (
              <button
                key={opt.value}
                onClick={() => submit(opt.value)}
                style={{ textAlign: 'left', padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', background: '#f8fafc' }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="输入回答（可选）"
            style={{ flex: 1, fontSize: 13, padding: '6px 8px' }}
          />
          <button onClick={() => submit(custom.trim() || '继续')} style={{ padding: '6px 14px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            回答
          </button>
        </div>
      </div>
    </div>
  )
}
