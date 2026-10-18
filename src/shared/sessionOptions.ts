import type { SessionOption } from './contract'
import type { AppSettings } from './model'

export interface SessionOptionPolicy { hideNoneReasoning?: boolean }

export function sessionOptionDefaults(settings: AppSettings, backendId: string, modelId?: string): Record<string, string> {
  return { ...settings.backendOptionDefaults?.[backendId], ...(modelId ? settings.backendModelOptionDefaults?.[backendId]?.[modelId] : undefined) }
}

/**
 * Choices that belong to one chat and never become a new chat's default: the permission mode, and the
 * role Claude Code's session runs as (its "Agent" option, e.g. claude-code-guide). An earlier version could
 * save either; a saved one is ignored.
 */
export function perChatOption(o: Pick<SessionOption, 'id' | 'name' | 'category'>): boolean {
  return o.category === 'mode' || /^agent$/i.test(o.id) || /^agent$/i.test(o.name)
}

/** One normalization path for live protocol options and persisted catalogs. */
export function visibleSessionOptions(options: SessionOption[], policy?: SessionOptionPolicy): SessionOption[] {
  return options.map((option) => policy?.hideNoneReasoning &&
    (option.category === 'thought_level' || /reasoning|effort|thinking/i.test(option.id))
    ? { ...option, choices: option.choices.filter((choice) => choice.value.toLowerCase() !== 'none') } : option)
    .filter((option) => option.choices.length > 1)
}

/** The session runs in a mode that lets the agent work anywhere without asking (bypassPermissions, full-access, yolo). */
export function trustsAgent(options: SessionOption[] | undefined): boolean {
  const mode = options?.find((o) => o.category === 'mode' || o.id === 'mode')
  return !!mode?.current && /bypass|full[-_ ]?access|yolo|danger/i.test(mode.current)
}
