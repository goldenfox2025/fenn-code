import { Component, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, LayoutGrid, Plus, RotateCcw, X } from 'lucide-react'
import { useMenu, type MenuItem } from '../components/Menu'
import { api, useApp } from '../store'
import { t } from '../i18n'
import { useWidgets, type Widget } from './registry'
import { WidgetSlot } from './WidgetCard'
// Cards agents made register as widgets too.
import './BoardCards'

/**
 * The widgets the user chose, in their order (all registered ones until they change it).
 * Each widget's menu moves it, removes it, or adds one that is not shown.
 */
export function WidgetBoard() {
  const all = useWidgets()
  const saved = useApp((s) => s.settings.homeWidgets)
  const shown = saved ? saved.flatMap((id) => all.filter((w) => w.id === id)) : all
  const hidden = all.filter((w) => !shown.includes(w))
  const ids = shown.map((w) => w.id)
  const save = (next: string[]) => void api().updateSettings({ homeWidgets: next })
  const move = (id: string, by: number) => {
    const next = ids.filter((x) => x !== id)
    next.splice(ids.indexOf(id) + by, 0, id)
    save(next)
  }
  const addItems = (): MenuItem[] => hidden.map((w) => ({ label: w.title, onClick: () => save([...ids, w.id]) }))
  const menuOf = (w: Widget, i: number) => (): MenuItem[] => [
    ...(w.actions ? [...w.actions(), { separator: true }] : []),
    ...(i > 0 ? [{ icon: <ArrowUp size={15} />, label: t('上移'), onClick: () => move(w.id, -1) }] : []),
    ...(i < shown.length - 1 ? [{ icon: <ArrowDown size={15} />, label: t('下移'), onClick: () => move(w.id, 1) }] : []),
    ...(hidden.length ? [{ icon: <Plus size={15} />, label: t('添加小组件'), submenu: addItems() }] : []),
    ...(saved ? [{ icon: <RotateCcw size={15} />, label: t('恢复默认小组件'), onClick: () => void api().updateSettings({ homeWidgets: undefined }) }] : []),
    { separator: true },
    { icon: <X size={15} />, label: t('移除小组件'), onClick: () => save(ids.filter((x) => x !== w.id)) }
  ]
  const [menu, open] = useMenu({ compact: true })

  // Every widget removed: one quiet way to bring them back.
  if (!shown.length)
    return hidden.length ? (
      <div className="widget-restore">
        <button className="btn ghost" onClick={(e) => open(e.currentTarget, addItems())}>
          <LayoutGrid size={15} />
          {t('添加小组件')}
        </button>
        {menu}
      </div>
    ) : null

  return (
    <div className="widget-board">
      {shown.map((w, i) => (
        <WidgetSlot.Provider key={w.id} value={{ widget: w, menu: menuOf(w, i) }}>
          <Contained>
            <w.Component />
          </Contained>
        </WidgetSlot.Provider>
      ))}
    </div>
  )
}

/** A widget that throws (a plugin's, say) disappears instead of taking the page with it. */
class Contained extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.error('widget failed', error)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}
