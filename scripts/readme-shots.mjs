// Takes the README screenshots from a staged demo: a seeded data folder (a
// project with threads, progress, outputs, routines) and stand-in CLIs on PATH
// so the backends show as installed. No real agent runs, nothing personal shows.
// Usage: xvfb-run -a node scripts/readme-shots.mjs <en|zh> [outDir]
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { declareTestAgent } from './test-agent.mjs'

const lang = process.argv[2] === 'zh' ? 'zh' : 'en'
const out = resolve(process.argv[3] ?? `docs/screenshots/${lang}`)
mkdirSync(out, { recursive: true })
const L = (en, zh) => (lang === 'en' ? en : zh)

// ---- stand-in CLIs -----------------------------------------------------------
const bin = mkdtempSync(join(tmpdir(), 'ancora-bin-'))
const stub = (name, body) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
}
stub('claude', `case "$1 $2" in "auth status") echo '{"loggedIn":true,"authMethod":"claude.ai"}';; *) echo "2.1.301 (Claude Code)";; esac`)
stub('codex', `case "$1 $2" in "login status") echo "Logged in using ChatGPT" >&2;; *) echo "codex-cli 0.163.0";; esac`)
stub('qodercli', `echo '{"logged_in":true,"version":"1.1.72"}'`)
stub('grok', `echo "grok 1.0.60"`)
// The adapters only need to exist; nothing here sends a prompt.
for (const a of ['claude-agent-acp', 'codex-acp']) stub(a, 'exec sleep 600')

// ---- seeded data ------------------------------------------------------------
const data = mkdtempSync(join(tmpdir(), 'ancora-demo-'))
mkdirSync(join(data, 'messages'), { recursive: true })
const now = Date.now()
const min = 60_000
const hour = 60 * min
const id = () => randomUUID()
const conversations = []
const messages = {}
const demoModels = [{ id: 'default', name: L('Default', '默认') }]

function conv(c, msgs) {
  const full = {
    status: 'idle',
    backendId: 'codex',
    modelId: 'default',
    models: demoModels,
    createdAt: msgs[0]?.createdAt ?? now - 3 * hour,
    updatedAt: msgs.at(-1)?.createdAt ?? now - 3 * hour,
    messageCount: msgs.filter((m) => !m.hidden).length,
    ...c
  }
  const last = [...msgs].reverse().find((m) => !m.hidden && m.blocks.some((b) => b.type === 'text'))
  full.lastPreview = last?.blocks.find((b) => b.type === 'text')?.text.slice(0, 80)
  for (const m of msgs) m.conversationId = full.id
  conversations.push(full)
  messages[full.id] = msgs
  return full
}
const msg = (role, at, blocks, extra = {}) => ({ id: id(), role, createdAt: at, state: 'done', blocks, ...extra })
const text = (t) => ({ type: 'text', text: t })

const projectId = id()
const projectChat = id()
const [t1, t2, t3] = [id(), id(), id()]
const dir = 'D:\\Projects\\website-relaunch'

const pc = [
  msg('user', now - 3 * hour, [text(L('We relaunch the website on Nov 15. Compare the pricing pages of our three main competitors and tell me what they charge teams.', '官网 11 月 15 日改版上线。帮我对比三家主要竞品的定价页，看看他们对团队怎么收费。'))]),
  msg('assistant', now - 3 * hour + 4000, [text(L('On it.', '好的，开始了。')), { type: 'thread-card', threadId: t1 }]),
  msg('user', now - 2 * hour - 50 * min, [text(L('Then draft the copy for our new pricing page. Short and plain.', '然后起草新定价页的文案，简短直白一点。'))]),
  msg('assistant', now - 2 * hour - 50 * min + 4000, [text(L('Starting.', '马上开始。')), { type: 'thread-card', threadId: t2 }]),
  msg('user', now - 2 * hour - 40 * min, [text(L('Also check the signup flow for accessibility problems.', '另外检查一下注册流程的无障碍问题。'))]),
  msg('assistant', now - 2 * hour - 40 * min + 4000, [text(L("I'll run an audit.", '我来做一次检查。')), { type: 'thread-card', threadId: t3 }]),
  msg('user', now - 6 * min, [text(L('Where are we?', '现在进展如何？'))]),
  msg('assistant', now - 6 * min + 5000, [
    text(
      L(
        '- **Competitor pricing** is done. The comparison table is attached in the thread.\n- **Pricing page copy** has a draft and needs you to pick a headline.\n- **Signup accessibility** found 4 issues and fixed 2. It is waiting for staging access to verify them.',
        '- **竞品定价**已完成，对比表附在讨论串里。\n- **定价页文案**初稿好了，需要您选一个标题。\n- **注册无障碍**发现 4 个问题，修好了 2 个，在等预发环境的权限来验证。'
      )
    )
  ])
]
const anchor = (i) => pc[i].id
conv({ id: projectChat, kind: 'project', title: L('Website relaunch', '官网改版'), projectId }, pc)

const brief = (at, s) => msg('user', at, [text(s)], { hidden: true })
const fetchTool = (n, host) => ({ type: 'tool', toolId: `f${n}`, title: L(`Fetch ${host}/pricing`, `读取 ${host}/pricing`), toolKind: 'fetch', status: 'completed' })

conv(
  {
    id: t1,
    kind: 'thread',
    title: L('Competitor pricing', '竞品定价'),
    projectId,
    anchorMessageId: anchor(1),
    status: 'done',
    resolved: true,
    checklist: L(
      'Competitor pricing\n\n✓ Collected three pricing pages\n✓ Normalized plans to per-seat prices\n**✓ Wrote the comparison**',
      '竞品定价\n\n✓ 收集三家的定价页\n✓ 换算成每席位价格\n**✓ 写好对比表**'
    )
  },
  [
    brief(now - 3 * hour + 4000, L("User's words: compare the pricing pages of our three main competitors.", '用户原话：帮我对比三家主要竞品的定价页。')),
    msg('assistant', now - 2 * hour - 58 * min, [
      fetchTool(1, 'northwind.example'),
      fetchTool(2, 'contoso.example'),
      fetchTool(3, 'fabrikam.example'),
      text(
        L(
          'Done. For a team of 10, the three charge between $8 and $15 per seat per month, and all three keep SSO for their top plan.\n\n| | Team plan | Per seat | SSO |\n|---|---|---|---|\n| Northwind | $120 / mo | $12 | Enterprise only |\n| Contoso | $80 / mo | $8 | Enterprise only |\n| Fabrikam | $150 / mo | $15 | Enterprise only |',
          '做完了。按 10 人团队算，三家每席位每月 8 到 15 美元，而且都只在最高档提供 SSO。\n\n| | 团队版 | 每席位 | SSO |\n|---|---|---|---|\n| Northwind | $120 / 月 | $12 | 仅企业版 |\n| Contoso | $80 / 月 | $8 | 仅企业版 |\n| Fabrikam | $150 / 月 | $15 | 仅企业版 |'
        )
      ),
      { type: 'output', kind: 'file', title: 'pricing-comparison.md', path: `${dir}\\research\\pricing-comparison.md`, size: 4812 }
    ])
  ]
)

conv(
  {
    id: t2,
    kind: 'thread',
    title: L('Pricing page copy', '定价页文案'),
    projectId,
    anchorMessageId: anchor(3),
    status: 'waiting',
    unread: true,
    checklist: L(
      'Pricing page copy\n\n✓ Read the competitor comparison\n**✓ Drafted the page**\n✱ Waiting for your headline pick',
      '定价页文案\n\n✓ 读竞品对比\n**✓ 写好初稿**\n✱ 等您选标题'
    )
  },
  [
    brief(now - 2 * hour - 50 * min + 4000, L("User's words: draft the copy for our new pricing page. Short and plain.", '用户原话：起草新定价页的文案，简短直白一点。')),
    msg('assistant', now - 9 * min, [
      { type: 'thought', text: L('All three competitors gate SSO. That is our clearest difference.', '三家竞品都把 SSO 放在最贵的档位，这是我们最明显的不同。'), ms: 7000 },
      { type: 'tool', toolId: 'r1', title: L('Read pricing-comparison.md', '读取 pricing-comparison.md'), toolKind: 'read', status: 'completed' },
      { type: 'tool', toolId: 'w1', title: L('Write pricing-copy-draft.md', '写入 pricing-copy-draft.md'), toolKind: 'edit', status: 'completed' },
      text(
        L(
          'The draft is ready: three plans, a short FAQ, and a comparison row showing that SSO comes with every plan.',
          '初稿好了：三档套餐、一段简短的常见问题，还有一行对比，说明我们每一档都带 SSO。'
        )
      ),
      { type: 'output', kind: 'file', title: 'pricing-copy-draft.md', path: `${dir}\\copy\\pricing-copy-draft.md`, size: 2304 },
      {
        type: 'decision',
        question: L('Which headline should the pricing page lead with?', '定价页用哪个标题开头？'),
        options: [
          { label: L('SSO on every plan', '每档都有 SSO'), consequence: L('Leads with what none of the three competitors offer.', '突出三家竞品都没有的优势。') },
          { label: L('Simple pricing', '简单的定价'), consequence: L('Leads with clarity, matching the plain tone you asked for.', '突出清楚明了，符合您要的直白语气。') },
          { label: L('Free for 3 seats', '3 人以内免费'), consequence: L('Leads with the free tier, strongest for small teams.', '突出免费档，对小团队最有吸引力。') }
        ],
        recommended: 0
      }
    ])
  ]
)

conv(
  {
    id: t3,
    kind: 'thread',
    title: L('Signup accessibility', '注册无障碍'),
    projectId,
    anchorMessageId: anchor(5),
    status: 'waiting',
    checklist: L(
      'Signup accessibility\n\n✓ Audited the signup form\n**✓ Fixed labels and focus order**\n✱ Verify the fixes on staging\n○ Raise contrast of the error text',
      '注册无障碍\n\n✓ 检查注册表单\n**✓ 修好标签和焦点顺序**\n✱ 在预发环境验证修复\n○ 提高错误提示的对比度'
    ),
    blockers: [{ text: L('No access to staging yet, so the fixes are unverified.', '还没有预发环境的权限，修复没法验证。'), at: now - 20 * min }]
  },
  [
    brief(now - 2 * hour - 40 * min + 4000, L("User's words: check the signup flow for accessibility problems.", '用户原话：检查一下注册流程的无障碍问题。')),
    msg('assistant', now - 20 * min, [
      text(
        L(
          'Found 4 issues: two inputs without labels, a broken focus order after the email step, low-contrast error text, and a CAPTCHA with no audio option. The first two are fixed on the `a11y-signup` branch. I can’t reach staging to verify them yet.',
          '发现 4 个问题：两个输入框没有标签、填完邮箱后焦点顺序错乱、错误提示对比度太低、验证码没有语音选项。前两个已在 `a11y-signup` 分支修好，但我还进不了预发环境，没法验证。'
        )
      ),
      { type: 'output', kind: 'link', title: L('Pull request: signup accessibility fixes', '合并请求：注册无障碍修复'), url: 'https://git.example.com/site/pull/42' }
    ])
  ]
)

const day = (d) => `2026-${d}`
const project = {
  id: projectId,
  name: L('Website relaunch', '官网改版'),
  description: L('New site and pricing live by Nov 15', '11 月 15 日前上线新官网和新定价'),
  backendId: 'codex',
  conversationId: projectChat,
  createdAt: now - 5 * 24 * hour,
  updatedAt: now - 6 * min,
  pinned: true,
  progress: [
    {
      id: id(),
      title: L('Content ready', '内容就绪'),
      status: 'doing',
      due: day('11-01'),
      createdAt: now - 4 * 24 * hour,
      updatedAt: now - 9 * min,
      children: [
        { id: id(), title: L('Competitor research', '竞品调研'), status: 'done', links: [t1], createdAt: now - 3 * hour, updatedAt: now - 2 * hour },
        { id: id(), title: L('Pricing page copy', '定价页文案'), status: 'doing', links: [t2], createdAt: now - 3 * hour, updatedAt: now - 9 * min },
        { id: id(), title: L('Accessibility fixes', '无障碍修复'), status: 'blocked', note: L('Waiting for staging access', '等预发环境权限'), links: [t3], createdAt: now - 3 * hour, updatedAt: now - 20 * min }
      ]
    },
    {
      id: id(),
      title: L('Launch', '上线'),
      status: 'todo',
      due: day('11-15'),
      createdAt: now - 4 * 24 * hour,
      updatedAt: now - 4 * 24 * hour,
      children: [
        { id: id(), title: L('QA on staging', '预发环境验收'), status: 'todo', createdAt: now - 4 * 24 * hour, updatedAt: now - 4 * 24 * hour },
        { id: id(), title: L('Announcement post', '上线公告'), status: 'todo', createdAt: now - 4 * 24 * hour, updatedAt: now - 4 * 24 * hour }
      ]
    }
  ],
  outputs: [
    { id: id(), kind: 'file', title: 'pricing-comparison.md', path: `${dir}\\research\\pricing-comparison.md`, size: 4812, conversationId: t1, messageId: messages[t1][1].id, at: now - 2 * hour - 58 * min },
    { id: id(), kind: 'file', title: 'pricing-copy-draft.md', path: `${dir}\\copy\\pricing-copy-draft.md`, size: 2304, conversationId: t2, messageId: messages[t2][1].id, at: now - 9 * min },
    { id: id(), kind: 'link', title: L('Pull request: signup accessibility fixes', '合并请求：注册无障碍修复'), url: 'https://git.example.com/site/pull/42', conversationId: t3, messageId: messages[t3][1].id, at: now - 20 * min }
  ]
}

const others = [
  [L('Mobile app 2.0', '移动端 2.0'), L('Offline mode and a new onboarding', '离线模式和新的引导流程')],
  [L('Q4 planning', '第四季度规划'), L('Goals, budget and hiring for Q4', '第四季度的目标、预算和招聘')]
].map(([name, description], i) => {
  const pid = id()
  const cid = id()
  conv({ id: cid, kind: 'project', title: name, projectId: pid, backendId: i ? 'claude-code' : 'codex' }, [])
  return { id: pid, name, description, backendId: i ? 'claude-code' : 'codex', conversationId: cid, createdAt: now - (8 + i) * 24 * hour, updatedAt: now - (1 + i) * 24 * hour }
})

const chat = (title, backendId, ago, q, a) =>
  conv({ id: id(), kind: 'chat', title, backendId, modelId: undefined, models: undefined }, [msg('user', now - ago, [text(q)]), msg('assistant', now - ago + 8000, [text(a)])])
chat(L('Design review notes', '设计评审纪要'), 'codex', 50 * min, L('Summarize these design review notes into decisions and open questions.', '把这份设计评审纪要整理成结论和待定问题。'), L('**Decisions**\n- Keep the left navigation.\n- Ship dark mode with the relaunch.\n\n**Open questions**\n- Who owns the icon set?', '**结论**\n- 保留左侧导航。\n- 深色模式随改版一起上线。\n\n**待定**\n- 图标由谁负责？'))
chat(L('Why the CI cache misses', 'CI 缓存为什么失效'), 'claude-code', 3 * hour, L('Our CI cache misses on every run. Why?', '我们的 CI 每次都没命中缓存，为什么？'), L('The cache key includes the lockfile hash and the run number, so it changes on every run. Drop the run number from the key.', '缓存键里同时带了锁文件哈希和运行编号，所以每次都会变。把运行编号从键里去掉就行。'))
chat(L('A weekend in Kyoto', '京都周末行程'), 'grok', 26 * hour, L('Plan a relaxed weekend in Kyoto in November.', '帮我安排一个 11 月在京都的轻松周末。'), L('Saturday: Fushimi Inari early, then Gion in the afternoon. Sunday: Arashiyama and the bamboo grove, with lunch by the river.', '周六：一早去伏见稻荷，下午逛祇园。周日：岚山和竹林，在河边吃午饭。'))

const at = (d, h, m = 0) => {
  const x = new Date()
  x.setDate(x.getDate() + d)
  x.setHours(h, m, 0, 0)
  return x.getTime()
}
const nextDaily = (h) => (at(0, h) > now ? at(0, h) : at(1, h))
const nextWeekday = (wd, h) => {
  for (let d = 0; d < 8; d++) {
    const t = at(d, h)
    if (new Date(t).getDay() === wd && t > now) return t
  }
}
const routines = [
  { name: L('Morning brief', '每日早报'), prompt: L("Summarize yesterday's progress across threads and list what needs my decision today.", '整理昨天各讨论串的进展，列出今天需要我决定的事。'), schedule: { kind: 'daily', time: '09:00' }, target: { projectId }, nextRunAt: nextDaily(9), lastRunAt: nextDaily(9) - 24 * hour },
  { name: L('Competitor price watch', '竞品价格监控'), prompt: L('Check the three competitor pricing pages and tell me if anything changed.', '检查三家竞品的定价页，有变化就告诉我。'), schedule: { kind: 'daily', time: '10:00', weekdays: [1] }, target: { projectId }, nextRunAt: nextWeekday(1, 10) },
  { name: L('Dependency updates', '依赖更新'), prompt: L('List outdated dependencies in the site repo and which ones are safe to update.', '列出网站仓库里过时的依赖，以及哪些可以放心升级。'), schedule: { kind: 'daily', time: '16:00', weekdays: [5] }, target: {}, backendId: 'codex', nextRunAt: nextWeekday(5, 16) },
  { name: L('Launch email reminder', '提醒发上线邮件'), prompt: L('Remind me to send the launch email.', '提醒我发上线邮件。'), schedule: { kind: 'once', at: new Date('2026-11-15T09:00:00').getTime() }, target: { projectId }, nextRunAt: new Date('2026-11-15T09:00:00').getTime() }
].map((r) => ({ id: id(), enabled: true, createdAt: now - 3 * 24 * hour, ...r }))

writeFileSync(
  join(data, 'state.json'),
  JSON.stringify({
    version: 1,
    projects: [project, ...others],
    conversations,
    routines,
    connectors: [],
    settings: { defaultBackendId: 'codex', theme: 'glass', userName: '', notifications: false, language: lang, onboarded: true, computerUse: true },
    backendSettings: {}
  })
)
for (const [cid, list] of Object.entries(messages)) writeFileSync(join(data, 'messages', `${cid}.json`), JSON.stringify(list))

// ---- screenshots --------------------------------------------------------------
async function launch(extraEnv = {}) {
  if (extraEnv.ANCORA_DEMO_AGENT === '1') declareTestAgent(data, false)
  const app = await electron.launch({
    args: ['.', '--no-sandbox'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GROK_HOME: join(bin, 'grok-home'), ANCORA_DATA_DIR: data, ...extraEnv },
    colorScheme: 'light'
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate((l) => localStorage.setItem('oc-lang', l), lang)
  await page.reload()
  await page.waitForSelector('.sidebar')
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  return { app, page }
}
const wait = (page, ms) => page.waitForTimeout(ms)
const theme = async (page, th) => {
  await page.evaluate((x) => window.ancora.updateSettings(x === 'glass' ? { theme: 'dark', glass: true } : x === 'glass-light' ? { theme: 'light', glass: true } : { theme: x, glass: false }), th)
  await wait(page, 500)
}
const snap = (page, name, clip) => page.screenshot({ path: join(out, `${name}.png`), ...(clip ? { clip } : {}) })

{
  const { app, page } = await launch()
  const projectName = L('Website relaunch', '官网改版')
  await page.click(`.sidebar :text("${projectName}")`)
  await page.waitForSelector('.thread-card')
  await page.locator('.thread-card').nth(1).click()
  await page.waitForSelector('.decision', { timeout: 10000 })
  await page.locator('.thread-view .plan-summary').first().click()
  await wait(page, 800)
  await snap(page, 'hero')

  // Projects: the overview with threads and the progress board.
  await theme(page, 'light')
  await page.click('.chat-header .pill-btn')
  await wait(page, 800)
  await snap(page, 'project-overview')
  await page.click('.panel-head [data-more]')
  await page.click('.menu .menu-item:has-text("成果")')
  await wait(page, 600)
  await snap(page, 'outputs')

  // A thread with its checklist and blocker.
  await page.locator('.thread-card').nth(2).click()
  await page.locator('.thread-view .plan-summary').first().click()
  await wait(page, 800)
  await snap(page, 'thread')

  // Themes: the same view in each.
  await page.locator('.thread-card').nth(1).click()
  await wait(page, 600)
  for (const th of ['light', 'dark', 'glass']) {
    await theme(page, th)
    await snap(page, `theme-${th}`)
  }
  await theme(page, 'light')

  // Settings → Agent backends.
  await page.click('.sidebar-foot .icon-btn')
  await page.locator('.settings-nav .nav-item').nth(2).click()
  await wait(page, 2000)
  // Versions are only looked up on request.
  const checks = page.locator('.account-line .text-link', { hasText: L('Check for updates', '检查更新') })
  for (let i = 0; i < 8 && (await checks.count()); i++) { await checks.first().click(); await wait(page, 500) }
  await page.evaluate(() => document.querySelectorAll('.modal *').forEach((el) => { if (el.scrollTop) el.scrollTop = 0 }))
  await wait(page, 4000)
  await snap(page, 'backends')
  await page.click('.settings-close')

  // Scheduled tasks.
  await page.locator('.sidebar .nav .nav-item').nth(3).click()
  await wait(page, 800)
  await snap(page, 'routines')
  await app.close()
}

{
  // Computer use: the demo agent asks for an app; the grant card is the app's own.
  const { app, page } = await launch({ ANCORA_DEMO_AGENT: '1' })
  await theme(page, 'light')
  const ask = L('Use the computer: write today’s standup notes in Notepad.', '操控电脑，用记事本，写今天的站会笔记。')
  const c = await page.evaluate((t) => window.ancora.startChat({ text: t, backendId: 'mock' }), ask)
  void c
  await page.click(`.sidebar :text("${ask.slice(0, 10)}")`)
  await page.waitForSelector('.perm-app', { timeout: 20000 })
  await wait(page, 600)
  const box = await page.locator('.center >> visible=true').first().boundingBox()
  const composer = await page.locator('.composer-wrap >> visible=true').first().boundingBox()
  await snap(page, 'computer', { x: box.x, y: box.y, width: box.width, height: composer.y - box.y })
  await app.close()
}

// Theme strip: three shots side by side, scaled down.
execFileSync('convert', [join(out, 'theme-light.png'), join(out, 'theme-dark.png'), join(out, 'theme-glass.png'), '-resize', '50%', '+append', join(out, 'themes.png')])
for (const th of ['light', 'dark', 'glass']) rmSync(join(out, `theme-${th}.png`))
// WebP keeps the README light: about a fifth of the PNG size at the same look.
for (const f of readdirSync(out).filter((x) => x.endsWith('.png'))) {
  execFileSync('convert', [join(out, f), '-quality', '90', join(out, f.replace(/\.png$/, '.webp'))])
  rmSync(join(out, f))
}
console.log('screenshots in', out)
