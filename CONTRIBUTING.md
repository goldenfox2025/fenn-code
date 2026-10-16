# Contributing to Ancora

Thanks for helping. Issues and pull requests are welcome in English or Chinese.

## Setting up

You need Node.js 22 or newer.

```bash
npm install
npm run dev
```

## Before sending a pull request

```bash
npm run typecheck
npm test
npm run build && xvfb-run -a node scripts/e2e.mjs   # UI checks (Linux; on macOS/Windows drop xvfb-run)
npm run dist -- --publish never
npm run test:package  # Linux: xvfb-run -a npm run test:package
```

* Tests use the built-in demo ACP agent (`resources/mock-agent.mjs`); no account or API key is needed.
* The packaged-app check copies the app outside the checkout and uses isolated data. It checks startup,
  model discovery, backend configuration reload, confirmation layouts and single-chat deletion.
  On macOS it also checks native fullscreen round trips. It sends no real model requests and installs no agents.
* The UI is written in Chinese with English translations. When you add or change a UI string, add its translation with
  `node scripts/i18n-add.mjs '{"中文":"English"}'`; `test/i18n.test.ts` fails on untranslated strings.
* Keep backend-specific code inside `src/main/backends/`. The rest of the app talks to agents only through
  `src/shared/contract.ts`.
* Match the style of the surrounding code. Keep changes focused, and explain the user-visible effect in the pull request.

## Reporting a bug

Say what you did, what you expected and what happened, plus your OS, the app version (Settings → About) and which
agent backend you used. Error messages in the app have a Details section (详情) with the original error text; please include it.

Never paste API keys, access tokens or the contents of your data folder into an issue.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
