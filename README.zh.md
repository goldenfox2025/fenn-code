# Fenn Code

**为您已经在用的 AI agent 准备的桌面工作台。** 对话、能把工作拆成讨论串的项目、定时任务和电脑操控，背后可以是 Codex、Claude Code、Grok、Antigravity、Qoder，或任何支持 [Agent Client Protocol](https://agentclientprotocol.com)（ACP）的 agent。

[English](README.md) · [下载](../../releases) · [从源码编译](#从源码编译)

![Fenn Code：项目主对话和它的讨论串，其中一个在问用哪个标题](docs/screenshots/zh/hero.webp)

> **非官方项目。** Fenn Code 是独立的开源项目，与 Anthropic 没有任何关系，也没有得到 Anthropic 的认可或赞助。「Claude」是 Anthropic 的商标。Fenn Code 本身不包含也不调用 Claude，它参照了 Claude 桌面版的外观和用法，运行的是您接入的 agent。

## 为什么做 Fenn Code

命令行 agent 干活很强，但每件事都得开一个终端。Fenn Code 给它们一个桌面应用该有的结构：一个地方提需求，长任务各自放在讨论串里，做过的决定和交付的成果都有记录，需要反复做的事按时自动运行。用哪个 agent 由您决定，换一个 agent，项目也不会丢。

## 功能

### 项目和讨论串

每个项目有自己的主对话，由一个协调 agent 负责。小问题它直接回答，要花功夫的工作就开一个**讨论串**去做。每个讨论串都有实时更新的进度清单，会写明当前难点，需要您拍板时发一张选择卡片。概览页列出哪些在等您、哪些在进行、哪些已完成，旁边还有 agent 随时更新的里程碑进度表。

项目记忆、项目文件和进度都属于项目本身，不依赖某个 agent 会话。换一个新会话，甚至换一个后端，也能接着做。

<p>
  <img src="docs/screenshots/zh/project-overview.webp" width="49%" alt="项目概览：等您处理、进行中和已解决的讨论串">
  <img src="docs/screenshots/zh/thread.webp" width="49%" alt="一个讨论串的进度清单和当前难点">
</p>

### 操控电脑

在 设置 → 通用 里打开电脑操控后，模型能看图的 agent 可以在您的其他程序里干活：截屏、点击、输入、滚动、打开程序。它必须先申请要用的程序，您可以给每个程序选**完全控制**、**仅点击**或**仅查看**。点击前会核对指针下是不是被允许的程序；操控期间 Fenn Code 会最小化，屏幕上方的横条显示它在做什么，随时可以停止。

![权限卡片：agent 申请操控记事本，并说明了用途](docs/screenshots/zh/computer.webp)

### 任意 ACP agent，内置五个

内置 Codex、Claude Code、Grok、Antigravity 和 Qoder，按这个顺序，第一个已安装的会被推荐为默认。设置 → Agent 后端 里能看到每个 agent 是否已安装，以及在 agent 能报告时是否已登录。只有您点了才会检查更新。其他 ACP agent 在 `backends.json` 里加一项即可（见[接入新的后端](#接入新的后端)）。

Fenn Code 从不自行安装 agent。安装和升级按钮会先显示要运行的确切命令，等您确认后才执行；选择模型时也只列出已经可用的 agent。第一条消息之前就能选模型和思考强度；对话也可以换成另一个 agent，新的 agent 会拿到之前的对话内容（正在回复时，从下一条消息起生效）。

如果命令行程序不在 `PATH` 里（比如是 shell 别名，或装在别的应用里），可以在 设置 → Agent 后端 里填路径：Codex 可以填 CLI 和 `codex-acp` 适配器，Qoder 可以填 CLI 以及运行其 JS 入口用的 Node，Antigravity 可以填它的服务程序。用 Qoder 时，用量按钮显示的是账户 Credits，而不是 token。

![设置：Codex 和 Claude Code 已登录，Grok 已是最新](docs/screenshots/zh/backends.webp)

### 成果

agent 交付的文件或链接会显示成回复下方的卡片，同时汇总到项目的「成果」页，并注明来自哪个讨论串。文件用系统默认程序打开。

![项目的成果页](docs/screenshots/zh/outputs.webp)

### 定时任务

让一段指令只运行一次，或每隔几分钟、每天、每周、按 cron 表达式运行，结果发到项目、某个对话或每次新建的对话里。工作需要反复做时，agent 也会自己建定时任务。

![定时任务：每日早报、每周价格检查和一个提醒](docs/screenshots/zh/routines.webp)

### 主题和语言

浅色、深色或跟随系统，可以再叠加半透明的玻璃效果，界面支持简体中文和英文。语言默认跟随系统，也可以在 设置 → 外观 里切换。

![同一个界面的浅色、深色和玻璃效果](docs/screenshots/zh/themes.webp)

此外还有：附件、编辑和重新生成（保留历史版本）、按 agent 上报显示的 token 用量和费用（来自 ACP 或它自己的会话日志，从不估算）、按工作文件夹分组的对话、agent 可以把旁支工作交给子对话、带文件和终端工具的工作文件夹、MCP 连接器、全文搜索、桌面通知，以及新对话页上的用量数字、每日活跃热力图、最常用的模型，和 agent 可以放上去并按时刷新的卡片。

## 快速开始

1. 从 [Releases](../../releases) 下载 Windows 安装包 `Fenn-Code-Setup-<版本号>.exe`，或免安装的 `Fenn-Code-<版本号>-win.zip`（解压到任意位置，运行 `FennCode.exe`）。Releases 里是 Windows x64 版本。macOS 版：每次 CI 运行都会生成未签名的 zip（Apple 芯片和 Intel 各一个，`Fenn-Code-<版本号>-mac-arm64.zip` / `-mac-x64.zip`，在那次运行的 Artifacts 里），打开方法见[在 macOS 上打开未签名的程序](#在-macos-上打开未签名的程序)。Linux 请[从源码编译](#从源码编译)。程序没有代码签名，Windows SmartScreen 可能会拦一下，点「更多信息 → 仍要运行」即可。
2. 至少安装并登录一个 agent，在终端里做，或者在 设置 → Agent 后端 里点「安装」和「登录」：

   | Agent | 安装 | 登录 | 状态 |
   |---|---|---|---|
   | Codex（推荐） | `npm install -g @openai/codex @agentclientprotocol/codex-acp` | `codex login` | 已在 Windows 11 上完整实测 |
   | Claude Code | `npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp` | `claude auth login` | 通过 `claude-agent-acp` 接入；已验证连接（启动和模型列表），完整对话尚未实测 |
   | Grok | `npm install -g @xai-official/grok` | 在设置里点「登录」（grok.com 账号），或填 xAI API Key | 支持 |
   | Antigravity | 在设置里点「安装」（把 Google 的 `agy_acp_server` 下载到 `~/.agy-acp-server`） | 在设置里点「登录」（Google 账号），或填 Gemini API Key | 支持 |
   | Qoder | `npm install -g @qoder-ai/qodercli`（以 `qodercli --acp` 运行） | `qodercli login`，或填个人访问令牌 | 支持 |

   Codex 和 Claude Code 通过 ACP 适配器接入，所以各需要两个包。用 npm 安装的 agent 需要先装 [Node.js](https://nodejs.org)。在国内网络下，可以先在同一个终端里设好 `HTTPS_PROXY`，并设 `NODE_USE_ENV_PROXY=1`，让 npm 和 Node 走代理。
3. 第一次打开时会有简短的引导，问您怎么称呼、用哪个 agent。每一步都可以跳过。

## 支持的平台

| 平台 | 状态 |
|---|---|
| Windows 11（x64） | 提供预编译版本，已实测，包括电脑操控。Windows 10 理论上可用，尚未测试。 |
| macOS | 从源码编译。尚未在真机上验证，欢迎反馈。项目没有 Apple 开发者签名，编译出的程序只做了临时（ad-hoc）签名，从网上下载的副本会被 Gatekeeper 拦下（见下文）。电脑操控需要「辅助功能」和「录屏与系统录音」权限。 |
| Linux | 从源码编译。尚未在桌面真机上验证，欢迎反馈。电脑操控需要 X11 会话和 `xdotool`（不支持 Wayland）。 |

### 在 macOS 上打开未签名的程序

在同一台 Mac 上自己编译的程序通常可以直接打开。从别处下载来的副本（比如 CI 产物，或别人发给您的）会被系统隔离，提示无法打开或「已损坏」。从 macOS 15 起，右键 →「打开」已经不能绕过这一步。您可以在终端里去掉隔离标记：

```bash
xattr -dr com.apple.quarantine "/Applications/Fenn Code.app"
```

或者先尝试打开一次，再到 **系统设置 → 隐私与安全性**，在关于 Fenn Code 的提示旁点「仍要打开」，然后确认。

在 Linux 或 Windows 上打包的 zip 完全没有签名。如果做完上一步，Apple 芯片的 Mac 仍提示「已损坏」，请自己做一次临时签名：`codesign --force --deep -s - "/Applications/Fenn Code.app"`。

## 从源码编译

需要 [Node.js](https://nodejs.org) 22 或更新版本，以及 git。克隆本仓库后，在仓库目录里运行一条命令：

| 系统 | 命令 |
|---|---|
| Windows | `.\build.cmd -Run`（双击 `build.cmd` 只编译，不会启动程序） |
| macOS / Linux | `./build.sh --run` |

脚本会检查 Node.js、安装依赖、编译，最后打印程序位置：Windows 是 `release\win-unpacked\FennCode.exe`，macOS 是 `release/mac-arm64/Fenn Code.app`（Apple 芯片）或 `release/mac/Fenn Code.app`（Intel），Linux x64 是 `release/linux-unpacked/fenn-code`（其他架构会有各自的目录）。要同时生成安装包，加 `-Installer`（Windows）或 `--installer`（macOS / Linux），产物在 `release/` 里：Windows 是 NSIS 安装包和 zip，macOS 是 dmg 和 zip，Linux 是 AppImage 和 deb。需要代理时，先设好 `HTTPS_PROXY`，脚本会让 Node 自己的下载也走代理。

不用脚本的话：先 `npm install`，再 `npm run dist -- --publish never`，会把当前系统的版本打包到 `release/`。

## 已知限制

- macOS 和 Linux 版本尚未在真机上验证；macOS 版本没有经过公证（见[上文](#在-macos-上打开未签名的程序)）。
- 电脑操控需要能看图的模型。在 macOS 上，请在 系统设置 → 隐私与安全性 → 辅助功能 和 → 录屏与系统录音 里允许 Fenn Code；在 Linux 上需要 X11 和 `xdotool`。
- Codex、Claude Code、Grok 和 Qoder 通过 npm 安装，电脑上需要有 Node.js。
- Antigravity 在 Windows 上的服务程序是一个很大的 PyInstaller 单文件程序，每次启动都会往临时文件夹解压约 330 MB。设置 → Agent 后端 里它旁边的「加快启动」会把它一次性解到 `~/.agy-acp-server`，以后启动就不用再解压。
- 是否已登录，只有在 agent 能报告时才会显示。
- 自定义指令和项目指令在 agent 声明支持时放进系统提示词（Grok 和 Antigravity 支持；Claude Code 视其适配器是否声明），压缩上下文后仍然有效；其他 agent（如 Codex 和 Qoder）则在每个会话的第一条消息里带上，应用发现它压缩过上下文后会再带一次。

## 隐私

- Fenn Code 自己没有账号、服务器或遥测。您的对话、项目和设置都留在它的数据目录里；您填写的 API Key 用系统钥匙串加密保存。
- 普通对话发给 agent 的是您写的内容，外加每个会话一次的应用简短说明和您的「自定义指令」（设置 → 通用）。对话标题根据您的第一条消息在本地生成，不会让 agent 来起名。
- 为了让长任务能持续进行，项目会自己给 agent 发一些消息：开讨论串时的任务说明、讨论串之间的留言、应用重启后请它接着做的提示，以及会话上下文快满时，先整理已有工作的摘要、再请它把要点存进项目记忆，然后换一个新会话接手。这种交接只发生在项目里的对话，一个会话超过约 60 轮或 16 万字时才会进行，要多花一次整理摘要的调用和一轮简短对话。定时任务运行的是您设置的指令。这些都和普通消息一样发给您的 agent。
- **agent 不用问就能做的事**：在对话的工作文件夹里读写（会解析链接，链接指向文件夹外的算作外面），以及读取网页。其他操作，比如读取或修改文件夹以外的文件、运行命令，都会在那个对话里请您确认，不会弹窗。设置 → 通用 →「允许读取工作文件夹以外的文件」（默认关闭）打开后，读取外面的文件也不用确认。定时任务从不等待：需要确认的步骤直接跳过，并在它的对话里写明；只有打开了「允许运行命令」（默认关闭）的定时任务可以运行命令。
- 不经您确认，绝不安装或升级 agent；只有您点了才检查 agent 的更新。
- 「记录 agent 通信」（设置 → 关于 → 诊断）默认关闭；打开后会把与 agent 往来的每条 ACP 消息（包括对话内容）写进本机数据目录的 `logs` 文件夹。

## 接入新的后端

不写代码：在应用数据目录（Windows 是 `%APPDATA%\Fenn Code`，macOS 是 `~/Library/Application Support/Fenn Code`，Linux 是 `~/.config/Fenn Code`）的 `backends.json` 里加一项，也可以从 设置 → Agent 后端 → 高级 打开它：

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

`settings` 会变成设置里的输入框（密钥用系统钥匙串加密），以环境变量的形式传给 agent。`login` 会加一个「登录」按钮，在终端里运行那条命令；`upgrade` 会加一个「升级」按钮，运行前先征求您同意。改完点「重新加载」，只有改动过的项会重启。

写代码：在 `src/main/backends/plugins/` 里加一个文件，会被自动加载：

```ts
import { acpPlugin } from '../acp'

export default acpPlugin({
  id: 'myagent',
  name: 'My Agent',
  settings: [{ key: 'API_KEY', label: 'API Key', secret: true }],
  launch: ({ config }) => ({ command: 'myagent', args: ['acp'], env: { API_KEY: config.API_KEY } })
})
```

不支持 ACP 的后端，实现 `src/shared/contract.ts` 里的 `AgentBackend` 并导出一个 `BackendPlugin` 即可。应用的其余部分只认这个约定。

## 工作原理

```
renderer (React)  ──IPC──▶  AppCore ─┬─ ChatService ── BackendManager ──▶ plugin ──▶ agent
                                     ├─ Orchestrator（项目、讨论串）
                                     ├─ AutoAssigner（本地生成标题、文件夹）
                                     ├─ Scheduler（定时任务）
                                     └─ ToolServer（agent 调用的 MCP 工具）
```

讨论串、进度清单、项目记忆、进度表、成果和电脑操控，都以应用提供的 MCP 工具的形式交给 agent，所以只要后端能把工具传给 agent 就能用。`src/main/backends/acp/` 是唯一和 ACP 打交道的代码。更多细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发

```bash
npm install
npm run dev               # 带热重载运行
npm run typecheck
npm test                  # 单元和集成测试，用内置的演示 agent
npm run test:e2e          # 编译后用 Playwright 做界面检查（Linux：xvfb-run -a npm run test:e2e）
npm run dist -- --publish never && npm run test:package   # 打包，再对打包好的程序做冒烟测试
```

测试用的是演示 ACP agent，从不调用真实的 agent。界面文字都在 [`src/shared/i18n`](src/shared/i18n/README.md)，新增一种语言主要就是加一个文件。README 里的截图由 `scripts/readme-shots.mjs` 生成，用的是演示数据，不运行真实 agent，也不含个人信息。提交合并请求前请先看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)。Fenn Code 与 Anthropic、OpenAI、xAI、Google、Qoder 均无关联，相关产品名称归各自所有者。
