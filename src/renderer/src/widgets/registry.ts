import { useSyncExternalStore, type ComponentType } from 'react'
import type { MenuItem } from '../components/Menu'

/**
 * A card on the new-conversation page (usage figures, the heatmap, the most used models…).
 * Each is self-contained: it fetches what it shows and renders inside a WidgetCard, or
 * renders nothing while it has nothing to show. The user picks which ones are shown and
 * in what order (settings.homeWidgets); everything else about a widget is its own.
 *
 * Built-in widgets are files in ./builtin/ whose default export is a Widget, found at
 * build time like backend plugins. A plugin adds one at run time with registerWidget;
 * registering an id that exists replaces that widget.
 */
export interface Widget {
  /** Stable id, saved in the user's layout. */
  id: string
  /** Its name in the add and remove menus. */
  title: string
  /** 'wide' takes the whole row; two 'half' widgets share one (one column on a narrow window). */
  size: 'wide' | 'half'
  /** Where it goes among the built-in set when the user has not arranged them. */
  order: number
  Component: ComponentType
  /** Its own items for its 「…」 menu, above moving and removing it. */
  actions?: () => MenuItem[]
}

const widgets = new Map<string, Widget>()
const listeners = new Set<() => void>()
let snapshot: Widget[] = []

function changed() {
  snapshot = [...widgets.values()].sort((a, b) => a.order - b.order)
  for (const l of listeners) l()
}

/** Adds (or replaces) a widget; returns a function that removes it again. */
export function registerWidget(widget: Widget): () => void {
  widgets.set(widget.id, widget)
  changed()
  return () => {
    if (widgets.get(widget.id) !== widget) return
    widgets.delete(widget.id)
    changed()
  }
}

/** Every registered widget, in their default order. */
export function useWidgets(): Widget[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => snapshot
  )
}

const builtins = import.meta.glob<{ default: Widget }>('./builtin/*.tsx', { eager: true })
for (const mod of Object.values(builtins)) widgets.set(mod.default.id, mod.default)
changed()
