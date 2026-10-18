# Fenn Code

**A desktop workspace for the AI agents you already use.** Chats, projects that split work into threads, scheduled tasks and computer control, on top of Codex, Claude Code, Grok, Antigravity, Qoder or any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP).

[简体中文](README.zh.md) · [Download](../../releases) · [Build from source](#build-from-source)

![Fenn Code: a project chat with its threads, and one thread asking which headline to use](docs/screenshots/en/hero.webp)

> **Unofficial.** Fenn Code is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. "Claude" is a trademark of Anthropic. Fenn Code does not include or call Claude by itself; it borrows the look and workflow of the Claude desktop app and runs whichever agent you connect.

## Why Fenn Code

Command-line agents are good at the work but leave you with a terminal per task. Fenn Code gives them the structure of a desktop app: one place to ask, threads that keep long work apart, a record of what was decided and what was produced, and tasks that run on a schedule. The agent stays your choice, and switching agents doesn't lose the project.

## Features

### Projects with threads

A project has its own chat, run by a coordinator agent. It answers small questions itself and starts a **thread** for anything that takes real work. Each thread keeps a live checklist, names its current obstacle, and asks for a decision with a card when it needs one. An overview shows what is waiting on you, what is in progress and what is done, next to a progress board of milestones the agents keep up to date.

Project memory, files and progress belong to the project, not to an agent session, so a new session (or another backend) picks up where the last one left off.

<p>
  <img src="docs/screenshots/en/project-overview.webp" width="49%" alt="Project overview: threads waiting on you, in progress and resolved">
  <img src="docs/screenshots/en/thread.webp" width="49%" alt="A thread with its checklist and current obstacle">
</p>

### Computer control

With computer control switched on (Settings → General), an agent whose model can read images works in your other apps: it takes screenshots, clicks, types, scrolls and opens programs. It has to ask for the apps it needs first, and you choose **full control**, **click only** or **view only** for each. Clicks are checked against the app under the pointer, Fenn Code minimizes while it works, and a bar at the top of the screen shows what it is doing and stops it.

![The permission card: the agent asks to control Notepad and explains why](docs/screenshots/en/computer.webp)

### Any ACP agent, five built in

Codex, Claude Code, Grok, Antigravity and Qoder are built in, and the first one installed, in that order, is suggested as the default. Settings → Agent backends shows whether each one is installed and, where the agent reports it, signed in. It checks for updates only when you ask. Any other ACP agent is one entry in `backends.json` (see [Adding a backend](#adding-a-backend)).

Fenn Code never installs an agent on its own. The install and upgrade buttons show the exact command and wait for you to confirm, and the model picker only lists agents that are ready to use. You can pick a model and thinking level before the first message, and a chat can switch to another agent, which receives the conversation so far (during a reply, the switch takes effect from the next message).

If a CLI isn't on `PATH` (a shell alias, or bundled inside another app), set its path under Settings → Agent backends: Codex takes the CLI and the `codex-acp` adapter, Qoder the CLI and, for its JS entry, Node, and Antigravity its server program. With Qoder, the usage button shows your account's credits instead of tokens.

![Settings: Codex and Claude Code signed in, Grok up to date](docs/screenshots/en/backends.webp)

### Outputs

When an agent hands over a file or a link, it shows up as a card under its reply and in the project's **Outputs** library, with the thread it came from. Files open in their default app.

![The Outputs library of a project](docs/screenshots/en/outputs.webp)

### Scheduled tasks

Run a prompt once, every few minutes, daily, weekly or on a cron schedule, and have the result posted to a project, a conversation or a fresh chat. Agents can set up their own scheduled tasks when work needs to repeat.

![Scheduled tasks: a morning brief, a weekly price check and a reminder](docs/screenshots/en/routines.webp)

### Themes and languages

Light, dark or follow the system, with an optional translucent glass look on top, in English or Simplified Chinese. The language follows your system until you pick one in Settings → Appearance.

![The same view in light, dark and glass](docs/screenshots/en/themes.webp)

Also included: attachments, editing and regenerating with version history, token and cost usage as the agent reports it (over ACP or in its own session log, never estimated), chats grouped by working folder, sub-conversations the agent can hand side work to, working folders with file and terminal tools, MCP connectors, full-text search, desktop notifications, and a new-chat page with usage figures, an activity heatmap, your most used models and cards that agents can put there and refresh on a schedule.

## Quick start

1. From [Releases](../../releases), download the Windows installer (`Fenn-Code-Setup-<version>.exe`) or the portable `Fenn-Code-<version>-win.zip` (unzip it anywhere and run `FennCode.exe`). Releases are Windows x64 only for now; on macOS and Linux, [build from source](#build-from-source). The build is not code-signed, so Windows SmartScreen may ask first: choose **More info → Run anyway**.
2. Install and sign in to at least one agent, in a terminal or with the **Install** and **Sign in** buttons in Settings → Agent backends:

   | Agent | Install | Sign in | Status |
   |---|---|---|---|
   | Codex (suggested) | `npm install -g @openai/codex @agentclientprotocol/codex-acp` | `codex login` | Tested end to end on Windows 11 |
   | Claude Code | `npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp` | `claude auth login` | Supported through `claude-agent-acp`; connection verified (start-up and model list), full chat not yet tested |
   | Grok | `npm install -g @xai-official/grok` | **Sign in** in Settings (grok.com account), or an xAI API key | Supported |
   | Antigravity | **Install** in Settings (downloads Google's `agy_acp_server` into `~/.agy-acp-server`) | **Sign in** in Settings (Google account), or a Gemini API key | Supported |
   | Qoder | `npm install -g @qoder-ai/qodercli` (runs as `qodercli --acp`) | `qodercli login`, or a personal access token | Supported |

   Codex and Claude Code connect through their ACP adapters, which is why each needs a second package. The npm-installed agents need [Node.js](https://nodejs.org). Behind a proxy, set `HTTPS_PROXY` (and `NODE_USE_ENV_PROXY=1`) in the same terminal first.
3. A short first-run guide asks what to call you and which agent to use. Every step can be skipped.

## Platforms

| Platform | Status |
|---|---|
| Windows 11 (x64) | Prebuilt release. Tested, including computer control. Windows 10 should work but has not been tested. |
| macOS | Build from source. Not yet verified on real machines; feedback welcome. There is no Apple signing identity, so builds are signed ad hoc and Gatekeeper blocks a copy you downloaded (see below). Computer control needs the Accessibility and Screen Recording permissions. |
| Linux | Build from source. Not yet verified on real desktop machines; feedback welcome. Computer control needs an X11 session and `xdotool` (Wayland isn't supported). |

### Opening an unsigned build on macOS

An app you built on the same Mac normally opens directly. A copy that was downloaded (for example a CI artifact, or one someone sent you) is quarantined, and macOS says it can't be opened or is damaged. On macOS 15 and later, right-click → **Open** no longer gets past this. Either remove the quarantine flag in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Fenn Code.app"
```

or try to open the app once, then go to **System Settings → Privacy & Security**, choose **Open Anyway** next to the message about Fenn Code, and confirm.

A zip packaged on Linux or Windows carries no signature at all. If an Apple Silicon Mac still says it is damaged after the step above, sign it ad hoc yourself: `codesign --force --deep -s - "/Applications/Fenn Code.app"`.

## Build from source

You need [Node.js](https://nodejs.org) 22 or newer and git. Clone this repository, then run one command in it:

| OS | Command |
|---|---|
| Windows | `.\build.cmd -Run` (double-clicking `build.cmd` builds without starting the app) |
| macOS / Linux | `./build.sh --run` |

The script checks Node.js, installs dependencies, builds the app and prints where it is: `release\win-unpacked\FennCode.exe` on Windows, `release/mac-arm64/Fenn Code.app` (Apple silicon) or `release/mac/Fenn Code.app` (Intel) on macOS, and `release/linux-unpacked/fenn-code` on Linux x64 (other architectures get their own folder). Add `-Installer` (Windows) or `--installer` (macOS / Linux) to also build installers into `release/`: an NSIS installer and a zip on Windows, a dmg and a zip on macOS, an AppImage and a deb on Linux. Behind a proxy, set `HTTPS_PROXY` first and the scripts pass it on to Node's own downloads.

Without the scripts: `npm install`, then `npm run dist -- --publish never` packages for the current OS into `release/`.

## Known limits

- macOS and Linux builds are not yet verified on real machines, and macOS builds are not notarized (see [above](#opening-an-unsigned-build-on-macos)).
- Computer control needs a model that can read images. On macOS, allow Fenn Code under System Settings → Privacy & Security → Accessibility and → Screen Recording. On Linux it needs X11 and `xdotool`.
- Codex, Claude Code, Grok and Qoder install through npm and need Node.js on the machine.
- Antigravity's Windows server is a large PyInstaller "onefile" program that unpacks some 330 MB to the temp folder on every start. **Start faster**, next to it in Settings → Agent backends, unpacks it once into `~/.agy-acp-server` so later starts skip that.
- Whether an agent is signed in is shown only where the agent reports it.
- Custom and project instructions go in as the system prompt where the agent says it takes one (Grok and Antigravity do; so does Claude Code where its adapter advertises it), so they survive its compaction. Other agents, such as Codex and Qoder, get them in the first message of each session instead, and again after a compaction the app notices.

## Privacy

- Fenn Code has no account, server or telemetry of its own. Your chats, projects and settings stay in its data folder; API keys you enter are encrypted with the OS keychain.
- Ordinary chats send the agent what you write, plus, once per session, short notes from the app and your **Custom instructions** (Settings → General). Chat titles are made locally from your first message; no agent is asked to name a chat.
- Projects keep long work going by writing to their agents themselves: the brief that starts a thread, notes between threads, a request to continue after the app restarts, and, when a session's context is nearly full, a summary of the work so far and a request to save memory before a fresh session takes over. That hand-over happens only in project conversations, after about 60 turns or 160,000 characters in one session, and costs one summary call plus one short turn. Scheduled tasks run the prompts you set. All of these go to your agent like any other message.
- It never installs or upgrades an agent without your confirmation, and checks for agent updates only when you ask.
- **Log agent traffic** (Settings → About → Diagnostics) is off by default; when on, it writes every ACP message, including chat content, to the `logs` folder on your machine.

## Adding a backend

Without code, add the agent to `backends.json` in the app's data folder (`%APPDATA%\Fenn Code` on Windows, `~/Library/Application Support/Fenn Code` on macOS, `~/.config/Fenn Code` on Linux), or open it from Settings → Agent backends → Advanced:

```json
[
  {
    "id": "my-agent",
    "name": "My Agent",
    "command": "my-agent",
    "args": ["--acp"],
    "settings": [{ "key": "MY_AGENT_API_KEY", "label": "API Key", "secret": true }],
    "login": { "command": "my-agent", "args": ["login"] },
    "upgrade": {
      "run": { "command": "npm", "args": ["install", "-g", "my-agent@latest"] },
      "latest": { "command": "npm", "args": ["view", "my-agent", "version"] }
    }
  }
]
```

`settings` become fields in Settings (secrets are encrypted with the OS keychain) and reach the agent as environment variables. `login` adds a **Sign in** button that runs the command in a terminal, and `upgrade` adds an **Upgrade** button that asks before running. Click **Reload** after editing; only the entries you changed restart.

With code, add a file to `src/main/backends/plugins/`, and it is picked up automatically:

```ts
import { acpPlugin } from '../acp'

export default acpPlugin({
  id: 'myagent',
  name: 'My Agent',
  settings: [{ key: 'API_KEY', label: 'API Key', secret: true }],
  launch: ({ config }) => ({ command: 'myagent', args: ['acp'], env: { API_KEY: config.API_KEY } })
})
```

A backend that doesn't speak ACP implements `AgentBackend` from `src/shared/contract.ts` and exports a `BackendPlugin`. The rest of the app only ever sees that contract.

## How it works

```
renderer (React)  ──IPC──▶  AppCore ─┬─ ChatService ── BackendManager ──▶ plugin ──▶ agent
                                     ├─ Orchestrator (projects, threads)
                                     ├─ AutoAssigner (local titles, folder)
                                     ├─ Scheduler (scheduled tasks)
                                     └─ ToolServer (MCP tools the agents call)
```

Project features (threads, checklists, memory, progress, outputs, computer control) reach agents as MCP tools served by the app, so they work with any backend that can pass tools to its agent. `src/main/backends/acp/` is the only code that knows about ACP. More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```bash
npm install
npm run dev               # run with hot reload
npm run typecheck
npm test                  # unit and integration tests, against a built-in demo agent
npm run test:e2e          # build, then UI checks with Playwright (Linux: xvfb-run -a npm run test:e2e)
npm run dist -- --publish never && npm run test:package   # package, then smoke-test the packaged app
```

Tests use a demo ACP agent and never call a real one. Translations live in [`src/shared/i18n`](src/shared/i18n/README.md); adding a language mostly means adding one file. The README screenshots come from `scripts/readme-shots.mjs`, which stages a demo with no real agent or personal data. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE). Fenn Code is not affiliated with Anthropic, OpenAI, xAI, Google or Qoder; product names belong to their owners.
