/**
 * Recognises the common ways an agent turn fails (sign-in, network, rate
 * limits…) from the raw error text, which is usually the agent's own English.
 * The UI turns the kind into a plain Chinese sentence and keeps the original
 * under 「详情」.
 */
import { t } from './i18n'

export type ErrorKind = 'filesystem' | 'refresh' | 'auth' | 'forbidden' | 'quota' | 'rate' | 'network' | 'timeout' | 'server'

const RULES: [ErrorKind, RegExp][] = [
  // Local .auth/session paths can contain "auth" even when credentials are valid.
  ['filesystem', /\b(EPERM|EACCES|EROFS|operation not permitted|read-only file system)\b/i],
  // Another process of the same CLI was renewing the sign-in at that moment; retrying usually works.
  ['refresh', /failed to refresh (?:the )?oauth token|another \S+(?: \S+)? process is refreshing/i],
  ['quota', /\b(quota|insufficient[_ ](?:balance|credits?|funds)|billing|credit balance|out of credits|payment required|\b402\b)/i],
  [
    'auth',
    /(\bauth(?:entication|orization)?[_ ]?(?:required|failed|error|token)|\bunauthori[sz]ed\b|\b401\b|not (?:logged|signed) in|log ?in required|please (?:log|sign) ?in|run \S+ login|invalid (?:api[_ -]?key|token|credentials)|(?:api[_ -]?key|token)\b.{0,20}\b(?:missing|invalid|expired|not set)|(?:token|session|credentials?) (?:has )?expired|需要登录)/i
  ],
  ['forbidden', /\b(403|forbidden|permission denied by (?:the )?(?:server|api)|access denied)\b/i],
  ['rate', /\b(429|rate[_ ]?limit(?:ed)?|too many requests|overloaded|capacity)\b/i],
  [
    'network',
    /\b(ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNABORTED|fetch failed|socket hang up|getaddrinfo|network (?:error|is unreachable)|unable to connect|could not connect|connection (?:refused|reset|error)|proxy error|certificate|self[- ]signed|TLS)\b/i
  ],
  ['timeout', /\b(ETIMEDOUT|timed? ?out|deadline exceeded|\b504\b)/i],
  ['server', /\b(50[0-3]|internal server error|bad gateway|service unavailable)\b/i]
]

/** Only English (or mixed) text gets a kind; a message the app already wrote in Chinese is shown as is. */
export function classifyError(raw: string | undefined): ErrorKind | null {
  if (!raw) return null
  for (const [kind, re] of RULES) if (re.test(raw)) return kind
  return null
}

/** True when the text is already a sentence the app wrote for the user (Chinese). */
export function isFriendly(raw: string): boolean {
  return /[一-鿿]/.test(raw.trim().slice(0, 40))
}

/** The message of anything thrown, without Electron's "Error invoking remote method 'oc:x': Error: " wrapper. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/**
 * What the system said ("EINVAL: invalid argument, open 'C:\\…'"), as a sentence: the code
 * in words and the file's name, never the whole path. The original goes to the console.
 */
export function plainError(raw: string): string {
  const m = /^(E[A-Z]{2,})\b[:,]?[^,']*(?:,\s*\w+\s+'([^']*)')?/.exec(raw.trim())
  if (!m) return raw
  console.warn(raw)
  const name = m[2]?.split(/[\\/]/).pop()
  const what =
    m[1] === 'ENOENT'
      ? t('找不到这个文件或文件夹。')
      : m[1] === 'EACCES' || m[1] === 'EPERM'
        ? t('没有权限。')
        : m[1] === 'EBUSY'
          ? t('它正被别的程序占用。')
          : m[1] === 'ENOSPC'
            ? t('磁盘空间不够。')
            : m[1] === 'EEXIST'
              ? t('已经有同名的了。')
              : t('系统没能完成这个操作。')
  return name ? t('「{0}」：{1}', name, what) : what
}
