import { useEffect, useRef, useState } from 'react'
import { Check, FolderKanban, MessageCircle, Clock } from 'lucide-react'
import { api, refreshAccount, toastError, useApp } from '../store'
import { t } from '../i18n'
import { AccountLine, BackendField, LoginButton, TerminalLoginButton } from './Dialogs'
import { imeComposing } from '../util'

/**
 * First run: what to call the user, which AI answers, and a first project.
 * Every step can be skipped; settings has all of it later.
 */
export function Onboarding() {
  const settings = useApp((s) => s.settings)
  const backends = useApp((s) => s.backends)
  const navigate = useApp((s) => s.navigate)
  const [step, setStep] = useState(0)
  const [name, setName] = useState(settings.userName)
  const accounts = useApp((s) => s.accounts)
  // Only an installed agent can answer, so only one can be picked; the others offer 安装 instead.
  const installed = (id: string) => (accounts[id]?.installed ?? backends.find((b) => b.id === id)?.installed) !== false
  const firstInstalled = () => backends.find((b) => installed(b.id))?.id ?? ''
  const [backendId, setBackendId] = useState(() => (settings.defaultBackendId && installed(settings.defaultBackendId) ? settings.defaultBackendId : firstInstalled()))
  const [project, setProject] = useState({ name: '', description: '' })
  const nameRef = useRef<HTMLInputElement>(null)
  // Finishing saves settings (and may create the project): one at a time, and the buttons wait.
  const [finishing, setFinishing] = useState(false)

  // The app behind the guide can't take focus or clicks while it is open (the home composer
  // would otherwise grab focus and send the user's name as a chat message).
  useEffect(() => {
    const behind = [...document.querySelectorAll<HTMLElement>('.sidebar, .main')]
    for (const el of behind) el.inert = true
    nameRef.current?.focus()
    // Tab cycles within the guide.
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const card = document.querySelector('.onboarding-card')
      const items = [...(card?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select') ?? [])]
      if (!items.length) return
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === -1 || i === items.length - 1 ? 0 : i + 1
      e.preventDefault()
      items[next].focus()
    }
    document.addEventListener('keydown', trap)
    return () => {
      document.removeEventListener('keydown', trap)
      for (const el of behind) el.inert = false
      document.querySelector<HTMLElement>('.composer textarea')?.focus()
    }
  }, [])

  // The core has already chosen an installed default. Status checks only update
  // the badges; a slow/unknown account response must never replace the user's choice.
  useEffect(() => {
    for (const b of backends) void refreshAccount(b.id, 60_000)
  }, [backends.map((b) => b.id).join()])
  // The pick found not installed after all (the check answered late): the first installed one instead.
  // One installed later (from 安装 here) becomes the pick when there was none.
  const installedKey = backends.map((b) => `${b.id}:${installed(b.id)}`).join()
  useEffect(() => {
    if (!backendId || !installed(backendId)) setBackendId(firstInstalled())
  }, [installedKey])

  const finish = async (projectToCreate?: { name: string; description: string }) => {
    if (finishing) return
    setFinishing(true)
    try {
      const usable = backendId && installed(backendId) ? backendId : undefined
      await api().updateSettings({ onboarded: true, userName: name.trim(), ...(usable ? { defaultBackendId: usable } : {}) })
      if (projectToCreate?.name.trim()) {
        const p = await api().createProject({ ...projectToCreate, name: projectToCreate.name.trim(), backendId: usable })
        navigate({ view: 'project', projectId: p.id })
      }
    } catch (e) {
      toastError(e)
    } finally {
      setFinishing(false)
    }
  }

  const chosen = backends.find((b) => b.id === backendId && installed(b.id))
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="onboarding-steps">
          {[0, 1, 2].map((i) => (
            <span key={i} className={'step-dot' + (i === step ? ' on' : i < step ? ' done' : '')} />
          ))}
        </div>

        {step === 0 && (
          <>
            <h1>{t('欢迎使用 Fenn Code')}</h1>
            <p className="muted">{t('在桌面上和 AI 一起做事：')}</p>
            <ul className="onboarding-points">
              <li>
                <MessageCircle size={16} />
                {t('随手提问的对话')}
              </li>
              <li>
                <FolderKanban size={16} />
                {t('长期推进的项目：一个主对话统筹，具体工作分到讨论串')}
              </li>
              <li>
                <Clock size={16} />
                {t('按时自动运行的定时任务')}
              </li>
            </ul>
            <div className="field">
              <label>{t('怎么称呼您')}</label>
              <input ref={nameRef} className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('您的名字（可以不填）')} onKeyDown={(e) => e.key === 'Enter' && !imeComposing(e) && setStep(1)} />
            </div>
            <div className="modal-actions">
              <button className="btn ghost skip" disabled={finishing} onClick={() => void finish()}>
                {t('跳过引导')}</button>
              <span className="spacer" />
              <button className="btn primary" onClick={() => setStep(1)}>
                {t('继续')}</button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1>{t('选择回答您的 AI')}</h1>
            <p className="muted">{t('Fenn Code 本身不含模型，回答来自您选择的 agent。以后可以在 设置 → Agent 后端 里更换。')}</p>
            <div className="choice-list">
              {backends.map((b) =>
                installed(b.id) ? (
                  <button key={b.id} className={'choice' + (b.id === backendId ? ' on' : '')} onClick={() => setBackendId(b.id)}>
                    <span className="radio">{b.id === backendId && <Check size={12} />}</span>
                    <span style={{ flex: 1, textAlign: 'left' }}>
                      <span className="title">
                        {b.name}
                        {b.id === 'codex' && accounts[b.id]?.installed && <span className="rec">{t('推荐')}</span>}
                      </span>
                      {b.description && <span className="small muted" style={{ display: 'block' }}>{b.description}</span>}
                    </span>
                  </button>
                ) : (
                  // Not installed: can't be picked yet; 安装 runs the same confirmed install as Settings.
                  // Only the name is marked unavailable: 安装 stays outside it, a control the keyboard reaches.
                  <div key={b.id} className="choice unavailable">
                    <span className="radio" />
                    <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                      <span role="group" aria-disabled="true" style={{ display: 'block' }}>
                        <span className="title">{b.name}</span>
                        {b.description && <span className="small muted" style={{ display: 'block' }}>{b.description}</span>}
                      </span>
                      <AccountLine backendId={b.id} name={b.name} upgrade={b.upgrade} configKey={JSON.stringify(b.configured)} />
                    </span>
                  </div>
                )
              )}
            </div>
            {!backendId && (
              <p className="small muted" style={{ marginTop: 12 }}>
                {t('还没有装好的 agent。可以先在上面安装一个；也可以先继续，以后在 设置 → Agent 后端 里安装。')}
              </p>
            )}
            {/* Only what still has to be done: a backend already signed in needs nothing here. */}
            {chosen && accounts[chosen.id]?.signedIn !== true && (chosen.signIn || chosen.terminalLogin || chosen.settings.length > 0) && (
              <div className="card" style={{ marginTop: 12 }}>
                <div className="small muted">
                  {chosen.signIn || chosen.terminalLogin
                    ? t('{0} 需要登录，或在下面填入「{1}」。现在跳过也可以，第一次对话时会提示您登录。', chosen.name, chosen.settings.find((x) => x.secret)?.label ?? t('API 密钥'))
                    : t('{0} 需要下面这些设置。', chosen.name)}
                </div>
                {(chosen.signIn || chosen.terminalLogin) && (
                  <div style={{ marginTop: 10 }}>
                    {chosen.signIn ? <LoginButton backendId={chosen.id} /> : <TerminalLoginButton backendId={chosen.id} />}
                  </div>
                )}
                {chosen.settings.map((s) => (
                  <BackendField key={s.key} backendId={chosen.id} setting={s} configured={chosen.configured[s.key]} />
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setStep(0)}>
                {t('返回')}</button>
              <span className="spacer" />
              <button className="btn primary" onClick={() => setStep(2)}>
                {t('继续')}</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>{t('创建第一个项目')}</h1>
            <p className="muted">{t('项目适合要做一阵子的事。您在主对话里提需求，agent 会把具体的工作分到讨论串里，并记住项目的来龙去脉。')}</p>
            <div className="field">
              <label>{t('名称')}</label>
              <input className="input" autoFocus value={project.name} onChange={(e) => setProject({ ...project, name: e.target.value })} placeholder={t('例如：家庭装修、毕业论文')} />
            </div>
            <div className="field">
              <label>{t('描述')}</label>
              <input className="input" value={project.description} onChange={(e) => setProject({ ...project, description: e.target.value })} placeholder={t('这个项目要做什么（可以不填）')} />
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setStep(1)}>
                {t('返回')}</button>
              <span className="spacer" />
              <button className="btn skip" disabled={finishing} onClick={() => void finish()}>
                {t('以后再说')}</button>
              <button className="btn primary" disabled={!project.name.trim() || finishing} onClick={() => void finish(project)}>
                {t('创建项目')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
