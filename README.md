# Fenn Code

**A desktop workspace for the AI agents you already use.** Chats, project threads, interactive replies, scheduled tasks and computer control, with Codex, Claude Code, Grok, Qoder, Antigravity or another agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP).

[简体中文](README.zh.md) · [Download](https://github.com/goldenfox2025/fenn-code/releases) · [Build from source](#build-from-source)

![Fenn Code: a project chat with its threads, and one thread asking which headline to use](docs/screenshots/en/hero.webp)

## Why Fenn Code

Command-line agents are good at the work but leave you with a terminal per task. Fenn Code gives them the structure of a desktop app: one place to ask, threads that keep long work apart, a record of what was decided and what was produced, and tasks that run on a schedule. The agent stays your choice, and switching agents doesn't lose the project.

## Features

### Projects with threads

A project has its own chat, run by a coordinator agent. It answers small questions itself and starts a **thread** for anything that takes real work. Each thread keeps a live checklist, names its current obstacle, and asks for a decision with a card when it needs one. An overview shows what is waiting on you, what is in progress and what is done, next to a progress board of milestones the agents keep up to date.

Research and investigation threads share the project's context and folder. Code-changing threads receive their own branch and worktree from the project's committed HEAD; an investigation can request a code workspace and continue in the same thread. Uncommitted project changes are excluded from new worktrees. A worker submits its delivery and automatically triggers coordinator review of the actual changes, evidence, overlaps and integration impact. A compact review card sits below the thread's history and above its composer. Open its details for analysis, the integration plan and changed files, then **Approve and merge** or **Comment**. Approval integrates the checked revision. Comments go to the coordinator for discussion and do not automatically restart the worker; you can discuss the direction in the current thread or the main chat. Investigation findings can be accepted without merging experimental code. Updated deliveries and a changed integration branch require fresh review. Dirty checkouts and detected merge conflicts block merging. Worktrees are retained for follow-up work, and non-Git projects support review without a Git merge.

Project memory, files and progress belong to the project, not to an agent session, so a new session (or another backend) picks up where the last one left off.

<p>
  <img src="docs/screenshots/en/project-overview.webp" width="49%" alt="Project overview: threads waiting on you, in progress and resolved">
  <img src="docs/screenshots/en/thread.webp" width="49%" alt="A thread with its checklist and current obstacle">
</p>

### Computer control

With computer control switched on (Settings → General), an agent whose model can read images works in your other apps: it takes screenshots, clicks, types, scrolls and opens programs. It has to ask for the apps it needs first, and you choose **full control**, **click only** or **view only** for each. Clicks are checked against the app under the pointer, Fenn Code minimizes while it works, and a bar at the top of the screen shows what it is doing and stops it.

![The permission card: the agent asks to control Notepad and explains why](docs/screenshots/en/computer.webp)

### Any ACP agent, five built in

Codex, Claude Code, Grok, Qoder and Antigravity are built in. On first setup, the first installed agent in that order is suggested as the default; you can choose another in Settings → Agent backends. This page shows installation and sign-in information where the agent reports it, and checks for updates when you ask. Any other ACP agent is one entry in `backends.json` (see [Adding a backend](#adding-a-backend)).

Fenn Code never installs an agent on its own. The install and upgrade buttons show the exact command and wait for you to confirm. The model picker hides agents detected as uninstalled or signed out. You can pick a model and supported thinking level before the first message; choices are remembered per backend. A chat can switch to another agent, which receives the conversation so far (during a reply, the switch takes effect from the next message).

If a CLI isn't on `PATH` (a shell alias, or bundled inside another app), set its path under Settings → Agent backends: Codex takes the CLI and the `codex-acp` adapter, Qoder the CLI and, for its JS entry, Node, and Antigravity its server program. With Qoder, the usage button shows your account's credits instead of tokens.

![Settings: Codex and Claude Code signed in, Grok up to date](docs/screenshots/en/backends.webp)

### Interactive replies and outputs

Ask an agent for an interactive chart, comparison or small simulator. Controls appear inside its reply, follow the conversation's theme, and can be expanded into the side pane. The agent can also choose the side pane directly. Previews keep version history, and the side pane retains up to three recent previews to avoid reloading them each time.

Built-in line and bar charts support tooltips, series toggles, keyboard navigation and a data table. Their chart library ships with the app, so viewing these charts needs no CDN download. Documents and reports default to Markdown unless you request another format.

For agents, the tools are `render_ui` for inline controls, `render_chart` for statistical charts, and `publish_page` for a standalone webpage. These tools are available through Fenn Code's MCP server.

Files and links handed over by an agent appear as cards under its reply. Files open inside Fenn Code for inspection; working files are also available in the project's **Library**. Added project documents remain accessible from the project panel's menu. There is no separate Outputs tab.

### Scheduled tasks

Run a prompt once, every few minutes, daily, weekly or on a cron schedule, and have the result posted to a project, a conversation or a fresh chat. Agents can set up their own scheduled tasks when work needs to repeat.

![Scheduled tasks: a morning brief, a weekly price check and a reminder](docs/screenshots/en/routines.webp)

### Themes and languages

Light, dark or follow the system, in English or Simplified Chinese. The language follows your system until you pick one in Settings → Appearance.

Also included: attachments, editing and regenerating with version history, chats grouped by working folder, sub-conversations the agent can hand side work to, working folders with file and terminal tools, MCP connectors, full-text search, desktop notifications.

Usage follows the backend: Qoder shows account credits; other backends show reported tokens and context figures where available. API-equivalent cost is labeled as a list-price estimate, not an account bill. Reply timing includes first response, output speed and observed time per output token (TPOT) when enough data is available. These are client observations, not GPU timings; missing token counts are not guessed.

## Quick start

This README describes the current source. Tagged releases can lag behind; check their release notes or [build from source](#build-from-source).

1. On Windows, download the installer (`Fenn-Code-Setup-<version>.exe`) or portable `Fenn-Code-<version>-win.zip` from [Releases](https://github.com/goldenfox2025/fenn-code/releases). For the portable version, unzip it and run `FennCode.exe`. Published releases carry Windows x64 builds. On macOS and Linux, [build from source](#build-from-source). Windows builds are not code-signed; SmartScreen may ask you to choose **More info → Run anyway**.
2. Install and sign in to at least one agent, in a terminal or with the **Install** and **Sign in** buttons in Settings → Agent backends:

   | Agent | Install | Sign in | Status |
   |---|---|---|---|
   | Codex | `npm install -g @openai/codex @agentclientprotocol/codex-acp` | `codex login` | Tested end to end on Windows 11 |
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
| macOS | Build from source for Apple Silicon or Intel. Support is under active testing; CI results do not establish full desktop compatibility. Builds use ad-hoc signing and are not notarized. Computer control needs Accessibility and Screen Recording permissions. |
| Linux | Build from source. Not yet verified on real desktop machines; feedback welcome. Computer control needs an X11 session and `xdotool` (Wayland isn't supported). |

### Opening an unsigned build on macOS

For testing, successful [build workflow runs](https://github.com/goldenfox2025/fenn-code/actions/workflows/build.yml) may provide macOS ZIP artifacts for Apple Silicon and Intel. These have no Apple Developer ID signature or notarization; building on your own Mac is the recommended route.

Gatekeeper may block a downloaded copy or report it as damaged. For a build you trust, first try opening it, then choose **Open Anyway** in **System Settings → Privacy & Security**. If it is quarantined, you can remove that flag in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Fenn Code.app"
```

## Build from source

You need [Node.js](https://nodejs.org) 22 or newer and git:

```bash
git clone https://github.com/goldenfox2025/fenn-code.git
cd fenn-code
```

Then run the command for your OS:

| OS | Command |
|---|---|
| Windows | `.\build.cmd -Run` (double-clicking `build.cmd` builds without starting the app) |
| macOS / Linux | `./build.sh --run` |

The script checks Node.js, installs dependencies, builds the app and prints where it is: `release\win-unpacked\FennCode.exe` on Windows, `release/mac-arm64/Fenn Code.app` (Apple silicon) or `release/mac/Fenn Code.app` (Intel) on macOS, and `release/linux-unpacked/fenn-code` on Linux x64 (other architectures get their own folder). Add `-Installer` (Windows) or `--installer` (macOS / Linux) to also build installers into `release/`: an NSIS installer and a zip on Windows, a dmg and a zip on macOS, an AppImage and a deb on Linux. Behind a proxy, set `HTTPS_PROXY` first and the scripts pass it on to Node's own downloads.

Without the scripts: `npm install`, then `npm run dist -- --publish never` packages for the current OS into `release/`.

## Known limits

- macOS and Linux desktop support is still being validated. macOS artifacts have no Developer ID signature or notarization (see [above](#opening-an-unsigned-build-on-macos)).
- Side-pane caching covers up to three recent previews. Inline UI can reload when you leave and return to a conversation; its temporary control state is not guaranteed to survive that navigation.
- Computer control needs a model that can read images. On macOS, allow Fenn Code under System Settings → Privacy & Security → Accessibility and → Screen Recording. On Linux it needs X11 and `xdotool`.
- Codex, Claude Code, Grok and Qoder install through npm and need Node.js on the machine.
- Antigravity's Windows server is a large PyInstaller "onefile" program that unpacks some 330 MB to the temp folder on every start. **Start faster**, next to it in Settings → Agent backends, unpacks it once into `~/.agy-acp-server` so later starts skip that.
- Sign-in state is shown where the agent reports it. Installation and sign-in indicators do not prove that a full inference request will succeed.
- Antigravity is told the chat's folder is its working directory, so its files land there; a command it runs without naming a working directory may still start in its own skills folder (`~/.gemini/antigravity-cli/skills`).
- An agent's own review and approval settings can add steps before a tool runs. Their latency and usage depend on the backend's configuration.
- Custom and project instructions go in as the system prompt where the agent says it takes one (Grok and Antigravity do; so does Claude Code where its adapter advertises it), so they survive its compaction. Other agents, such as Codex and Qoder, get them in the first message of each session instead, and again after a compaction the app notices.

## Privacy

- Fenn Code has no account, remote service or telemetry of its own. Your chats, projects and settings stay in its data folder. API keys use OS-backed encryption when available; when it is unavailable, secret values fall back to plaintext in the local configuration.
- Ordinary chats send the agent what you write, plus, once per session, short notes from the app and your **Custom instructions** (Settings → General). Chat titles are made locally from your first message; no agent is asked to name a chat.
- Projects keep long work going by writing to their agents themselves: the brief that starts a thread, notes between threads, a request to continue after the app restarts, and, when a session's context is nearly full, a summary of the work so far and a request to save memory before a fresh session takes over. That hand-over happens only in project conversations, after about 60 turns or 160,000 characters in one session, and costs one summary call plus one short turn. Scheduled tasks run the prompts you set. All of these go to your agent like any other message.
- **What agents may do without asking.** Reads and edits inside a chat's working folder (links resolved, so a link can't point an "inside" path elsewhere) and web fetches go ahead. Anything else, such as reading files outside the folder, editing outside it, or running a command, asks you inline in that chat, never in a popup. Settings → General → **Allow reading files outside the working folder** (off by default) lets outside reads through too. Scheduled tasks never wait: what would need asking is skipped and their chat says so, except commands in a task whose **Allow running commands** is on (off by default).
- **Codex Desktop.** Main conversations and project threads are shown by default, with their Fenn titles synchronized through Codex's metadata API. Settings → Agent backends → Codex → **Show Fenn's Codex chats in Codex Desktop** can turn this off; those conversations are then archived on release and restored when resumed. Internal text helpers use native `codex exec --ephemeral`, so they leave no conversation in either the active or archived list. Codex's own title helper also uses an ephemeral thread. Only Fenn's owned conversations are synchronized; existing unrelated account history is not modified.
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

`settings` become fields in Settings and reach the agent as environment variables. Secret fields use the storage described in [Privacy](#privacy). `login` adds a **Sign in** button that runs the command in a terminal, and `upgrade` adds an **Upgrade** button that asks before running. Click **Reload** after editing; only the entries you changed restart.

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

Automated tests use a demo ACP fixture, which is excluded from production packages. Manual tests against real backends require explicit opt-in; see [CONTRIBUTING.md](CONTRIBUTING.md). Translations live in [`src/shared/i18n`](src/shared/i18n/README.md); adding a language mostly means adding one file. The README screenshots come from `scripts/readme-shots.mjs`, which stages a demo with no real agent or personal data.

## License

[MIT](LICENSE).
