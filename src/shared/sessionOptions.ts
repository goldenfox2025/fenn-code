import type { SessionOption } from './contract'
import type { AppSettings } from './model'

export interface SessionOptionPolicy { hideNoneReasoning?: boolean }

export function sessionOptionDefaults(settings: AppSettings, backendId: string, modelId?: string): Record<string, string> {
  return { ...settings.backendOptionDefaults?.[backendId], ...(modelId ? settings.backendModelOptionDefaults?.[backendId]?.[modelId] : undefined) }
}

/** One normalization path for live protocol options and persisted catalogs. */
export function visibleSessionOptions(options: SessionOption[], policy?: SessionOptionPolicy): SessionOption[] {
  return options.map((option) => policy?.hideNoneReasoning &&
    (option.category === 'thought_level' || /reasoning|effort|thinking/i.test(option.id))
    ? { ...option, choices: option.choices.filter((choice) => choice.value.toLowerCase() !== 'none') } : option)
    .filter((option) => option.choices.length > 1)
}
