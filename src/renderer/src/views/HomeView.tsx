import { useEffect, useState } from 'react'
import { Bot, Code2, FolderKanban, Lightbulb, PenLine, Sparkles } from 'lucide-react'
import { FoxMark } from '../components/FoxMark'
import { Composer } from '../components/Composer'
import type { Attachment } from '@shared/model'
import { api, useApp } from '../store'
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
    // Installed as far as the latest check says (an install from Settings shows at once).
    const installed = (id: string) => (s.accounts[id]?.installed ?? s.backends.find((b) => b.id === id)?.installed) !== false
    const ok = (id?: string) => !!id && s.backends.some((b) => b.id === id) && installed(id)
    if (ok(chosenBackend)) return chosenBackend
    if (ok(s.settings.defaultBackendId)) return s.settings.defaultBackendId
    return (s.backends.find((b) => b.id === 'codex' && installed(b.id)) ?? s.backends.find((b) => installed(b.id)))?.id
  })
  const [modelId, setModelId] = useState<string | undefined>(undefined)
  useEffect(() => {
    setBackendId(settings.defaultBackendId)
    setModelId(undefined)
  }, [settings.defaultBackendId])
  const [seed, setSeed] = useState(0)
  // No folder unless the user picks one; one is found or made once the chat needs it.
  const [folder, setFolder] = useState<string>(initialFolder ?? '')

  // A failure comes back to the composer, which keeps the text and says what went wrong.
  const start = async (text: string, attachments: Attachment[], optionValues?: Record<string, string>) => {
    const conv = await api().startChat({ text, attachments, backendId, cwd: folder || undefined, modelId, optionValues })
    navigate({ view: 'chat', conversationId: conv.id })
  }

  // The welcome and composer share the same reading column as a conversation.
  return (
    <div className="home">
      <div className="scroll home-board">
        <div className="home-board-inner">
          <h1 className="greeting">
            <FoxMark size={32} className="logo" />
            {greeting(settings.userName)}
          </h1>
        </div>
      </div>
      <div className="home-dock">
        {backendId && (
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
        )}
        {/* No agent installed: nothing could answer, so the page says how to get one instead of offering a box. */}
        {!backendId ? (
          <div className="composer-wrap">
          <div className="no-agent-card">
            <Bot size={20} className="no-agent-icon" />
            <div className="no-agent-text">
              <div className="title">{t('还没有可用的 agent')}</div>
              <div className="small muted">{t('Fenn Code 本身不含模型，回答来自您电脑上的 agent，例如 Codex 或 Claude Code。先装一个，就可以开始对话。')}</div>
            </div>
            <button className="btn primary" onClick={() => useApp.getState().set({ settingsOpen: 'backends' })}>
              {t('安装 agent')}
            </button>
          </div>
          </div>
        ) : (
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
        )}
      </div>
    </div>
  )
}
