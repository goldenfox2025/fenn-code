import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FilePlus, Folder, FolderPlus, MoreHorizontal, Pencil, Plus, Search, Trash2, Upload, X } from 'lucide-react'
import type { LibraryEntry } from '@shared/model'
import { api, openFileInApp, toastError, useApp } from '../store'
import { encodeLibraryUploads, FileIcon, FilesPane, NameField } from './FilesPane'
import { humanSize } from './Outputs'
import { PanelState } from './PanelState'
import { confirmDialog } from './Modal'
import { t } from '../i18n'
import { useMenu, type MenuItem } from './Menu'

type Source = string
export interface LibrarySource { key: Source; id: string; label: string; chooseFolder?: () => Promise<void> }
type Listing = { root: string; entries: LibraryEntry[]; truncated: boolean }
type Naming = { source: Source; parent: string; dir: boolean; entry?: LibraryEntry }
const keyOf = (source: Source, path = '') => `${source}:${path}`

/** A direct file tree; all files open the shared editor, retaining tree/filter state. */
export function LibraryIndex({ sources, conversationId, className = '', onBrowseChange }: { sources: LibrarySource[]; conversationId: string; className?: string; onBrowseChange?: (browsing: boolean) => void }) {
  const [listings, setListings] = useState<Record<string, Listing | undefined>>({})
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [filter, setFilter] = useState<string | null>(null)
  const [browse, setBrowse] = useState<Source | null>(null), [expanded, setExpanded] = useState<Set<string>>(new Set()), [selected, setSelected] = useState('')
  const [naming, setNaming] = useState<Naming | null>(null)
  const picker = useRef<HTMLInputElement>(null), uploadTarget = useRef(sources.at(-1)!.key), generation = useRef(0), tree = useRef<HTMLDivElement>(null), openFolders = useRef(expanded)
  openFolders.current = expanded
  const [menu, openMenu] = useMenu({ align: 'right' })
  const stamp = useApp(state => { const conversation = state.conversations.find(item => item.id === conversationId); return `${conversation?.status}:${conversation?.updatedAt}` })
  const inspecting = useApp(state => !!state.fileView)
  const sourceId = (source: Source) => sources.find(item => item.key === source)!.id
  const label = (source: Source) => sources.find(item => item.key === source)!.label
  const reload = useCallback(async () => {
    const current = ++generation.current
    try {
      const directories = sources.flatMap(source => ['', ...[...openFolders.current].filter(key=>key.startsWith(source.key+':')).map(key=>key.slice(source.key.length+1))].filter((path,index,all)=>all.indexOf(path)===index).map(path=>({source,path})))
      const values = await Promise.all(directories.map(async ({source,path}) => [keyOf(source.key,path), await api().listLibrary(source.id,path)] as const))
      if (current !== generation.current) return
      setListings(Object.fromEntries(values)); setError(''); setLoaded(true)
    } catch (error) { if (current === generation.current) { setError(error instanceof Error ? error.message : String(error)); setLoaded(true) } }
  }, [sources])
  useEffect(() => { void reload(); return () => { generation.current++ } }, [reload, stamp, inspecting])
  useLayoutEffect(() => { onBrowseChange?.(!!browse) }, [browse, onBrowseChange])
  const loadFolder = async (source: Source, path: string) => {
    const current = generation.current, value = await api().listLibrary(sourceId(source), path)
    if (current === generation.current) setListings(previous => ({ ...previous, [keyOf(source, path)]: value }))
  }
  const toggle = async (source: Source, entry: LibraryEntry) => {
    const key = keyOf(source, entry.path), open = !expanded.has(key)
    setExpanded(previous => { const next = new Set(previous); open ? next.add(key) : next.delete(key); return next })
    if (open) await loadFolder(source, entry.path)
  }
  const openFile = (source: Source, entry: LibraryEntry) => {
    setSelected(keyOf(source,entry.path))
    if (entry.dir) void toggle(source, entry).catch(toastError)
    else { const root = listings[keyOf(source)]?.root; if (root) openFileInApp(`${root}/${entry.path}`, conversationId) }
  }
  const ensureRoot = async (source: Source) => {
    if (listings[keyOf(source)]) return true
    const choose = sources.find(item => item.key === source)?.chooseFolder
    if (!choose) return false
    await choose(); await reload()
    return !!await api().listLibrary(sourceId(source))
  }
  const actions = (source: Source, parent = ''): MenuItem[] => [
    { label: t('新建文件'), icon: <FilePlus size={15}/>, onClick: () => { void ensureRoot(source).then(ok => ok && setNaming({source,parent,dir:false})).catch(toastError) } },
    { label: t('新建文件夹'), icon: <FolderPlus size={15}/>, onClick: () => { void ensureRoot(source).then(ok => ok && setNaming({source,parent,dir:true})).catch(toastError) } },
    { label: t('添加文件…'), icon: <Upload size={15}/>, onClick: () => { void ensureRoot(source).then(ok => { if (ok) { uploadTarget.current=source; picker.current?.click() } }).catch(toastError) } }
  ]
  const context = (source: Source, entry: LibraryEntry): MenuItem[] => [
    {label:t('打开'),icon:entry.dir?<Folder size={15}/>:<FileIcon name={entry.name}/>,onClick:()=>openFile(source,entry)},
    ...(entry.dir?[...actions(source,entry.path),{separator:true}]:[]),
    {label:t('重命名'),icon:<Pencil size={15}/>,onClick:()=>setNaming({source,parent:entry.path.split('/').slice(0,-1).join('/'),dir:entry.dir,entry})},
    {label:t('删除'),icon:<Trash2 size={15}/>,danger:true,onClick:()=>void(async()=>{if(await confirmDialog(t('删除「{0}」？',entry.name),{ok:t('删除')})){await api().deleteLibraryPath(sourceId(source),entry.path);await reload()}})().catch(toastError)}
  ]
  const commit = async (name: string) => {
    if (!naming) return true
    try {
      const {source,parent,dir,entry}=naming
      const path=entry?await api().renameLibraryPath(sourceId(source),entry.path,name):await api().createLibraryEntry(sourceId(source),parent,name,dir)
      setNaming(null);await reload();if(parent)await loadFolder(source,parent)
      if(!entry&&!dir){const listing=await api().listLibrary(sourceId(source));if(listing)openFileInApp(`${listing.root}/${path}`,conversationId)}
      return true
    } catch(error){toastError(error);return false}
  }
  const query=filter?.trim().toLowerCase()||''
  const matches=(source:Source,entry:LibraryEntry):boolean=>!query||entry.name.toLowerCase().includes(query)||entry.dir&&expanded.has(keyOf(source,entry.path))&&!!listings[keyOf(source,entry.path)]?.entries.some(child=>matches(source,child))
  const rows=(source:Source,parent='',depth=0):ReactNode=>{
    const listing=listings[keyOf(source,parent)]
    return <>
      {naming?.source===source&&naming.parent===parent&&!naming.entry&&<div className="library-resource naming" style={{'--depth':depth} as CSSProperties}><FilePlus size={15}/><NameField value="" placeholder={naming.dir?t('文件夹名'):t('文件名')} onCommit={commit} onCancel={()=>setNaming(null)}/></div>}
      {listing?.entries.filter(entry=>matches(source,entry)).map(entry=>{
        const open=expanded.has(keyOf(source,entry.path)),rename=naming?.source===source&&naming.entry?.path===entry.path
        return <div key={entry.path}>
          {rename?<div className="library-resource naming" style={{'--depth':depth} as CSSProperties}><FileIcon name={entry.name}/><NameField value={entry.name} onCommit={commit} onCancel={()=>setNaming(null)}/></div>:<button className={'library-resource'+(selected===keyOf(source,entry.path)?' selected':'')} data-source={source} data-path={entry.path} data-directory={entry.dir||undefined} aria-expanded={entry.dir?open:undefined} style={{'--depth':depth} as CSSProperties} data-tip={entry.name} onClick={()=>openFile(source,entry)} onContextMenu={event=>{event.preventDefault();openMenu(event.currentTarget,context(source,entry))}} onKeyDown={event=>{if(event.key==='F2'){event.preventDefault();setNaming({source,parent,dir:entry.dir,entry})}else if(event.key==='ArrowRight'&&entry.dir&&!open){event.preventDefault();void toggle(source,entry).catch(toastError)}else if(event.key==='ArrowLeft'&&entry.dir&&open){event.preventDefault();void toggle(source,entry).catch(toastError)}}}>
            {entry.dir?open?<ChevronDown size={13} className="library-caret"/>:<ChevronRight size={13} className="library-caret"/>:<span className="library-caret"/>}
            {entry.dir?<Folder size={15}/>:<FileIcon name={entry.name}/>}<span>{entry.name}</span>{!entry.dir&&entry.size!==undefined&&<small>{humanSize(entry.size)}</small>}
          </button>}
          {entry.dir&&open&&rows(source,entry.path,depth+1)}
        </div>
      })}
    </>
  }
  if(browse)return <div className={'resource-library browsing '+className}><FilesPane key={browse} id={sourceId(browse)} rootLabel={label(browse)} onBack={()=>setBrowse(null)}/></div>
  if(!loaded)return <PanelState title={t('正在读取文件…')}/>
  if(error)return <PanelState title={error} action={<button className="btn sm" onClick={()=>void reload()}>{t('重试')}</button>}/>
  const primary=sources[0],upload=sources.at(-1)!,visible=sources.filter((source,index)=>index===0||!!listings[keyOf(source.key)]?.entries.length||naming?.source===source.key)
  return <div className={'resource-library library-overview '+className}>
    <header className="library-index-head"><h3>{t('库')}</h3><div>
      <button className="icon-btn sm" aria-label={t('筛选文件')} data-tip={t('筛选文件')} onClick={()=>setFilter(filter===null?'':null)}><Search size={15}/></button>
      <button className="icon-btn sm" aria-label={t('添加文件…')} data-tip={t('添加文件…')} onClick={()=>{void ensureRoot(upload.key).then(ok=>{if(ok){uploadTarget.current=upload.key;picker.current?.click()}}).catch(toastError)}}><Upload size={15}/></button>
      <button className="icon-btn sm" aria-label={t('添加至{0}',primary.label)} data-tip={t('新建文件')} onClick={event=>openMenu(event.currentTarget,actions(primary.key))}><Plus size={16}/></button>
    </div></header>
    {filter!==null&&<div className="search-field library-index-filter"><Search size={14}/><input autoFocus aria-label={t('筛选文件')} placeholder={t('筛选文件')} value={filter} onChange={event=>setFilter(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setFilter(null)}}}/><button className="icon-btn sm" aria-label={t('清除搜索')} onClick={()=>setFilter(null)}><X size={14}/></button></div>}
    <div ref={tree} className="library-tree" onKeyDown={event=>{
      if((event.target as HTMLElement).tagName!=='BUTTON'||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
      event.preventDefault();const buttons=[...tree.current!.querySelectorAll<HTMLButtonElement>('button.library-resource')],index=buttons.indexOf(event.target as HTMLButtonElement)
      buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,index+(event.key==='ArrowDown'?1:-1)))]?.focus({preventScroll:true})
    }}>
      {visible.map(source=>{const listing=listings[keyOf(source.key)],entries=listing?.entries??[];return <section className="library-source" key={source.key}>
        {sources.length>1&&<div className="library-source-head"><button className="library-section-title" onClick={()=>listing?setBrowse(source.key):void ensureRoot(source.key).catch(toastError)}>{source.label}<ChevronRight size={12}/></button><button className="icon-btn sm" aria-label={t('更多')+' · '+source.label} onClick={event=>openMenu(event.currentTarget,actions(source.key))}><MoreHorizontal size={14}/></button></div>}
        {rows(source.key)}
        {!entries.length&&!naming&&<div className="library-empty">{listing?<span>{t('还没有文件')}</span>:<button onClick={()=>void ensureRoot(source.key).catch(toastError)}>{t('选择工作文件夹')}</button>}</div>}
        {listing?.truncated&&<button className="library-view-all" onClick={()=>setBrowse(source.key)}>{t('查看全部')}<ChevronRight size={13}/></button>}
      </section>})}
      {query&&!Object.values(listings).some(listing=>listing?.entries.some(entry=>entry.name.toLowerCase().includes(query)))&&<p className="library-empty">{t('没有匹配的文件')}</p>}
    </div>
    {sources.length===1&&<button className="library-location" onClick={()=>setBrowse(primary.key)}><Folder size={13}/><span>{primary.label}</span><ChevronRight size={12}/></button>}
    <input ref={picker} type="file" multiple hidden onChange={event=>{const files=event.currentTarget.files,source=uploadTarget.current;if(files?.length)void encodeLibraryUploads(files).then(files=>api().addToLibrary(sourceId(source),'',files)).then(reload).catch(toastError);event.currentTarget.value=''}}/>
    {menu}
  </div>
}
