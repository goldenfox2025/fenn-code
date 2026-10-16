/**
 * Every user-facing string in Ancora, in one place.
 *
 * Source strings are the Simplified Chinese text itself (written with 您): code
 * calls t('中文 {0}', arg), and each other language is one file in this folder
 * mapping those Chinese strings to its own (see en.ts). Anything a language
 * hasn't translated falls back to Chinese. Strings defined before the language
 * is known (plugin names, hints) are marked with tk() and translated where shown.
 *
 * Adding a language: copy en.ts to <code>.ts, translate the values, and list it
 * in LANGS below. test/i18n.test.ts checks that no key is missing.
 */
import { en } from './en'

export type Lang = 'zh' | 'en'
export type LangSetting = 'system' | Lang

/** Languages offered in Settings → 通用, with their own names. */
export const LANGS: { id: Lang; name: string; table?: Record<string, string> }[] = [
  { id: 'zh', name: '简体中文' },
  { id: 'en', name: 'English', table: en }
]

/** The language for a setting; 跟随系统 means Chinese for zh-*, English otherwise. */
export function resolveLang(setting: LangSetting | undefined, systemLocale: string): Lang {
  if (setting && setting !== 'system') return setting
  return (systemLocale || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

let current: Lang = 'zh'
export function setLang(l: Lang): void {
  current = l
}
export function getLang(): Lang {
  return current
}

/**
 * Translates a Chinese source string; {0}, {1}… are replaced by args. A
 * translation can pick a word by count with {0:file|files} (singular when the
 * argument is 1).
 */
export function t(zh: string, ...args: unknown[]): string {
  const table = LANGS.find((x) => x.id === current)?.table
  const s = table?.[zh] ?? zh
  if (!args.length) return s
  return s
    .replace(/\{(\d+):([^|}]*)\|([^}]*)\}/g, (_, i: string, one: string, many: string) => (Number(args[Number(i)]) === 1 ? one : many))
    .replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? ''))
}

/** Marks a string for translation without translating it yet (it is translated with t() where shown). */
export function tk(zh: string): string {
  return zh
}

/** For dates and numbers. */
export function localeTag(l: Lang = current): string {
  return l === 'zh' ? 'zh-CN' : 'en-US'
}
