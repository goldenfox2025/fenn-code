import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { BackgroundTask } from '@shared/backgroundTasks'
import { api } from '../../store'
import { t } from '../../i18n'

/** Poll only the open command. Reads are serialized and late responses are
 * discarded; reading earlier output explicitly pauses following. */
export function CommandOutput({ task }: { task: Extract<BackgroundTask, { kind: 'command' }> }) {
  const { command, ownerId } = task, running = task.state === 'running'
  const [output, setOutput] = useState<string | null>(command.output ?? null)
  const [error, setError] = useState(false), [retry, setRetry] = useState(0)
  const pre = useRef<HTMLPreElement>(null), follow = useRef(true)
  const [away, setAway] = useState(false)
  useEffect(() => {
    let gone = false, timer: ReturnType<typeof setTimeout> | undefined
    async function read() {
      try {
        const text = await api().commandOutput(ownerId, command.id)
        if (!gone) { setOutput(text); setError(false) }
      } catch { if (!gone) setError(true) }
      if (!gone && running) timer = setTimeout(read, 1000)
    }
    void read()
    return () => { gone = true; clearTimeout(timer) }
  }, [ownerId, command.id, running, retry])
  useLayoutEffect(() => {
    if (pre.current && follow.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [output])
  return <div className="background-command-content">
    <code className="background-command-code">{command.command}</code>
    <div className="background-output-head"><span>{t('输出')}</span>{away && <button className="background-follow" onClick={() => { follow.current = true; setAway(false); if (pre.current) pre.current.scrollTop = pre.current.scrollHeight }}><ArrowDown size={12}/>{t('最新输出')}</button>}</div>
    {error && <div className="background-output-error" role="status"><span>{t('读取输出失败')}</span><button className="text-link" onClick={() => setRetry(value => value + 1)}>{t('重试')}</button></div>}
    {output ? <pre className="background-output" ref={pre} tabIndex={0} aria-label={t('任务输出')} onScroll={event => {
      const el = event.currentTarget
      follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 8
      setAway(!follow.current)
    }}>{output}</pre> : !error && <p className="background-output-empty">{output === null ? t('正在读取输出…') : running ? t('还没有输出') : t('没有输出')}</p>}
  </div>
}
