import { useEffect, useRef, useState } from 'react'
import { Bot, Check, FolderGit2, FolderKanban, FolderOpen, Info, Palette, Plug, Plus, User, X } from 'lucide-react'
import type { AppInfo, ConnectorView, FolderCandidate, Project, Routine, Schedule, UpdateCheck } from '@shared/model'
import { Dropdown, useMenu } from './Menu'
import { confirmDialog, Overlay, useLayer } from './Modal'
import { api, refreshAccount, toast, useApp } from '../store'
import { langSetting, setLanguage, t } from '../i18n'
import { LANGS } from '@shared/i18n'

export function Dialogs() {
  const open = useApp((s) => s.settingsOpen)
  const close = () => useApp.getState().set({ settingsOpen: false })
  if (!open) return null
  const key = String(open)
  let body: React.ReactNode
  if (key === 'new-project') body = <ProjectForm onDone={close} />
  else if (key.startsWith('project:')) body = <ProjectForm projectId={key.slice(8)} onDone={close} />
  else if (key.startsWith('routine:new:')) body = <RoutineForm projectId={key.slice(12) || undefined} onDone={close} />
  else if (key.startsWith('routine:')) body = <RoutineForm routineId={key.slice(8)} onDone={close} />
  else return <SettingsModal tab={key} onClose={close} />
  return (
    <Overlay onClose={close}>
      <div className="modal" tabIndex={-1}>{body}</div>
    </Overlay>
  )
}

function ProjectForm({ projectId, onDone }: { projectId?: string; onDone: () => void }) {
  const existing = useApp((s) => s.projects.find((p) => p.id === projectId))
  const backends = useApp((s) => s.backends)
  const defaultBackend = useApp((s) => s.settings.defaultBackendId)
  const navigate = useApp((s) => s.navigate)
  const [f, setF] = useState<Partial<Project>>(
    existing ?? { name: '', description: '', instructions: '', backendId: defaultBackend }
  )
  // Folders whose name matches the project's, offered as one click; never set on their own.
  const [likely, setLikely] = useState<FolderCandidate[]>([])
  useEffect(() => {
    if (f.cwd || !f.name?.trim()) return setLikely([])
    const h = setTimeout(() => void api().suggestFolders(f.name!, true).then((l) => setLikely(l.slice(0, 3)), () => {}), 300)
    return () => clearTimeout(h)
  }, [f.name, f.cwd])
  const save = async () => {
    if (!f.name?.trim()) return
    if (existing) {
      // Only the fields on this form: the board and other state may have changed while it was open.
      const { name, description, instructions, cwd, backendId } = f
      await api().updateProject(existing.id, { name: name!.trim(), description, instructions, cwd, backendId })
    } else {
      const p = await api().createProject({ ...f, name: f.name.trim() } as Project)
      navigate({ view: 'project', projectId: p.id })
    }
    onDone()
  }
  return (
    <>
      <h2>{existing ? t('项目设置') : t('新建项目')}</h2>
      <div className="field">
        <label>{t('名称')}</label>
        <input className="input" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t('例如：家庭装修、毕业论文')} />
      </div>
      <div className="field">
        <label>{t('描述')}</label>
        <input className="input" value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={t('这个项目要做什么（也用于自动归类对话）')} />
      </div>
      <div className="field">
        <label>{t('项目指令')}</label>
        <textarea className="textarea" value={f.instructions ?? ''} onChange={(e) => setF({ ...f, instructions: e.target.value })} placeholder={t('项目内每个 agent 都会遵守的说明，例如风格、约定、背景知识')} />
      </div>
      <div className="field">
        <label>{t('工作文件夹')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" value={f.cwd ?? ''} onChange={(e) => setF({ ...f, cwd: e.target.value })} placeholder={t('agent 可以读写的文件夹（可选）')} />
          <button
            className="btn"
            onClick={async () => {
              const dir = await api().pickFolder()
              if (dir) setF({ ...f, cwd: dir })
            }}
          >
            <FolderOpen size={15} />
          </button>
        </div>
        {likely.length > 0 && (
          <div className="folder-suggest">
            <span className="muted small">{t('可能是：')}</span>
            {likely.map((l) => (
              <button key={l.path} className="link-chip" title={l.path} onClick={() => setF({ ...f, cwd: l.path })}>
                <FolderGit2 size={12} /> {l.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="field">
        <label>{t('Agent 后端')}</label>
        <Dropdown value={f.backendId} onChange={(v) => setF({ ...f, backendId: v })} options={backends.map((b) => ({ value: b.id, label: b.name, sub: b.description }))} />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onDone}>
          {t('取消')}</button>
        <button className="btn primary" disabled={!f.name?.trim()} onClick={save}>
          {existing ? t('保存') : t('创建项目')}
        </button>
      </div>
    </>
  )
}

const WEEK = [t('日'), t('一'), t('二'), t('三'), t('四'), t('五'), t('六')]

function RoutineForm({ routineId, projectId, onDone }: { routineId?: string; projectId?: string; onDone: () => void }) {
  const existing = useApp((s) => s.routines.find((r) => r.id === routineId))
  const projects = useApp((s) => s.projects)
  const backends = useApp((s) => s.backends)
  const [name, setName] = useState(existing?.name ?? '')
  const [prompt, setPrompt] = useState(existing?.prompt ?? '')
  const [target, setTarget] = useState(existing?.target.projectId ?? projectId ?? '')
  const [backendId, setBackendId] = useState(existing?.backendId ?? '')
  const [schedule, setSchedule] = useState<Schedule>(existing?.schedule ?? { kind: 'daily', time: '09:00' })

  const save = async () => {
    if (!name.trim() || !prompt.trim()) return
    await api().saveRoutine({
      id: existing?.id,
      name: name.trim(),
      prompt: prompt.trim(),
      schedule,
      target: target ? { projectId: target } : {},
      backendId: backendId || undefined,
      enabled: existing?.enabled ?? true
    } as Routine)
    toast(existing ? t('已保存定时任务') : t('已创建定时任务'))
    onDone()
  }

  return (
    <>
      <h2>{existing ? t('编辑定时任务') : t('新建定时任务')}</h2>
      <div className="field">
        <label>{t('名称')}</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('例如：每日早报')} />
      </div>
      <div className="field">
        <label>{t('要做什么')}</label>
        <textarea className="textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('每次运行时发给 agent 的指令')} />
      </div>
      <div className="field">
        <label>{t('频率')}</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Dropdown
            className="w-140"
            value={schedule.kind}
            options={[
              { value: 'daily', label: t('每天 / 每周') },
              { value: 'interval', label: t('间隔') },
              { value: 'once', label: t('一次') },
              { value: 'cron', label: t('Cron 表达式') }
            ]}
            onChange={(k: Schedule['kind']) => {
              setSchedule(
                k === 'daily'
                  ? { kind: 'daily', time: '09:00' }
                  : k === 'interval'
                    ? { kind: 'interval', minutes: 60 }
                    : k === 'once'
                      ? { kind: 'once', at: Date.now() + 3600_000 }
                      : { kind: 'cron', expr: '0 9 * * 1-5' }
              )
            }}
          />
          {schedule.kind === 'daily' && (
            <>
              <input className="input" type="time" style={{ width: 120 }} value={schedule.time} onChange={(e) => setSchedule({ ...schedule, time: e.target.value })} />
              <div style={{ display: 'flex', gap: 4 }}>
                {WEEK.map((w, i) => {
                  const on = !schedule.weekdays?.length || schedule.weekdays.includes(i)
                  return (
                    <button
                      key={i}
                      className={'day' + (on ? ' on' : '')}
                      onClick={() => {
                        const cur = schedule.weekdays?.length ? schedule.weekdays : [0, 1, 2, 3, 4, 5, 6]
                        const next = on ? cur.filter((d) => d !== i) : [...cur, i].sort()
                        setSchedule({ ...schedule, weekdays: next.length === 7 ? undefined : next })
                      }}
                    >
                      {w}
                    </button>
                  )
                })}
              </div>
            </>
          )}
          {schedule.kind === 'interval' && (
            <>
              <input className="input" type="number" min={1} style={{ width: 100 }} value={schedule.minutes} onChange={(e) => setSchedule({ ...schedule, minutes: Math.max(1, +e.target.value) })} />
              <span className="muted" style={{ alignSelf: 'center' }}>{t('分钟')}</span>
            </>
          )}
          {schedule.kind === 'once' && (
            <input
              className="input"
              type="datetime-local"
              style={{ width: 220 }}
              value={toLocalInput(schedule.at)}
              onChange={(e) => setSchedule({ kind: 'once', at: new Date(e.target.value).getTime() })}
            />
          )}
          {schedule.kind === 'cron' && (
            <input className="input" style={{ width: 200 }} value={schedule.expr} onChange={(e) => setSchedule({ kind: 'cron', expr: e.target.value })} placeholder={t('分 时 日 月 周')} />
          )}
        </div>
      </div>
      <div className="field">
        <label>{t('结果发到')}</label>
        <Dropdown
          value={target}
          onChange={setTarget}
          options={[
            { value: '', label: t('每次新建一个对话') },
            ...(projects.length ? [{ heading: t('项目') }] : []),
            ...projects.filter((p) => !p.archived || p.id === projectId).map((p) => ({ value: p.id, label: p.name, icon: <FolderKanban size={15} /> }))
          ]}
        />
      </div>
      <div className="field">
        <label>{t('Agent 后端')}</label>
        <Dropdown
          value={backendId}
          onChange={setBackendId}
          options={[{ value: '', label: t('默认') }, ...backends.map((b) => ({ value: b.id, label: b.name, sub: b.description }))]}
        />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onDone}>
          {t('取消')}</button>
        <button className="btn primary" disabled={!name.trim() || !prompt.trim()} onClick={save}>
          {t('保存')}</button>
      </div>
    </>
  )
}

function toLocalInput(ts: number): string {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}

function SettingsModal({ tab: initial, onClose }: { tab: string; onClose: () => void }) {
  const [tab, setTab] = useState(['backends', 'connectors', 'about'].includes(initial) ? initial : 'general')
  const [, setFormOpen] = useState(false)
  const tabs = [
    { id: 'general', label: t('通用'), icon: <User size={15} /> },
    { id: 'appearance', label: t('外观'), icon: <Palette size={15} /> },
    { id: 'backends', label: t('Agent 后端'), icon: <Bot size={15} /> },
    { id: 'connectors', label: t('连接器'), icon: <Plug size={15} /> },
    { id: 'about', label: t('关于'), icon: <Info size={15} /> }
  ]
  // Like Claude: a close button in the corner (top-left on macOS), Esc closes too, and every change is already saved.
  const mac = useApp((s) => s.platform) === 'darwin'
  return (
    <Overlay onClose={onClose}>
      <div className={'modal wide settings-modal' + (mac ? ' mac' : '')} tabIndex={-1}>
        <button className={'icon-btn settings-close ' + (mac ? 'left' : 'right')} title={t('关闭')} aria-label={t('关闭')} onClick={onClose}>
          <X size={18} />
        </button>
        <nav className="settings-nav">
          <div style={{ fontSize: 18, fontWeight: 500, padding: '0 10px 12px' }}>{t('设置')}</div>
          {tabs.map((t) => (
            <button key={t.id} className={'nav-item' + (tab === t.id ? ' selected' : '')} onClick={() => setTab(t.id)}>
              {t.icon}
              <span className="label">{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <ReenterSecrets />
          {tab === 'general' && <GeneralSettings />}
          {tab === 'appearance' && <AppearanceSettings />}
          {tab === 'backends' && <BackendSettings />}
          {tab === 'connectors' && <ConnectorSettings onFormChange={setFormOpen} />}
          {tab === 'about' && <AboutSettings />}
        </div>
      </div>
    </Overlay>
  )
}

/** Secrets the renames couldn't carry over; shown until the user dismisses it. */
function ReenterSecrets() {
  const list = useApp((s) => s.settings.secretsToReenter)
  if (!list?.length) return null
  return (
    <div className="reenter-banner">
      <div>
        {t('改名为 Ancora 后，系统钥匙串里的旧密钥打不开了，下面这些需要重新填写：')}
        <ul>
          {list.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
      <button className="btn" onClick={() => api().updateSettings({ secretsToReenter: [] })}>
        {t('知道了')}
      </button>
    </div>
  )
}

/** Calls save with the latest value when the component goes away (e.g. Settings closed by Esc). */
function useSaveOnLeave(value: string, save: (v: string) => unknown) {
  const latest = useRef({ value, save })
  latest.current = { value, save }
  useEffect(() => () => void latest.current.save(latest.current.value), [])
}

function GeneralSettings() {
  const settings = useApp((s) => s.settings)
  const [name, setName] = useState(settings.userName)
  // Saved on blur, and also when Settings closes with the field still focused (Esc or ✕).
  useSaveOnLeave(name, (v) => v.trim() !== useApp.getState().settings.userName && void api().updateSettings({ userName: v.trim() }))
  return (
    <>
      <h2>{t('通用')}</h2>
      <div className="field">
        <label>{t('怎么称呼您')}</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => api().updateSettings({ userName: name.trim() })} placeholder={t('您的名字')} />
      </div>
      <div className="field">
        <label>{t('常用文件夹')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" value={settings.defaultCwd ?? ''} readOnly placeholder={t('未设置')} />
          <button
            className="btn"
            onClick={async () => {
              const dir = await api().pickFolder()
              if (dir) void api().updateSettings({ defaultCwd: dir })
            }}
          >
            <FolderOpen size={15} />
          </button>
          {settings.defaultCwd && (
            <button className="btn" title={t('不使用文件夹')} onClick={() => void api().updateSettings({ defaultCwd: '' })}>
              <X size={15} />
            </button>
          )}
        </div>
        <div className="small muted">{t('排在输入框文件夹菜单的第一个。新对话默认不带文件夹，选了文件夹，agent 才能读写其中的文件、运行命令。')}</div>
      </div>
      <div className="field">
        <div className="row-between">
          <div>
            <label>{t('自动归类对话')}</label>
            <div className="help">{t('不属于任何项目的新对话，会在第一轮回复后自动判断是否属于某个项目，并归入其中。')}</div>
          </div>
          <button className={'switch' + (settings.autoAssignChats ? ' on' : '')} onClick={() => api().updateSettings({ autoAssignChats: !settings.autoAssignChats })} />
        </div>
      </div>
      <div className="field">
        <div className="row-between">
          <div>
            <label>{t('桌面通知')}</label>
            <div className="help">{t('不在应用里时，讨论串有结果、需要您确认，或对话回复完成，会发系统通知。')}</div>
          </div>
          <button
            className={'switch' + (settings.notifications !== false ? ' on' : '')}
            onClick={() => api().updateSettings({ notifications: settings.notifications === false })}
          />
        </div>
      </div>
      {useApp.getState().platform !== 'darwin' && (
        <div className="field">
          <div className="row-between">
            <div>
              <label>{t('关闭窗口后在后台运行')}</label>
              <div className="help">{t('应用留在系统托盘里，定时任务和进行中的讨论串照常运行。从托盘菜单退出。')}</div>
            </div>
            <button
              className={'switch' + (settings.runInBackground !== false ? ' on' : '')}
              onClick={() => api().updateSettings({ runInBackground: settings.runInBackground === false })}
            />
          </div>
        </div>
      )}
      <div className="field">
        <div className="row-between">
          <div>
            <label>{t('允许操控电脑')}</label>
            <div className="help">
              {t('打开后，agent 能看到屏幕截图，并在您允许的程序里移动鼠标、点击和输入。它每次都要先列出要用的程序，由您逐个选择「完全控制」「仅点击」或「仅查看」。操控时 Ancora 会最小化，屏幕上方有「停止」按钮。macOS 需要在系统设置里授予「辅助功能」和「录屏」权限；Linux 需要 X11 和 xdotool。')}</div>
            {settings.computerUse && <ComputerBackends />}
          </div>
          <button
            className={'switch' + (settings.computerUse ? ' on' : '')}
            onClick={() => api().updateSettings({ computerUse: !settings.computerUse })}
          />
        </div>
      </div>
    </>
  )
}

/** Which backends can use computer control: the model has to look at screenshots. */
function ComputerBackends() {
  const backends = useApp((s) => s.backends)
  const [images, setImages] = useState<Record<string, boolean | undefined>>({})
  useEffect(() => void api().backendImages().then(setImages), [])
  if (!backends.length) return null
  return (
    <div className="computer-backends">
      {backends.map((b) => (
        <div key={b.id} className={images[b.id] === false ? 'no' : ''}>
          {b.name}
          {'：'}
          {images[b.id] === true
            ? t('可以使用（能看图片）')
            : images[b.id] === false
              ? t('不能使用，它的模型不能看图片')
              : t('用过一次后才知道能否看图片')}
        </div>
      ))}
    </div>
  )
}

function AboutSettings() {
  const [info, setInfo] = useState<AppInfo>()
  const [check, setCheck] = useState<UpdateCheck | 'checking'>()
  useEffect(() => void api().appInfo().then(setInfo), [])
  const rows: [string, string | undefined][] = info
    ? [
        [t('版本'), info.version],
        [t('构建'), [info.commit, info.builtAt].filter(Boolean).join(' · ') || undefined],
        [t('系统'), `${info.platform} ${info.arch}`],
        ['Electron', info.electron],
        ['Chromium', info.chrome],
        ['Node.js', info.node]
      ]
    : []
  return (
    <>
      <h2>{t('关于')}</h2>
      <div className="about-head">
        <div className="about-logo">Co</div>
        <div>
          <div className="title">Ancora</div>
          <div className="small muted">{t('桌面上的 AI 工作台：对话、项目和定时任务，背后的 agent 可以随时更换。')}</div>
          <div className="small muted">{t('非官方开源项目（MIT 许可），与 Anthropic 无关。')}</div>
        </div>
      </div>
      <div className="card about-rows">
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="row-between small">
            <span className="muted">{k}</span>
            <span className="mono">{v}</span>
          </div>
        ))}
      </div>
      <div className="field" style={{ marginTop: 16 }}>
        <div className="row-between">
          <div>
            <label>{t('检查更新')}</label>
            <div className="help">
              {check === 'checking'
                ? t('正在检查…')
                : check?.status === 'latest'
                  ? t('已是最新版本（{0}）', check.version)
                  : check?.status === 'available'
                    ? t('有新版本 {0} 可以下载。', check.version)
                    : check?.status === 'unconfigured'
                      ? t('这个版本还没有配置更新渠道，暂时无法自动检查。')
                      : check?.status === 'error'
                        ? t('检查失败：{0}', check.message)
                        : t('看看有没有新版本。')}
            </div>
            {check !== 'checking' && check?.status === 'available' && check.notes && (
              <div className="help" style={{ whiteSpace: 'pre-wrap' }}>{check.notes}</div>
            )}
          </div>
          {check !== 'checking' && check?.status === 'available' && check.url ? (
            <button className="btn primary" onClick={() => window.open(check.url)}>
              {t('下载')}</button>
          ) : (
            <button
              className="btn"
              disabled={check === 'checking'}
              onClick={async () => {
                setCheck('checking')
                setCheck(await api().checkForUpdates())
              }}
            >
              {t('检查更新')}</button>
          )}
        </div>
      </div>
    </>
  )
}

function AppearanceSettings() {
  const theme = useApp((s) => s.settings.theme)
  return (
    <>
      <h2>{t('外观')}</h2>
      <div className="field">
        <label>{t('主题')}</label>
        <div className="seg-control">
          {(['system', 'light', 'dark', 'glass'] as const).map((th) => (
            <button key={th} className={theme === th ? 'on' : ''} onClick={() => api().updateSettings({ theme: th })}>
              {{ system: t('跟随系统'), light: t('浅色'), dark: t('深色'), glass: t('太空玻璃') }[th]}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>{t('语言')}</label>
        <Dropdown
          className="w-220"
          value={langSetting}
          onChange={(l) => l !== langSetting && setLanguage(l)}
          // Language names are shown in their own language.
          options={[{ value: 'system' as const, label: t('跟随系统') }, ...LANGS.map((l) => ({ value: l.id, label: l.name }))]}
        />
        <div className="help">{t('切换后界面会重新载入。')}</div>
      </div>
    </>
  )
}

function BackendSettings() {
  const backends = useApp((s) => s.backends)
  const def = useApp((s) => s.settings.defaultBackendId)
  const [config, setConfig] = useState<{ error?: string; example: string }>({ example: '' })
  const [showExample, setShowExample] = useState(false)
  // The main process puts the parser's own wording after a 详情 marker. i18n-ignore
  const [errorMain, errorDetail] = (config.error ?? '').split('\n\u8be6\u60c5\uff1a')
  useEffect(() => void api().backendsConfigStatus().then(setConfig), [])
  return (
    <>
      <h2>{t('Agent 后端')}</h2>
      <div className="help small muted" style={{ marginBottom: 16 }}>
        {t('选择回复您的 agent，并填写它需要的账号信息。')}
      </div>
      {config.error && (
        <div className="card error-card" style={{ marginBottom: 16 }}>
          <div className="title">{t('backends.json 有错，没有生效')}</div>
          <div className="small">{errorMain}</div>
          {errorDetail && (
            <details className="small muted" style={{ marginTop: 4 }}>
              <summary>{t('详情')}</summary>
              <code>{errorDetail}</code>
            </details>
          )}
          <div className="small muted" style={{ marginTop: 4 }}>
            {t('现在用的还是上一次能用的后端列表。改好后点「重新加载」。')}</div>
        </div>
      )}
      {backends.map((b) => (
        <div key={b.id} className="card" style={{ marginBottom: 12 }}>
          <div className="row-between">
            <div>
              <div className="title">{b.name}</div>
              <div className="small muted">{b.description}</div>
              {(b.account || b.upgrade) && <AccountLine backendId={b.id} name={b.name} upgrade={b.upgrade} configKey={JSON.stringify(b.configured)} />}
            </div>
            <span className="spacer" />
            {b.signIn && <LoginButton backendId={b.id} />}
            {!b.signIn && b.terminalLogin && <TerminalLoginButton backendId={b.id} />}
            {def === b.id ? (
              <span className="status-chip done">
                <Check size={11} />
                {t('默认')}</span>
            ) : (
              <button className="btn" onClick={() => api().updateSettings({ defaultBackendId: b.id })}>
                {t('设为默认')}</button>
            )}
          </div>
          {b.settings.map((s) => (
            <BackendField key={s.key} backendId={b.id} setting={s} configured={b.configured[s.key]} />
          ))}
        </div>
      ))}
      <details className="advanced">
        <summary>{t('高级')}</summary>
        <div className="help small muted" style={{ margin: '8px 0 12px' }}>
          {t('所有后端都通过同一份调用合约接入。内置插件之外，可以在 backends.json 里写几行配置，接入任何支持 ACP 的 agent 命令行工具，无需改代码。')}{' '}
          <button className="text-link" onClick={() => setShowExample(!showExample)}>
            {showExample ? t('收起示例') : t('看示例')}
          </button>
        </div>
        {showExample && (
          <div className="card" style={{ marginBottom: 12 }}>
            <pre className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{config.example}</pre>
            <div className="small muted" style={{ marginTop: 8 }}>
              {t('settings 里的项会出现在这一页让您填写（标了 secret 的会加密保存），并作为同名环境变量传给 agent。')}
            </div>
            <button className="btn" style={{ marginTop: 8 }} onClick={() => (navigator.clipboard.writeText(config.example), toast(t('已复制示例')))}>
              {t('复制示例')}
            </button>
          </div>
        )}
      <div style={{ display: 'flex', gap: 8, margin: '0 0 8px' }}>
        <button className="btn" onClick={() => api().openConfigFolder()}>
          {t('打开 backends.json')}</button>
        <button
          className="btn"
          onClick={async () => {
            const r = await api().reloadBackends()
            setConfig((c) => ({ ...c, error: r.error }))
            if (r.error) toast(t('backends.json 有错，没有生效，详情见本页'), 'error')
            else toast(t('已重新加载，共 {0} 个后端', r.backends.length))
          }}
        >
          {t('重新加载')}</button>
      </div>
      </details>
    </>
  )
}

/** Runs the backend's own sign-in flow (e.g. a browser login), when it has one. */
export function LoginButton({ backendId, label, onDone }: { backendId: string; label?: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [menu, openMenu] = useMenu({ align: 'right' })
  const login = async (methodId: string) => {
    setBusy(true)
    try {
      await api().backendLogin(backendId, methodId)
      toast(t('登录成功'))
      onDone?.()
    } catch (e) {
      toast(t('登录失败：{0}', e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        className="btn"
        disabled={busy}
        style={{ marginRight: 8 }}
        onClick={async (e) => {
          const el = e.currentTarget
          setBusy(true)
          let methods: { id: string; name: string; description?: string }[] = []
          try {
            methods = await api().backendAuthMethods(backendId)
          } catch (err) {
            toast(t('无法启动后端：{0}', err instanceof Error ? err.message : err), 'error')
          }
          setBusy(false)
          if (!methods.length) return toast(t('这个后端不需要在应用里登录'))
          if (methods.length === 1) return void login(methods[0].id)
          openMenu(el, methods.map((m) => ({ label: m.name, sub: m.description, onClick: () => void login(m.id) })))
        }}
      >
        {busy ? t('正在登录…') : (label ?? t('登录'))}
      </button>
      {menu}
    </>
  )
}

/**
 * Whether the program is installed and the user signed in, asked of the backend's own
 * status command. After 「登录」 opens a terminal it checks again every few seconds until signed in.
 * With an upgrade command, it offers 「检查更新」 (nothing goes online just by opening
 * Settings) and then the latest version and an 「升级」 button.
 */
const latestChecked = new Map<string, string | null>()

export function AccountLine({ backendId, configKey, upgrade, name }: { backendId: string; configKey: string; upgrade?: boolean; name: string }) {
  const state = useApp((s) => s.accounts[backendId])
  // undefined: not checked yet; null: the check found nothing.
  const [latest, setLatest] = useState<string | null | undefined>(() => latestChecked.get(backendId))
  const [checking, setChecking] = useState(false)
  const [log, setLog] = useState<string[] | null>(null)
  const [running, setRunning] = useState<'install' | 'upgrade' | null>(null)
  const [failed, setFailed] = useState<'failed' | 'notFound' | null>(null)
  const busy = useApp((s) => s.conversations.some((c) => c.backendId === backendId && c.status === 'working'))
  const summary = useApp((s) => s.backends.find((b) => b.id === backendId))
  const commands = summary?.upgradeCommands ?? []
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined
    const check = () =>
      refreshAccount(backendId).then((a) => {
        if (alive && a.signedIn && timer) clearInterval(timer)
      })
    void check()
    const watch = (e: Event) => {
      if ((e as CustomEvent).detail !== backendId) return
      if (timer) clearInterval(timer)
      const until = Date.now() + 5 * 60_000
      timer = setInterval(() => (Date.now() > until ? clearInterval(timer) : void check()), 3000)
    }
    window.addEventListener('oc-account-watch', watch)
    return () => {
      alive = false
      if (timer) clearInterval(timer)
      window.removeEventListener('oc-account-watch', watch)
    }
  }, [backendId, configKey])
  const checkLatest = async () => {
    setChecking(true)
    const v = (await api().backendLatestVersion(backendId).catch(() => undefined)) ?? null
    latestChecked.set(backendId, v)
    setLatest(v)
    setChecking(false)
  }
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ backendId: string; line: string }>).detail
      if (d.backendId === backendId) setLog((l) => [...(l ?? []), d.line].slice(-200))
    }
    window.addEventListener('oc-upgrade-line', on)
    return () => window.removeEventListener('oc-upgrade-line', on)
  }, [backendId])

  const run = async () => {
    const installing = state?.installed === false
    // Never install on a single click: say exactly what will run, with 取消 focused.
    const ok = await confirmDialog(
      [
        installing ? t('将在您的电脑上安装 {0}，会运行下面的命令：', name) : t('将把 {0} 升级到最新版，会运行下面的命令：', name),
        summary?.upgradeNote ? t('然后：{0}。', summary.upgradeNote) : '',
        busy ? t('升级前会先停止 {0}，正在进行的回复会中断。', name) : ''
      ]
        .filter(Boolean)
        .join('\n\n'),
      { title: installing ? t('安装 {0}？', name) : t('升级 {0}？', name), ok: installing ? t('安装') : t('升级'), danger: false, code: commands.join('\n') }
    )
    if (!ok) return
    setLog([])
    setFailed(null)
    setRunning(installing ? 'install' : 'upgrade')
    try {
      const r = await api().upgradeBackend(backendId)
      useApp.setState((s) => ({ accounts: { ...s.accounts, [backendId]: { ...r.account, at: Date.now() } } }))
      if (r.ok) {
        toast(
          installing
            ? t('{0} 已安装', name)
            : r.account.version
              ? t('{0} 已升级到 {1}', name, r.account.version)
              : t('{0} 已升级', name)
        )
        setLog(null)
      } else if (r.notFound) {
        setFailed('notFound')
        toast(t('{0} 已经装好，但 Ancora 还找不到它', name), 'error')
      } else {
        setFailed('failed')
        toast(installing ? t('{0} 安装失败，原因见设置里的详情', name) : t('{0} 升级失败，原因见设置里的详情', name), 'error')
      }
    } catch (e) {
      setFailed('failed')
      toast(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e), 'error')
    } finally {
      setRunning(null)
    }
  }

  const missing = state?.installed === false
  const newer = !!latest && !!state?.version && newerVersion(latest, state.version)
  const show = state && (state.signedIn !== undefined || state.detail || missing)
  const output = (log ?? []).join('\n')
  return (
    <>
      {(show || upgrade) && (
        <div className="account-line small">
          {missing ? (
            <span className="status-chip error">{t('未安装')}</span>
          ) : (
            state?.signedIn !== undefined && (
              <span className={'status-chip ' + (state.signedIn ? 'done' : 'waiting')}>{state.signedIn ? t('已登录') : t('未登录')}</span>
            )
          )}
          {state?.detail && <span className="muted">{state.detail}</span>}
          {upgrade && !missing && latest === undefined && (
            <button className="text-link" disabled={checking} onClick={() => void checkLatest()}>
              {checking ? t('正在检查…') : t('检查更新')}
            </button>
          )}
          {upgrade && latest && !missing && (
            <span className="muted">{newer ? t('有新版本 {0}', latest) : state?.version ? t('已是最新') : t('最新版本 {0}', latest)}</span>
          )}
          {upgrade && latest === null && !missing && <span className="muted">{t('查不到最新版本')}</span>}
          {upgrade && (missing || failed || (latest !== undefined && (newer || !latest || !state?.version))) && (
            <button className="text-link" disabled={!!running} onClick={() => void run()}>
              {running === 'install' ? t('正在安装…') : running ? t('正在升级…') : missing ? t('安装') : t('升级')}
            </button>
          )}
        </div>
      )}
      {log && running && (
        <pre
          className="upgrade-log"
          ref={(el) => {
            if (el) el.scrollTop = el.scrollHeight
          }}
        >
          {output || t('正在启动…')}
        </pre>
      )}
      {failed && !running && (
        <div className="help small upgrade-help">
          {failed === 'notFound'
            ? t('安装命令已经顺利完成，但 Ancora 还是找不到 {0} 的程序，通常是因为它装进的文件夹不在 Ancora 能看到的 PATH 里。请完全退出 Ancora 再打开；如果还是「未安装」，在终端运行 npm prefix -g，确认它显示的文件夹（macOS/Linux 是其中的 bin）在系统的 PATH 里。', name)
            : t('没装好时，可以在终端里自己运行详情里的第一行命令看看。npm 在 macOS/Linux 上有时需要管理员权限；要走代理时先设好 HTTPS_PROXY。')}
          {output && (
            <details>
              <summary>{t('详情')}</summary>
              <pre className="upgrade-log">{output}</pre>
            </details>
          )}
        </div>
      )}
    </>
  )
}

/** a > b for dotted versions like 1.2.10 (pre-release suffixes ignored). */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

/** Opens a terminal running the backend's own sign-in command (e.g. `qodercli login`). */
export function TerminalLoginButton({ backendId }: { backendId: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className="btn"
      disabled={busy}
      style={{ marginRight: 8 }}
      onClick={async () => {
        setBusy(true)
        try {
          await api().backendTerminalLogin(backendId)
          toast(t('已打开终端，请在里面完成登录，然后回来点「重试」'))
          window.dispatchEvent(new CustomEvent('oc-account-watch', { detail: backendId }))
        } catch (e) {
          toast(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e), 'error')
        } finally {
          setBusy(false)
        }
      }}
    >
      {t('登录')}
    </button>
  )
}

export function BackendField({ backendId, setting, configured }: { backendId: string; setting: { key: string; label: string; secret?: boolean; placeholder?: string; help?: string }; configured: boolean }) {
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState(!configured)
  const save = async () => {
    await api().setBackendSetting(backendId, setting.key, value.trim())
    setEditing(!value.trim())
    setValue('')
    toast(t('已保存，下次对话生效'))
  }
  // A value typed but not yet saved is kept when Settings closes.
  useSaveOnLeave(value, (v) => v.trim() && void api().setBackendSetting(backendId, setting.key, v.trim()))
  return (
    <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
      <label>{setting.label}</label>
      {editing ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            type={setting.secret ? 'password' : 'text'}
            value={value}
            placeholder={setting.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && value.trim() && void save()}
          />
          <button
            className="btn primary"
            onClick={() => void save()}
          >
            {t('保存')}</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="small muted" style={{ flex: 1 }}>{setting.secret ? t('已设置（••••••）') : t('已设置')}</span>
          <button className="btn" onClick={() => setEditing(true)}>
            {t('修改')}</button>
          <button className="btn danger" onClick={() => api().setBackendSetting(backendId, setting.key, '')}>
            {t('清除')}</button>
        </div>
      )}
      {setting.help && <div className="help">{setting.help}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

interface ConnectorDraft {
  id?: string
  name: string
  enabled: boolean
  kind: 'command' | 'http'
  commandLine: string
  url: string
  secretsText: string
  secretKeys: string[]
}

/** The connector form has its own 取消/保存; the list saves as you go. */
function ConnectorSettings({ onFormChange }: { onFormChange: (open: boolean) => void }) {
  const [list, setList] = useState<ConnectorView[] | null>(null)
  const [draft, setDraft] = useState<ConnectorDraft | null>(null)
  const reload = () => api().listConnectors().then(setList)
  useEffect(() => {
    void reload()
  }, [])

  useEffect(() => {
    onFormChange(!!draft)
    return () => onFormChange(false)
  }, [draft, onFormChange])
  if (draft) return <ConnectorForm draft={draft} onDone={() => (setDraft(null), void reload())} />
  return (
    <>
      <h2>{t('连接器')}</h2>
      <div className="help small muted" style={{ marginBottom: 16 }}>
        {t('连接器让 agent 用上更多工具，例如文件系统、GitHub、数据库。加一次，所有对话和项目里的 agent 都能用。')}</div>
      {list?.length === 0 && <div className="empty" style={{ padding: '20px 0' }}>{t('还没有连接器。')}</div>}
      {list?.map((c) => (
        <div key={c.id} className="card" style={{ marginBottom: 10 }}>
          <div className="row-between">
            <div style={{ minWidth: 0 }}>
              <div className="title">{c.name}</div>
              <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.kind === 'http' ? c.url : [c.command, ...(c.args ?? [])].join(' ')}
              </div>
            </div>
            <span className="spacer" />
            <button
              className="btn"
              style={{ marginRight: 8 }}
              onClick={() =>
                setDraft({
                  id: c.id,
                  name: c.name,
                  enabled: c.enabled,
                  kind: c.kind,
                  commandLine: [c.command, ...(c.args ?? [])].filter((x): x is string => !!x).map(quoteArg).join(' '),
                  url: c.url ?? '',
                  secretsText: '',
                  secretKeys: c.secretKeys
                })
              }
            >
              {t('编辑')}</button>
            <button
              className={'switch' + (c.enabled ? ' on' : '')}
              title={c.enabled ? t('已启用') : t('已停用')}
              onClick={async () => {
                await api().saveConnector({ ...c, enabled: !c.enabled })
                void reload()
              }}
            />
          </div>
        </div>
      ))}
      <button
        className="btn"
        onClick={() => setDraft({ name: '', enabled: true, kind: 'command', commandLine: '', url: '', secretsText: '', secretKeys: [] })}
      >
        <Plus size={14} />
        {t('添加连接器')}</button>
    </>
  )
}

function ConnectorForm({ draft: initial, onDone }: { draft: ConnectorDraft; onDone: () => void }) {
  const [d, setD] = useState(initial)
  const [error, setError] = useState('')
  // Esc closes this form first, not the whole Settings window; typed changes aren't dropped without asking.
  useLayer(async () => {
    if (JSON.stringify(d) !== JSON.stringify(initial) && !(await confirmDialog(t('放弃没保存的连接器？'), { ok: t('放弃') }))) return
    onDone()
  })
  const set = (p: Partial<ConnectorDraft>) => setD({ ...d, ...p })
  const save = async () => {
    const words = splitArgs(d.commandLine)
    const secrets: Record<string, string> = {}
    for (const line of d.secretsText.split('\n')) {
      const m = /^\s*([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line)
      if (m) secrets[m[1]] = m[2].trim()
    }
    try {
      await api().saveConnector({
        id: d.id,
        name: d.name,
        enabled: d.enabled,
        kind: d.kind,
        command: words[0],
        args: words.slice(1),
        url: d.url,
        secrets
      })
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    }
  }
  return (
    <>
      <h2>{d.id ? t('编辑连接器') : t('添加连接器')}</h2>
      <div className="field">
        <label>{t('名称')}</label>
        <input className="input" value={d.name} placeholder="filesystem" onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="field">
        <label>{t('类型')}</label>
        <div className="seg-row">
          <button className={'btn' + (d.kind === 'command' ? ' primary' : '')} onClick={() => set({ kind: 'command' })}>
            {t('本地命令')}</button>
          <button className={'btn' + (d.kind === 'http' ? ' primary' : '')} onClick={() => set({ kind: 'http' })}>
            {t('远程地址')}</button>
        </div>
      </div>
      {d.kind === 'command' ? (
        <div className="field">
          <label>{t('命令')}</label>
          <input
            className="input"
            value={d.commandLine}
            placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Documents"
            onChange={(e) => set({ commandLine: e.target.value })}
          />
        </div>
      ) : (
        <div className="field">
          <label>{t('地址')}</label>
          <input className="input" value={d.url} placeholder="https://example.com/mcp" onChange={(e) => set({ url: e.target.value })} />
        </div>
      )}
      <div className="field">
        <label>{d.kind === 'command' ? t('环境变量') : t('请求头')}{t('（每行一个 KEY=值，加密保存）')}</label>
        <textarea
          className="textarea"
          style={{ minHeight: 70, fontFamily: 'var(--font-mono)', fontSize: 13 }}
          value={d.secretsText}
          placeholder={d.kind === 'command' ? 'GITHUB_TOKEN=...' : 'Authorization=Bearer ...'}
          onChange={(e) => set({ secretsText: e.target.value })}
        />
        {d.secretKeys.length > 0 && (
          <div className="help">{t('已保存：')}{d.secretKeys.join(t('、'))}{t('。重新填写会覆盖，写成 KEY= 会删除。')}</div>
        )}
      </div>
      {error && <div className="msg-error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
        <div>
          {d.id && (
            <button
              className="btn danger"
              onClick={async () => {
                if (!(await confirmDialog(t('删除连接器「{0}」？', d.name)))) return
                await api().deleteConnector(d.id!)
                onDone()
              }}
            >
              {t('删除')}</button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onDone}>
            {t('取消')}</button>
          <button className="btn primary" onClick={save}>
            {t('保存')}</button>
        </div>
      </div>
    </>
  )
}

/** Splits a command line into words, honouring single and double quotes. */
export function splitArgs(line: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]))
  return out
}

function quoteArg(a: string): string {
  return /[\s"']/.test(a) ? JSON.stringify(a) : a
}
