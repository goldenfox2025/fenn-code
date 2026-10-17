import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acpPlugin } from '../acp'
import { findOnPath } from '../install'
import { finishNpmInstall } from '../npmSetup'
import type { AgentEvent } from '../../../shared/contract'
import { t, tk } from '../../../shared/i18n'

const EXE = process.platform === 'win32' ? '.exe' : ''

/**
 * Where the Grok program is: the copy Grok's own installer keeps in
 * ~/.grok/bin, or a `grok` on PATH. Ancora never downloads it by itself; when
 * neither exists Grok shows as not installed, and Settings offers to install it.
 */
function grokHome(env = process.env): string {
  if (env.GROK_HOME) return env.GROK_HOME
  try {
    return join(realpathSync(homedir()), '.grok')
  } catch {
    return join(homedir(), '.grok')
  }
}

export function findGrok(env = process.env): string | undefined {
  const own = join(grokHome(env), 'bin', `grok${EXE}`)
  if (existsSync(own)) return own
  return findOnPath('grok', env)
}

/** Whether Grok keeps a grok.com sign-in (its auth.json holds at least one account). */
export function grokSignedIn(env = process.env): boolean {
  try {
    const auth = JSON.parse(readFileSync(join(grokHome(env), 'auth.json'), 'utf8')) as Record<string, unknown>
    return Object.keys(auth).length > 0
  } catch {
    return false
  }
}

const MISSING = tk('找不到 Grok 程序。请在 设置 → Agent 后端 → Grok 里点「安装」，或在终端运行 npm install -g @xai-official/grok，然后重试。')

/** xAI Grok Build CLI, which speaks ACP natively over stdio. */
export default acpPlugin({
  id: 'grok',
  sessionLog: 'grok',
  name: 'Grok',
  description: tk('xAI 官方 Grok Build 命令行'),
  signIn: true,
  settings: [
    {
      key: 'XAI_API_KEY',
      label: 'xAI API Key',
      secret: true,
      placeholder: 'xai-…',
      help: tk('在 console.x.ai 生成。留空则点上方「登录」，用 grok.com 账号登录。')
    },
    { key: 'model', label: tk('默认模型'), placeholder: 'grok-4.6' }
  ],
  quirks: {
    inputIncludesCache: true,
    // Its updates carry how full the context is (no ACP usage_update); /session-info shows the same figure.
    contextTokensMeta: 'totalTokens',
    // Its /context draws a panel in Grok's own terminal and sends nothing over ACP.
    commandAliases: { context: 'session-info' },
    // Grok appends `_meta.rules` on session/new to its system prompt (its ACP docs, "Session _meta options").
    systemPromptMeta: 'rules',
    // Grok has no ACP mode; it skips permission prompts through its own command (`input: on|off`).
    // The names are Claude Code's, so the menu shows them the same way (每次询问 / 全部允许).
    commandOption: {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      initial: 'default',
      choices: [
        { value: 'default', name: 'Default', command: '/always-approve off' },
        { value: 'bypassPermissions', name: 'Bypass permissions', command: '/always-approve on' }
      ]
    },
    authHint: tk('请在 设置 → Agent 后端 → Grok 填写 xAI API Key，或点「登录」用 grok.com 账号登录。'),
    missingHint: MISSING,
    // Grok reports retries, /goal progress, its subagents and auto-compaction through its own
    // `_x.ai/session_notification`; they show as a notice, the plan card, and steps.
    translateExt: grokExt
  },
  // `grok --version` tells whether it's installed; a key or the grok.com sign-in it keeps in
  // ~/.grok/auth.json says signed in. Without either it's left unknown: a session start finds out.
  account: (config) => ({
    command: findGrok() ?? 'grok',
    args: ['--version'],
    parse: (out) => {
      const version = /\d+\.\d+\.\d+/.exec(out)?.[0]
      return { installed: true, signedIn: config.XAI_API_KEY || process.env.XAI_API_KEY || grokSignedIn() ? true : undefined, version, detail: version ? `grok ${version}` : undefined }
    }
  }),
  upgrade: {
    run: { command: 'npm', args: ['install', '-g', '@xai-official/grok@latest'] },
    latest: { command: 'npm', args: ['view', '@xai-official/grok', 'version'] },
    after: finishNpmInstall('grok', '@xai-official/grok', 'bin/postinstall.js')
  },
  launch: (host) => ({
    command: findGrok() ?? 'grok',
    args: ['agent', ...(host.config.model ? ['--model', host.config.model] : []), 'stdio'],
    env: { XAI_API_KEY: host.config.XAI_API_KEY }
  })
})

type PlanStatus = 'pending' | 'in_progress' | 'completed'

/** One of Grok's background tasks (from task_backgrounded, task_completed or the background_tasks list). */
function backgroundTask(task: Record<string, unknown>, state: 'running' | 'exited'): AgentEvent {
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  const exit = task.exit_code
  return {
    kind: 'background',
    id: `grok-task:${text(task.task_id)}`,
    command: text(task.display_command) || text(task.command),
    state,
    exitCode: typeof exit === 'number' ? exit : state === 'exited' && task.status === 'completed' ? 0 : null,
    failed: (typeof exit !== 'number' && task.status === 'failed') || undefined,
    title: text(task.description) || undefined,
    managed: true,
    monitor: task.kind === 'monitor' || !!text(task.monitor_description) || undefined,
    outputFile: text(task.output_file) || undefined,
    output: state === 'exited' ? text(task.output).slice(-16_000) || undefined : undefined
  }
}
const compacting = new Map<string, string>()
let compactions = 0

/** Grok's vendor notifications as contract events (the wire name is `_x.ai/session_notification`). */
export function grokExt(method: string, params: Record<string, unknown>): { sessionId: string; events: AgentEvent[] } | null {
  if (!/^_?x\.ai\/session_(notification|update)$/.test(method)) return null
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
  const u = params.update as Record<string, unknown> | undefined
  if (!sessionId || !u) return null
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const num = (v: unknown) => (typeof v === 'number' ? v : 0)
  const events: AgentEvent[] = []
  switch (u.sessionUpdate) {
    case 'retry_state':
      events.push({
        kind: 'notice',
        level: 'warning',
        key: 'grok-retry',
        text: t('连接 Grok 失败，正在重试（{0}/{1}）：{2}', u.attempt, u.max_retries, str(u.reason).slice(0, 160))
      })
      break
    case 'goal_updated': {
      const status = str(u.status)
      const objective = str(u.objective).trim()
      if (!objective) break
      const done = /complete|achieved|done|success/.test(status)
      const goal: PlanStatus = done ? 'completed' : status === 'active' ? 'in_progress' : 'pending'
      const paused = /pause/.test(status)
      const entries: { content: string; status: PlanStatus }[] = [
        { content: paused ? t('目标（已暂停）：{0}', objective) : t('目标：{0}', objective), status: goal }
      ]
      if (u.planning === true) entries.push({ content: t('正在拟定计划'), status: 'in_progress' })
      const total = num(u.total_deliverables)
      if (total > 0) {
        const finished = num(u.completed_deliverables)
        entries.push({ content: t('交付物 {0}/{1}', finished, total), status: finished >= total ? 'completed' : goal === 'in_progress' ? 'in_progress' : 'pending' })
      }
      events.push({ kind: 'plan', entries })
      break
    }
    case 'subagent_spawned': {
      const id = str(u.subagent_id) || str(u.child_session_id)
      if (!id) break
      events.push({ kind: 'tool.start', toolId: `grok-subagent:${id}`, title: t('子任务：{0}', str(u.description) || str(u.subagent_type)), toolKind: 'other', status: 'running' })
      break
    }
    case 'subagent_finished': {
      const id = str(u.subagent_id) || str(u.child_session_id)
      if (!id) break
      const ok = /complete|success|done/.test(str(u.status))
      events.push({ kind: 'tool.update', toolId: `grok-subagent:${id}`, status: ok ? 'completed' : 'failed', output: str(u.output).slice(0, 4000) || undefined })
      break
    }
    // Its own background commands and monitors, shown in the background pane (Grok runs and stops them).
    case 'task_backgrounded':
      if (str(u.task_id)) events.push(backgroundTask(u, 'running'))
      break
    case 'task_completed': {
      const snap = u.task_snapshot as Record<string, unknown> | undefined
      if (snap && str(snap.task_id)) events.push(backgroundTask(snap, 'exited'))
      break
    }
    case 'background_tasks':
      for (const task of Array.isArray(u.tasks) ? (u.tasks as Record<string, unknown>[]) : [])
        if (str(task.task_id)) events.push(backgroundTask(task, task.status === 'running' ? 'running' : 'exited'))
      break
    case 'auto_compact_started': {
      const toolId = `grok-compact:${++compactions}`
      compacting.set(sessionId, toolId)
      events.push({ kind: 'tool.start', toolId, title: t('自动压缩上下文'), toolKind: 'other', status: 'running' })
      break
    }
    case 'auto_compact_completed':
    case 'auto_compact_failed': {
      const ok = u.sessionUpdate === 'auto_compact_completed'
      const toolId = compacting.get(sessionId)
      compacting.delete(sessionId)
      const before = num(u.tokens_before)
      const after = num(u.tokens_after)
      const output = ok && before && after ? t('{0} → {1} tokens', before.toLocaleString('en-US'), after.toLocaleString('en-US')) : undefined
      if (toolId) events.push({ kind: 'tool.update', toolId, status: ok ? 'completed' : 'failed', output })
      else events.push({ kind: 'tool.start', toolId: `grok-compact:${++compactions}`, title: t('自动压缩上下文'), toolKind: 'other', status: ok ? 'completed' : 'failed', input: output })
      if (ok) events.push({ kind: 'compacted' })
      if (ok && after) events.push({ kind: 'usage', contextUsed: after })
      break
    }
  }
  return events.length ? { sessionId, events } : null
}
