import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { codexEphemeral, codexThreadRequest } from '../src/main/backends/codexControl'

it.skipIf(process.env.FENN_REAL_CODEX_CONTROL !== '1')('native no-history helper and owned-conversation title sync work with the installed Codex', async () => {
  const cli = process.env.FENN_CODEX_CLI
  if (!cli) throw new Error('Set FENN_CODEX_CLI')
  const answer = await codexEphemeral(cli, 'Reply with exactly FENN_EPHEMERAL_OK and nothing else.', { cwd: tmpdir(), timeoutMs: 90_000 })
  expect(answer).toBe('FENN_EPHEMERAL_OK')
  // This profile is created by the separate opt-in review test; never pick arbitrary account threads.
  if (process.env.FENN_REVIEW_PROFILE) {
    const state = JSON.parse(readFileSync(`${process.env.FENN_REVIEW_PROFILE}/state.json`, 'utf8'))
    const project = state.projects.find((p: { name: string }) => p.name === '额度计算 · 并行审核试验')
    const conversation = state.conversations.find((c: { id: string }) => c.id === project?.conversationId)
    if (!conversation?.sessionRef || conversation.sessionRef.backendId !== 'codex') throw new Error('Owned review fixture has no Codex session')
    await codexThreadRequest(cli, 'thread/name/set', { threadId: conversation.sessionRef.sessionId, name: project.name })
  }
}, 120_000)
