import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store/Store'
import type { Message } from '../src/shared/model'
import { ConversationContext, contextFingerprint, parseContextNotes } from '../src/main/core/ConversationContext'

const user = '重要的输入信息：' + '保留原始引用、来源和约束。'.repeat(15)
const output = '实现结论：' + '后台整理与前台对话分离，文件在库中管理。'.repeat(15)
const messages: Message[] = [{ id:'u',conversationId:'c',role:'user',createdAt:1,blocks:[{type:'text',text:user}] }, {id:'a',conversationId:'c',role:'assistant',state:'done',createdAt:2,blocks:[{type:'text',text:output}]}]
const selection = [{kind:'source',title:'输入约束',message_id:'u',quote:user.slice(0,90)},{kind:'output',title:'实现结论',message_id:'a',quote:output.slice(0,90)}]
function fixture() {
  const store = new Store(mkdtempSync(join(tmpdir(),'fenn-context-')))
  store.putConversation({id:'c',kind:'chat',title:'Work',backendId:'fixture',createdAt:1,updatedAt:2,status:'idle'})
  messages.forEach(message=>store.putMessage(message))
  return store
}
describe('traceable conversation resources',()=>{
  it('accepts exact excerpts and rejects fabricated evidence or swapped authors',()=>{
    const notes=parseContextNotes(JSON.stringify([...selection,{...selection[0],quote:'invented requirement'},{...selection[0],kind:'output'},selection[0]]),messages)
    expect(notes).toHaveLength(2)
    expect(notes.map(note=>note.kind)).toEqual(['source','output'])
    expect(()=>parseContextNotes('prose',messages)).toThrow()
  })
  it('deduplicates concurrent requests, persists only validated references and leaves conversation order unchanged',async()=>{
    const store=fixture(), ask=vi.fn().mockResolvedValue(JSON.stringify(selection)), publish=vi.fn(), organizer=new ConversationContext(store,{ask},publish)
    await Promise.all([organizer.refresh('c'),organizer.refresh('c')]);await organizer.refresh('c')
    expect(ask).toHaveBeenCalledTimes(1)
    expect(store.requireConversation('c').contextDigest?.notes).toHaveLength(2)
    expect(store.requireConversation('c').updatedAt).toBe(2)
    expect(ask.mock.calls[0][2]).toMatchObject({timeoutMs:45000})
    store.flush();expect(new Store(store.dir).requireConversation('c').contextDigest?.fingerprint).toBe(contextFingerprint(messages))
  })
  it('never publishes an outdated selection after a new message or an edit',async()=>{
    const store=fixture();let done!:(text:string)=>void
    const ask=vi.fn(()=>new Promise<string>(resolve=>{done=resolve})),publish=vi.fn(),organizer=new ConversationContext(store,{ask},publish)
    const work=organizer.refresh('c');await vi.waitFor(()=>expect(ask).toHaveBeenCalled())
    store.putMessage({...messages[1],blocks:[{type:'text',text:'a new conclusion'}]});done(JSON.stringify(selection));await work
    expect(publish).not.toHaveBeenCalled();expect(store.requireConversation('c').contextDigest).toBeUndefined();store.flush()
  })
  it('does not invoke a model for greetings or an active turn',async()=>{
    const store=fixture(),ask=vi.fn(),organizer=new ConversationContext(store,{ask},()=>{})
    store.putConversation({...store.requireConversation('c'),status:'working'});await organizer.refresh('c')
    store.putConversation({...store.requireConversation('c'),status:'idle'});store.truncateFrom('c','u');store.putMessage({...messages[0],blocks:[{type:'text',text:'hi'}]});await organizer.refresh('c')
    expect(ask).not.toHaveBeenCalled();store.flush()
  })
})
