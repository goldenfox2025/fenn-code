import { useEffect, useState } from 'react'
import { FileText, Link2, Quote, Loader2, ChevronRight } from 'lucide-react'
import type { ContextNote, Conversation } from '@shared/model'
import { api, openFileInApp, useApp } from '../store'
import { t } from '../i18n'
import { OverviewSection } from './OverviewSection'
import { Markdown } from './Transcript'

/** A reading aid, not a second file manager. Every item retains its provenance. */
export function ConversationResources({ conversation }: { conversation: Conversation }) {
  const messages = useApp(state => state.messages[conversation.id]) || []
  const [working, setWorking] = useState(false), [error, setError] = useState(false), [retry, setRetry] = useState(0)
  const revision = messages.map(message => `${message.id}:${message.state}:${message.editedAt || ''}`).join('|')
  useEffect(() => {
    setWorking(false); setError(false)
    if (conversation.status === 'working' || !messages.length) return
    let live = true
    // Debounce layout/remounts and coalesced final events. The main process
    // deduplicates work and discards stale results independently of this view.
    const timer = setTimeout(() => {
      setWorking(true); setError(false)
      void api().organizeContext(conversation.id).catch(() => { if (live) setError(true) }).finally(() => { if (live) setWorking(false) })
    }, 700)
    return () => { live = false; clearTimeout(timer) }
  }, [conversation.id, conversation.status, revision, retry])
  const liveMessages = messages.filter(message => !message.hidden)
  const notes = (conversation.contextDigest?.notes ?? []).filter(note => liveMessages.some(message => message.id === note.messageId && message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').includes(note.excerpt)))
  const blocks = liveMessages.flatMap(message => message.blocks.map(block => ({block,messageId:message.id})))
  const files = blocks.filter(({block}) => block.type === 'output' || block.type === 'artifact').filter(({block},i,all)=>all.findIndex(item=>JSON.stringify(item.block)===JSON.stringify(block))===i)
  const attachments = blocks.flatMap(({block,messageId}) => block.type === 'attachment' ? [{attachment:block.attachment,messageId}] : []).filter(({attachment},i,all)=>all.findIndex(item=>item.attachment.name===attachment.name && item.attachment.path===attachment.path)===i)
  const sources = notes.filter(note=>note.kind==='source'), outputs = notes.filter(note=>note.kind==='output')
  const hasContent = !!(sources.length || outputs.length || files.length || attachments.length)
  return <div className={'context-overview conversation-resources' + (!hasContent ? ' resources-empty' : '')}>
    {hasContent ? <>
      {!!(outputs.length + files.length) && <OverviewSection title={t('输出内容')} collapsible>
        {outputs.map(note=><ResourceNote key={note.id} note={note} conversationId={conversation.id}/>)}
        {files.map(({block},index)=> block.type==='output'||block.type==='artifact' ? <button key={index} className="context-resource" onClick={()=>{
          if(block.type==='artifact')useApp.getState().set({page:{id:block.artifactId,version:block.version},fileView:null,browserView:null})
          else if(block.kind==='file'&&block.path)openFileInApp(block.path,conversation.id)
          else if(block.url)window.open(block.url,'_blank')
        }}>{block.type==='output'&&block.kind==='link'?<Link2 size={16}/>:<FileText size={16}/>}<span>{block.title}</span></button>:null)}
      </OverviewSection>}
      {!!(sources.length + attachments.length) && <OverviewSection title={t('来源')} collapsible>
        {sources.map(note=><ResourceNote key={note.id} note={note} conversationId={conversation.id}/>)}
        {attachments.map(({attachment,messageId},index)=><button key={index} className="context-resource" onClick={()=>attachment.path?openFileInApp(attachment.path,conversation.id):useApp.getState().set({focusMessage:messageId})}>
          {attachment.kind==='image'&&attachment.data?<img className="resource-thumb" src={`data:${attachment.mimeType};base64,${attachment.data}`} alt=""/>:<FileText size={16}/>}<span>{attachment.name}</span>
        </button>)}
      </OverviewSection>}
    </> : !working && !error && <p className="context-empty-line">{t('重要输入与结论会自动整理在这里。')}</p>}
    {working && <div className="context-organizing" role="status"><Loader2 size={13} className="spin"/>{t('正在整理资料…')}</div>}
    {error && <div className="context-organizing">{t('资料暂未整理')}<button onClick={()=>setRetry(retry+1)}>{t('重试')}</button></div>}
  </div>
}

function ResourceNote({note,conversationId}:{note:ContextNote;conversationId:string}) {
  return <details className="context-note"><summary><Quote size={14}/><span><strong>{note.title}</strong><small>{note.excerpt.replace(/[`#>*_]/g,'').replace(/\s+/g,' ')}</small></span><ChevronRight size={13}/></summary>
    <div className="context-note-body"><Markdown text={note.excerpt}/><button className="context-note-origin" onClick={()=>{
      const state=useApp.getState();state.set({focusMessage:note.messageId});
      if(state.route.view==='chat'&&state.route.conversationId===conversationId)return
      const conversation=state.conversations.find(item=>item.id===conversationId)
      if(conversation?.projectId)state.navigate({view:'project',projectId:conversation.projectId,threadId:conversation.kind==='thread'?conversation.id:undefined})
      else state.navigate({view:'chat',conversationId})
    }}>{t('查看原消息')}<ChevronRight size={12}/></button></div>
  </details>
}
