import { CalendarClock, Clock, Plus } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../store'
import { t } from '../../i18n'
import { minuteTime } from '../../util'
import { ProjectSection, ProjectEmpty } from './ProjectSection'

export function ProjectSchedules({ projectId }: { projectId: string }) {
  const routines = useApp(useShallow((state) => state.routines.filter((routine) => routine.target.projectId === projectId)))
  const create = () => useApp.getState().set({ settingsOpen: `routine:new:${projectId}` })
  const action = <button className={routines.length ? 'btn primary' : 'btn sm'} onClick={create}><Plus size={14} />{t('新建定时任务')}</button>
  return <ProjectSection title={t('定时任务')} icon={<CalendarClock size={18} />} action={routines.length ? action : undefined}
    description={routines.length ? t('按时间自动在这个项目里运行的任务。') : undefined}>
    {!routines.length ? <ProjectEmpty compact icon={<CalendarClock size={26} />} title={t('让重复工作按时运行')}
      description={t('设置检查、整理或跟进的时间，结果回到这个项目。')} action={action} />
      : <div className="project-routines">{routines.map((routine) => <button key={routine.id} className="project-routine"
        onClick={() => useApp.getState().set({ settingsOpen: `routine:${routine.id}` })}>
        <span className="project-routine-icon"><Clock size={17} /></span>
        <span className="project-routine-copy"><strong>{routine.name}</strong><small>{routine.nextRunAt ? `${t('下次运行：')}${minuteTime(routine.nextRunAt)}` : t('暂无下次运行时间')}</small></span>
        <span className={'status-chip ' + (routine.enabled ? 'done' : '')}>{routine.enabled ? t('启用') : routine.pausedByArchive ? t('随项目暂停') : t('暂停')}</span>
      </button>)}</div>}
  </ProjectSection>
}
