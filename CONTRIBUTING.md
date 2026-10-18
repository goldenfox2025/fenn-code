# Contributing to Fenn Code

Thanks for helping. Issues and pull requests are welcome in English or Chinese.

## Setting up

You need Node.js 22 or newer.

```bash
npm install
npm run dev          # the app with hot reload
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the main process, the renderer and the agent backends fit together,
and how to add an API method, a tool for agents or a new-chat page widget.

## Checks

```bash
npm run typecheck
npm test                                        # unit and integration tests
npm run test:e2e                                # UI checks with Playwright (Linux: xvfb-run -a npm run test:e2e)
npm run style-check                             # raw spacing and colors outside the tokens
npm run dist -- --publish never && npm run test:package   # package, then smoke-test the packaged app (Linux: xvfb-run -a)
```

* Tests use the built-in demo ACP agent (`resources/mock-agent.mjs`); no account or API key is needed, and nothing is
  sent to a real agent. The `*.manual.test.ts` files talk to real agents and run only when you ask for them (see their headers).
* The packaged-app check copies the app outside the checkout and uses isolated data. It sends no model requests and installs no agents.
* CI runs typecheck and tests on Windows, macOS and Linux, the UI checks on Linux, and packages for all three.

## Conventions

* **Strings.** The UI is written in Chinese with English translations. When you add or change a UI string, wrap it in
  `t()` (or mark it with `tk()` where it is translated later, when shown) and add its translation:
  `node scripts/i18n-add.mjs '{"中文":"English"}'`. `test/i18n.test.ts` fails on untranslated strings.
* **Styles.** Spacing, radii, colors and motion come from `src/renderer/src/tokens.css`; component styles live in
  `src/renderer/src/styles/NN-area.css`. `npm run style-check` and `test/style-tokens.test.ts` catch raw values.
* **Backends.** Keep backend-specific code inside `src/main/backends/`. The rest of the app talks to agents only through
  `src/shared/contract.ts`.
* **No surprises for users.** The app never installs an agent without confirmation, and it doesn't ask an agent to do
  its own bookkeeping (chat titles are made locally); keep it that way.
* Match the style of the surrounding code.

## Pull requests

* Keep each pull request focused on one change, and explain its user-visible effect.
* Add or update a test for behavior you change, and make sure the checks above pass.
* Update both `README.md` and `README.zh.md` when a user-facing feature changes.
* Don't commit personal data: no real names, emails, local paths, API keys or tokens in code, tests, fixtures or screenshots.

## Reporting a bug

Say what you did, what you expected and what happened, plus your OS, the app version (Settings → About) and which
agent backend you used. Error messages in the app have a Details section (详情) with the original error text; please include it.

Never paste API keys, access tokens or the contents of your data folder into an issue.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
