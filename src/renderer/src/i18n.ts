/**
 * The renderer's side of src/shared/i18n. The language is fixed for the page's
 * lifetime (changing it reloads); it is cached locally so the first paint is
 * already in the right language, and saved in settings so the main process
 * (menus, notifications, errors) uses it too.
 */
import { localeTag, resolveLang, setLang, t, type Lang, type LangSetting } from '@shared/i18n'

export { t }
export type { Lang, LangSetting }

function stored(): LangSetting {
  try {
    const v = localStorage.getItem('oc-lang')
    return v === 'zh' || v === 'en' ? v : 'system'
  } catch {
    return 'system'
  }
}

export const langSetting: LangSetting = stored()
export const lang: Lang = resolveLang(langSetting, navigator.language)
setLang(lang)
document.documentElement.lang = localeTag(lang)

export async function setLanguage(l: LangSetting): Promise<void> {
  try {
    if (l === 'system') localStorage.removeItem('oc-lang')
    else localStorage.setItem('oc-lang', l)
  } catch {
    /* private storage: stays for this session only */
  }
  await window.ancora.updateSettings({ language: l }).catch(() => {})
  location.reload()
}

/** For dates and numbers. */
export const locale = localeTag(lang)
