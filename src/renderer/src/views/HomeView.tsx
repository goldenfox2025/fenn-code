import { useEffect, useState } from 'react'
import { Code2, FolderKanban, Lightbulb, PenLine, Sparkles } from 'lucide-react'
import { Composer } from '../components/Composer'
import type { Attachment } from '@shared/model'
import { api, toast, useApp, toastError } from '../store'
import { greeting } from '../util'
import { t } from '../i18n'

const SUGGESTIONS = [
  { icon: <PenLine size={15} />, label: t('写作'), text: t('帮我起草一封邮件，') },
  { icon: <Lightbulb size={15} />, label: t('学习'), text: t('用通俗的话给我讲讲') },
  { icon: <Code2 size={15} />, label: t('编程'), text: t('帮我写一个脚本，') },
  { icon: <Sparkles size={15} />, label: t('生活'), text: t('给我一些建议：') }
]

export function HomeView({ folder: initialFolder }: { folder?: string }) {
  const settings = useApp((s) => s.settings)
  const navigate = useApp((s) => s.navigate)
  const [chosenBackend, setBackendId] = useState(settings.defaultBackendId)
  // An agent removed while the app runs is not offered: what is shown is what the message goes to.
  const backendId = useApp((s) => {
    const ok = (id?: string) => !!id && s.backends.some((b) => b.id === id && b.installed !== false)
    if (ok(chosenBackend)) return chosenBackend
    if (ok(s.settings.defaultBackendId)) return s.settings.defaultBackendId
    return (s.backends.find((b) => b.id === 'codex' && b.installed !== false) ?? s.backends.find((b) => b.installed !== false))?.id
  })
  const [modelId, setModelId] = useState<string | undefined>(undefined)
  useEffect(() => {
    setBackendId(settings.defaultBackendId)
    setModelId(undefined)
  }, [settings.defaultBackendId])
  const [seed, setSeed] = useState(0)
  // No folder unless the user picks one; one is found or made once the chat needs it.
  const [folder, setFolder] = useState<string>(initialFolder ?? '')

  const start = async (text: string, attachments: Attachment[], optionValues?: Record<string, string>) => {
    try {
      const conv = await api().startChat({ text, attachments, backendId, cwd: folder || undefined, modelId, optionValues })
      navigate({ view: 'chat', conversationId: conv.id })
    } catch (e) {
      toastError(e)
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
        folder={folder}
        onFolderChange={setFolder}
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
