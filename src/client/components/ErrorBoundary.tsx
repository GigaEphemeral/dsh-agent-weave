/**
 * 错误边界（MVP-4 P4.C.9）。
 *
 * 单个面板出错不拖垮整个看板。
 */
import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  override componentDidCatch(error: Error): void {
    console.error('Weave panel error', error)
  }

  override render(): ReactNode {
    if (this.state.hasError) return <div className="weave-error" style={{ padding: 12, color: '#b91c1c' }}>组件出错，请刷新页面</div>
    return this.props.children
  }
}
