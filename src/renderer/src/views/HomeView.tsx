import { useState } from 'react'
import { Code2, FolderKanban, Lightbulb, PenLine, Sparkles } from 'lucide-react'
import { Composer, ProjectPicker } from '../components/Composer'
import type { Attachment } from '@shared/model'
import { api, toast, useApp } from '../store'
import { greeting } from '../util'
import { t } from '../i18n'

const SUGGESTIONS = [
  { icon: <PenLine size={15} />, label: t('写作'), text: t('帮我起草一封邮件，') },
  { icon: <Lightbulb size={15} />, label: t('学习'), text: t('用通俗的话给我讲讲') },
  { icon: <Code2 size={15} />, label: t('编程'), text: t('帮我写一个脚本，') },
  { icon: <Sparkles size={15} />, label: t('生活'), text: t('给我一些建议：') }
]

export function HomeView({ projectId: initialProject }: { projectId?: string }) {
  const settings = useApp((s) => s.settings)
  const navigate = useApp((s) => s.navigate)
  const [backendId, setBackendId] = useState(settings.defaultBackendId)
  const [modelId, setModelId] = useState<string | undefined>(undefined)
  const [projectId, setProjectId] = useState<string | undefined>(initialProject)
  const [seed, setSeed] = useState(0)
  // undefined: follow the project's folder or the default one.
  const [folder, setFolder] = useState<string | undefined>(undefined)
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  const folderShown = folder ?? (project?.cwd || '')

  const start = async (text: string, attachments: Attachment[], optionValues?: Record<string, string>) => {
    try {
      const conv = await api().startChat({ text, attachments, backendId, projectId, cwd: folder, modelId, optionValues })
      navigate({ view: 'chat', conversationId: conv.id })
    } catch (e) {
      toast(String(e), 'error')
    }
  }

  return (
    <div className="home">
      <h1 className="greeting">
        <Sparkles size={34} className="logo" />
        {greeting(settings.userName)}
      </h1>
      <Composer
        key={seed}
        placeholder={t('今天想聊点什么？')}
        autoFocus
        onSubmit={start}
        backendId={backendId}
        onBackendChange={(id) => {
          setBackendId(id)
          setModelId(undefined)
        }}
        modelId={modelId}
        onModelChange={setModelId}
        folder={folderShown}
        onFolderChange={setFolder}
        leading={<ProjectPicker projectId={projectId} onChange={setProjectId} />}
      />
      <div className="chips">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            className="chip"
            onClick={() => {
              sessionStorage.setItem('draft:new', s.text)
              setSeed(seed + 1)
            }}
          >
            {s.icon}
            {s.label}
          </button>
        ))}
        <button className="chip" onClick={() => useApp.getState().set({ settingsOpen: 'new-project' })}>
          <FolderKanban size={15} />
          {t('新建项目')}</button>
      </div>
    </div>
  )
}
