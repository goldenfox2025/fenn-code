import { Plug } from 'lucide-react'
import codex from '../assets/providers/codex.svg'
import claude from '../assets/providers/claude.svg'
import grok from '../assets/providers/grok.svg'
import qoder from '../assets/providers/qoder.svg'
import antigravity from '../assets/providers/antigravity.svg'

const logos: Record<string, string> = { codex, 'claude-code': claude, grok, qoder, antigravity }
/** Local vendor artwork from Lobe Icons (MIT); never a remote image request. */
export function BackendLogo({ id, size = 20 }: { id: string; size?: number }) {
  const src = logos[id]
  return src ? <img className={`backend-logo${id === 'codex' || id === 'grok' ? ' mono' : ''}`} src={src} width={size} height={size} alt="" aria-hidden="true" /> : <Plug size={size} aria-hidden="true" />
}
