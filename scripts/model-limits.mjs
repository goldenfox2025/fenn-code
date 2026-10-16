// Refreshes src/shared/modelLimits.json from LiteLLM's model table:
//   curl -o litellm.json https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
//   node scripts/model-limits.mjs litellm.json
// Only context-window sizes are kept, for the providers the agents use.
import { readFileSync, writeFileSync } from 'node:fs'

const src = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const PROVIDERS = new Set(['anthropic', 'openai', 'xai', 'gemini', 'deepseek', 'dashscope', 'moonshot'])
const limits = {}
for (const [key, v] of Object.entries(src)) {
  if (!v || typeof v !== 'object' || !PROVIDERS.has(v.litellm_provider)) continue
  if (v.mode !== 'chat' && v.mode !== 'responses') continue
  const size = v.max_input_tokens
  if (typeof size !== 'number' || size <= 0) continue
  const name = key.split('/').pop().toLowerCase()
  // Skip dated snapshots; the plain name carries the same window.
  if (/-\d{8}$|-\d{4}-\d{2}-\d{2}$/.test(name) && limits[name.replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, '')]) continue
  limits[name] ??= size
}
const sorted = Object.fromEntries(Object.entries(limits).sort(([a], [b]) => a.localeCompare(b)))
const out = { source: 'LiteLLM model_prices_and_context_window.json (max_input_tokens)', fetched: new Date().toISOString().slice(0, 10), limits: sorted }
writeFileSync(new URL('../src/shared/modelLimits.json', import.meta.url), JSON.stringify(out, null, 1) + '\n')
console.log(Object.keys(sorted).length, 'models')
