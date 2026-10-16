import type { SessionOption } from '@shared/contract'
import { lang, t } from '../i18n'

export function optionLabel(o: SessionOption): string {
  if (o.category === 'mode') return t('权限模式')
  if (o.category === 'thought_level') return t('思考强度')
  return o.name
}

/** Common English names agents give their modes and levels, in Chinese when the UI is. */
const CHOICE_ZH: Record<string, string> = {
  default: '每次询问', // i18n-ignore
  'accept edits': '自动接受编辑', // i18n-ignore
  auto: '自动判断', // i18n-ignore
  "don't ask": '不询问，直接拒绝', // i18n-ignore
  'bypass permissions': '全部允许', // i18n-ignore
  plan: '只做计划', // i18n-ignore
  'plan mode': '只做计划', // i18n-ignore
  minimal: '最低', // i18n-ignore
  none: '不启用推理', // i18n-ignore
  low: '低', // i18n-ignore
  medium: '中', // i18n-ignore
  high: '高', // i18n-ignore
  max: '最高', // i18n-ignore
  xhigh: '很高', // i18n-ignore
  'extra high effort': '很高', 'high effort': '高', 'medium effort': '中', 'low effort': '低' // i18n-ignore
}
export function choiceLabel(name: string): string {
  if (lang !== 'zh') return name
  const m = name.match(/^(.*?)(\s*\(default\))?$/i)
  const zh = CHOICE_ZH[(m?.[1] ?? name).trim().toLowerCase()]
  return zh ? zh + (m?.[2] ? '（默认）' : '') : name // i18n-ignore
}

