import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronRight, Circle, CircleAlert, History, MessageSquare, Square, SquareTerminal } from 'lucide-react'
import type { Conversation } from '@shared/model'
import { canStopTask, taskIsFinished, type BackgroundTask } from '@shared/backgroundTasks'
import { api, toastError, useApp } from '../../store'
import { duration } from '../../util'
import { t } from '../../i18n'
import { PanelState } from '../PanelState'
import { usePanePresence } from '../usePanePresence'
import { useBackgroundTasks } from './useBackgroundTasks'
import { CommandOutput } from './CommandOutput'

type Screen = { kind: 'active' | 'finished' } | { kind: 'command'; key: string; from: 'active' | 'finished' }
const PREVIEW_LIMIT = 4
export function taskLabel(task: BackgroundTask): string {
  if (task.kind === 'command' && task.command.monitor && task.state === 'running') return t('监视中')
  return { running: t('运行中'), waiting: t('等待您'), failed: t('失败'), done: t('已完成'), ended: t('已结束'), idle: t('空闲') }[task.state]
}

function TaskIcon({ task }: { task: BackgroundTask }) {
  const Icon = task.state === 'failed' || task.state === 'waiting' ? CircleAlert : task.state === 'done' ? Check : task.kind === 'conversation' ? MessageSquare : task.state === 'ended' ? Circle : SquareTerminal
  return <Icon size={15} className={`background-task-icon ${task.state}`} aria-hidden="true" />
}

function StopTask({ task }: { task: BackgroundTask }) {
  const [stopping, setStopping] = useState(false)
  if (!canStopTask(task)) return null
  return <button className="icon-btn sm background-stop" aria-label={t('停止任务：{0}', task.title)} data-tip={t('停止')} disabled={stopping} aria-busy={stopping} onClick={async event => {
    event.currentTarget.closest('.background-panel')?.querySelector<HTMLElement>('[data-background-heading]')?.focus({ preventScroll: true })
    setStopping(true)
    try { if (task.kind === 'command') await api().stopCommand(task.ownerId, task.command.id); else await api().cancel(task.ownerId) }
    catch (error) { toastError(error) }
    finally { setStopping(false) }
  }}><Square size={12} aria-hidden="true" /></button>
}

/** Claude's task rail: compact activity rows, four visible by default, and one
 * finished-history entry. Details replace the list inside the same surface. */
export function BackgroundPanel({ conv }: { conv: Conversation }) {
  const tasks = useBackgroundTasks(conv), navigate = useApp(s => s.navigate)
  const [screen, setScreen] = useState<Screen>({ kind: 'active' })
  const [showAll, setShowAll] = useState(false)
  const [now, setNow] = useState(Date.now)
  const scroll = useRef<HTMLDivElement>(null), focusKey = useRef<string | null>(null), tops = useRef({ active: 0, finished: 0 })
  const active = tasks.filter(task => !taskIsFinished(task)), finished = tasks.filter(taskIsFinished)
  const running = active.filter(task => task.state === 'running').length
  const failed = finished.filter(task => task.state === 'failed').length
  const selected = screen.kind === 'command' ? tasks.find(task => task.key === screen.key) : undefined
  const extra = usePanePresence(showAll)
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  useLayoutEffect(() => {
    const el = scroll.current
    if (!el || focusKey.current === null) return
    if (screen.kind !== 'command') el.scrollTop = tops.current[screen.kind]
    const key = focusKey.current
    const row = [...el.querySelectorAll<HTMLElement>('[data-task-key]')].find(row => row.dataset.taskKey === key)
    ;(row ?? el.querySelector<HTMLElement>('[data-background-heading]'))?.focus({ preventScroll: true })
    focusKey.current = null
  }, [screen])
  function changeScreen(next: Screen, focus = '') {
    if (screen.kind !== 'command' && scroll.current) tops.current[screen.kind] = scroll.current.scrollTop
    focusKey.current = focus
    setScreen(next)
  }
  function open(task: BackgroundTask) {
    if (task.kind === 'conversation') navigate({ view: 'chat', conversationId: task.ownerId })
    else changeScreen({ kind: 'command', key: task.key, from: screen.kind === 'finished' ? 'finished' : 'active' })
  }
  function row(task: BackgroundTask) {
    const elapsed = task.kind === 'command' && task.state === 'running' ? duration(now - task.command.startedAt) : taskLabel(task)
    return <div className="background-task" data-state={task.state} key={task.key}>
      <button className="background-task-open" data-task-key={task.key} aria-current={task.kind === 'conversation' && task.ownerId === conv.id ? 'page' : undefined} onClick={() => open(task)}>
        <TaskIcon task={task} />
        <span className="background-task-title" data-tip={task.title}>{task.title}</span>
        <span className="background-task-meta" aria-label={task.state === 'running' ? taskLabel(task) : undefined}>{elapsed}</span>
      </button>
      <StopTask task={task} />
    </div>
  }
  return <div className="background-panel" ref={scroll}>
    {screen.kind === 'command' ? <div className="background-detail" key={screen.key}>
      <div className="background-heading">
        <button className="icon-btn sm" aria-label={t('返回任务列表')} onClick={() => changeScreen({ kind: screen.from }, screen.key)}><ArrowLeft size={16}/></button>
        <h3 tabIndex={-1} data-background-heading>{screen.from === 'finished' ? t('已结束') : t('后台任务')}</h3>
      </div>
      {selected?.kind === 'command' ? <>
        <div className="background-detail-title"><TaskIcon task={selected}/><h4>{selected.title}</h4><StopTask task={selected}/></div>
        <div className="background-detail-meta" data-state={selected.state}>
          <span>{taskLabel(selected)}</span>
          {selected.state === 'running' && <span>{duration(now - selected.command.startedAt)}</span>}
          {selected.command.exitCode != null && <span>{t('退出码 {0}', selected.command.exitCode)}</span>}
        </div>
        <CommandOutput task={selected}/>
      </> : <PanelState title={t('任务记录已不可用')}/>}</div>
    : <div className="background-list" key={screen.kind}>
      <div className="background-heading">
        {screen.kind === 'finished' && <button className="icon-btn sm" aria-label={t('返回后台任务')} onClick={() => changeScreen({ kind: 'active' }, 'finished')}><ArrowLeft size={16}/></button>}
        <h3 tabIndex={-1} data-background-heading>{screen.kind === 'finished' ? t('已结束') : t('后台任务')}</h3>
        {screen.kind === 'active' && running > 0 && <span>{t('{0} 项运行中', running)}</span>}
      </div>
      {screen.kind === 'finished' ? finished.length ? finished.map(row) : <PanelState title={t('没有已结束的任务')}/>
      : <>
        {active.slice(0, PREVIEW_LIMIT).map(row)}
        {extra.present && <div className="steps-fold" data-exiting={extra.exiting || undefined} inert={extra.exiting}><div className="steps-clip">{active.slice(PREVIEW_LIMIT).map(row)}</div></div>}
        {active.length > PREVIEW_LIMIT && <button className="background-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? t('收起') : t('查看其余 {0} 项', active.length - PREVIEW_LIMIT)}<ChevronRight size={13} className={showAll ? 'expanded' : ''}/></button>}
        {!active.length && <PanelState title={finished.length ? t('没有正在运行的任务') : t('没有后台任务')}>{!finished.length && t('开始子对话或后台命令后，进展会显示在这里。')}</PanelState>}
        {finished.length > 0 && <button className="background-history" data-task-key="finished" onClick={() => changeScreen({ kind: 'finished' })}><History size={15}/><span>{t('{0} 项已结束', finished.length)}</span>{failed > 0 && <span className="background-failures">{t('{0} 项失败', failed)}</span>}<ChevronRight size={14}/></button>}
      </>}
    </div>}
  </div>
}
