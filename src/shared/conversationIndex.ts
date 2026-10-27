export const CONVERSATION_INDEX_PITCH = 10

/** A local fisheye ridge: the hovered tick peaks, its neighbours taper smoothly. */
export function conversationNodeWeight(distance: number) {
  return Math.abs(distance) >= 50 ? 0 : Math.exp(-((distance / 24) ** 2))
}

/** Only the peak takes full ink. Neighbours stay gray even while still long. */
export function conversationNodeTone(distance: number) {
  const weight = conversationNodeWeight(distance)
  return weight === 1 ? 1 : weight * .28
}

/** Index user turns; a preview may include the reply belonging to that turn. */
export function conversationIndexEntries(messages: readonly { id: string; role: string; text: string }[]) {
  const entries: { id: string; prompt: string; reply: string }[] = []
  for (const message of messages) {
    if (message.role === 'user') entries.push({ id: message.id, prompt: message.text.slice(0, 300), reply: '' })
    else if (message.role === 'assistant' && entries.length) {
      const entry = entries[entries.length - 1]
      entry.reply = [entry.reply, message.text].filter(Boolean).join('\n').slice(0, 600)
    }
  }
  return entries
}

/** Message intervals intersecting the current reading viewport, including partially visible ends. */
export function visibleConversationIds(points: readonly { id: string; offset: number }[], top: number, height: number, totalHeight: number) {
  return points.filter((point, i) => point.offset < top + height && (points[i + 1]?.offset ?? totalHeight) > top).map(point => point.id)
}

/** A compact message index, independent of message length or transcript scroll height. */
export function conversationIndexRows(ids: readonly string[], availableHeight: number) {
  if (!ids.length) return []
  const count = Math.min(ids.length, Math.max(1, Math.floor(availableHeight / CONVERSATION_INDEX_PITCH)))
  const inset = Math.max(0, (availableHeight - count * CONVERSATION_INDEX_PITCH) / 2)
  return Array.from({ length: count }, (_, i) => ({
    ids: ids.slice(Math.floor(i * ids.length / count), Math.floor((i + 1) * ids.length / count)),
    top: inset + i * CONVERSATION_INDEX_PITCH
  }))
}
