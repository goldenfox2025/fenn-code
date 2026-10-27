import { Component, type ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import { errorText } from '@shared/errors'
import { t } from '../i18n'

/**
 * The last line of defence: a render error anywhere shows what went wrong and a way
 * back, instead of a blank window.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null }
  static getDerivedStateFromError(error: unknown) {
    return { error: error ?? new Error('unknown') }
  }
  componentDidCatch(error: unknown) {
    console.error('render failed', error)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash" role="alert">
        <div className="crash-card">
          <CircleAlert size={22} className="crash-icon" />
          <h2>{t('出了点问题')}</h2>
          <p className="muted">{t('界面遇到一个错误，没能显示出来。您的对话和设置都已保存，重新加载就能回来。')}</p>
          <pre className="crash-detail">{errorText(this.state.error)}</pre>
          <button className="btn primary" onClick={() => location.reload()}>
            {t('重新加载')}
          </button>
        </div>
      </div>
    )
  }
}
