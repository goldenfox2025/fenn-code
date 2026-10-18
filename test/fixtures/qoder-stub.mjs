#!/usr/bin/env node
// Stands in for qodercli 1.1.72 / 1.1.73 signed in, replaying the shapes its ACP agent sends
// (read from its bundle: session state, config options, plan from TodoWrite, a Bash call shown
// as a terminal with its output in _meta, the prompt result's usage and _meta.quota) and the
// Claude-format log it keeps in <config dir>/projects/<cwd slug>/<session id>.jsonl.
// No model runs. Signed out when QODER_STUB_SIGNED_OUT is set, or QODER_STUB_AUTH names a file
// that isn't there; like qodercli, the agent reads its sign-in once, when it starts.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const VERSION = process.env.QODER_STUB_VERSION || '1.1.72'
const signedOut = !!process.env.QODER_STUB_SIGNED_OUT || (!!process.env.QODER_STUB_AUTH && !existsSync(process.env.QODER_STUB_AUTH))

if (process.argv.includes('status')) {
  console.log(JSON.stringify(signedOut ? { logged_in: false, version: VERSION } : { logged_in: true, username: 'tester', version: VERSION }))
  process.exit(0)
}

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const notify = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } })
let nextId = 1000
const waiting = new Map()
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }) })

const MODES = [
  { id: 'default', name: 'Default', description: 'Prompts for approval' },
  { id: 'acceptEdits', name: 'Accept Edits', description: 'Auto-approves edit tools' },
  { id: 'auto', name: 'Auto', description: 'Auto-approves safe tools' },
  { id: 'dontAsk', name: "Don't Ask", description: 'Refuses instead of prompting' },
  { id: 'yolo', name: 'Bypass Permissions', description: 'Auto-approves all tools' }
]
const MODELS = [
  { modelId: 'auto', name: 'Auto (default)', description: '' },
  { modelId: 'performance', name: 'Performance', description: 'Reasoning · 1.5x' },
  { modelId: 'lite', name: 'Lite', description: 'Free' }
]
const EFFORTS = ['low', 'medium', 'high', 'none']
const effortName = { none: 'None', low: 'Low', medium: 'Medium', high: 'High' }
const sessions = new Map()

function configOptions(s) {
  return [
    { type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: s.mode,
      options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })) },
    { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: s.model,
      options: MODELS.map((m) => ({ value: m.modelId, name: m.name, description: m.description })) },
    { type: 'select', id: 'reasoning_effort', name: 'Reasoning Effort', category: 'thought_level', currentValue: s.effort,
      options: EFFORTS.map((e) => ({ value: e, name: effortName[e] })) }
  ]
}
const state = (s) => ({ sessionId: s.id, modes: { availableModes: MODES, currentModeId: s.mode },
  models: { availableModels: MODELS, currentModelId: s.model }, configOptions: configOptions(s) })

const configDir = process.env.QODER_CONFIG_DIR || join(homedir(), '.qoder')
const slug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
function log(s, entry) {
  const dir = join(configDir, 'projects', slug(s.cwd))
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, `${s.id}.jsonl`), JSON.stringify({ uuid: randomUUID(), sessionId: s.id, timestamp: new Date().toISOString(), isSidechain: false, ...entry }) + '\n')
}

async function prompt({ sessionId, prompt: blocks }) {
  const s = sessions.get(sessionId)
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  s.turns++
  const userMessageId = randomUUID()
  notify(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning the steps.' } })

  if (text.includes('计划')) {
    const todos = [{ description: '读代码', status: 'completed' }, { description: '改实现', status: 'in_progress' }, { description: '跑测试', status: 'pending' }]
    notify(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'toolu_todo' + s.turns, status: 'pending', title: 'TodoWrite', kind: 'think',
      rawInput: { todos }, _meta: { qoder: { toolName: 'TodoWrite' } } })
    notify(sessionId, { sessionUpdate: 'plan', entries: todos.map((t) => ({ content: t.description, priority: 'medium', status: t.status })) })
    notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_todo' + s.turns, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Todos have been modified successfully.' } }], rawOutput: 'Todos have been modified successfully.' })
  }

  if (text.includes('运行')) {
    const id = 'toolu_bash' + s.turns
    notify(sessionId, { sessionUpdate: 'tool_call', toolCallId: id, status: 'pending', title: 'echo hello-from-terminal', kind: 'execute',
      content: [{ type: 'terminal', terminalId: id }], rawInput: { command: 'echo hello-from-terminal' },
      _meta: { qoder: { toolName: 'Bash' }, terminal_info: { terminal_id: id } } })
    const answer = await ask('session/request_permission', { sessionId,
      toolCall: { toolCallId: id, title: 'echo hello-from-terminal', kind: 'execute', status: 'pending', rawInput: { command: 'echo hello-from-terminal' } },
      options: [{ optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' }, { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' }, { optionId: 'cancel', name: 'Reject', kind: 'reject_once' }] })
    if (answer?.outcome?.optionId === 'cancel' || answer?.outcome?.outcome === 'cancelled') {
      notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'The user rejected this command.' } }] })
    } else {
      notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: id, _meta: { terminal_output: { terminal_id: id, data: 'hello-from-terminal\n' } } })
      notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'terminal', terminalId: id }],
        rawOutput: [{ type: 'text', text: 'hello-from-terminal\n' }], _meta: { terminal_exit: { terminal_id: id, exit_code: 0, signal: null } } })
    }
  }

  // Qoder compacts inside its engine: over ACP nothing is said, only its log has the boundary.
  if (text.includes('#压缩')) {
    log(s, { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compact_metadata: { trigger: 'auto', pre_tokens: s.context, post_tokens: 3000 } })
    s.context = 3000
  } else s.context += 1500
  const rules = text.includes('<fenn-context') ? '有' : '无'
  const reply = text.includes('规则在哪') ? `本条消息：${rules}` : `好的，第 ${s.turns} 轮。`
  for (const piece of [reply.slice(0, 3), reply.slice(3)]) notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } })

  const input = 1200, cacheRead = s.context - 1200, output = 80
  log(s, { type: 'assistant', message: { model: s.model, role: 'assistant', content: [{ type: 'text', text: reply }],
    usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: output } } })
  return { stopReason: 'end_turn', userMessageId, usage: { inputTokens: input, outputTokens: output, totalTokens: input + output },
    _meta: { quota: { token_count: { input_tokens: input, output_tokens: output }, model_usage: [{ model: s.model, token_count: { input_tokens: input, output_tokens: output } }] } } }
}

async function handle(m) {
  const p = m.params ?? {}
  switch (m.method) {
    case 'initialize':
      return { protocolVersion: 1,
        authMethods: [{ id: 'qodercli-login', name: 'Use qodercli login', description: 'Use your existing qodercli login for this agent. If needed, sign in from qodercli first.' }],
        agentInfo: { name: 'qoder-cli', title: 'Qoder CLI', version: VERSION },
        agentCapabilities: { _meta: { qoder: { promptQueueing: true } }, loadSession: true,
          sessionCapabilities: { additionalDirectories: {}, close: {}, delete: {}, fork: {}, list: {}, resume: {} },
          promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true } } }
    case 'session/new': {
      if (signedOut) throw { code: -32000, message: 'Authentication required: Authentication is required.' }
      const s = { id: randomUUID(), cwd: p.cwd, mode: 'default', model: 'auto', effort: 'medium', turns: 0, context: 12000 }
      sessions.set(s.id, s)
      setTimeout(() => notify(s.id, { sessionUpdate: 'available_commands_update', availableCommands: [
        { name: 'rewind', description: 'Rewind the conversation to before a message', input: { hint: '<message-id>' } },
        { name: 'rename', description: 'Rename the current session', input: { hint: '<title>' } },
        { name: 'goal', description: 'Set a goal for the session' }] }), 20)
      return state(s)
    }
    case 'session/set_config_option': {
      const s = sessions.get(p.sessionId)
      if (p.configId === 'mode') { s.mode = p.value; notify(s.id, { sessionUpdate: 'current_mode_update', currentModeId: s.mode }) }
      else if (p.configId === 'model') s.model = p.value
      else if (p.configId === 'reasoning_effort') s.effort = p.value
      else throw { code: -32602, message: `Unknown config option: ${p.configId}` }
      notify(s.id, { sessionUpdate: 'config_option_update', configOptions: configOptions(s) })
      return { configOptions: configOptions(s) }
    }
    case 'session/set_mode': {
      const s = sessions.get(p.sessionId)
      s.mode = p.modeId
      notify(s.id, { sessionUpdate: 'current_mode_update', currentModeId: s.mode })
      return {}
    }
    case 'session/set_model': { sessions.get(p.sessionId).model = p.modelId; return {} }
    case 'session/prompt': return prompt(p)
    case 'session/cancel': return undefined
    default: throw { code: -32601, message: `Method not found: ${m.method}` }
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.method === undefined) { waiting.get(m.id)?.(m.result); waiting.delete(m.id); return }
  try {
    const result = await handle(m)
    if (m.id !== undefined) send({ id: m.id, result: result ?? null })
  } catch (e) {
    if (m.id !== undefined) send({ id: m.id, error: { code: e.code ?? -32603, message: e.message ?? String(e) } })
  }
})
