# Fenn Code

**为您已经在用的 AI agent 准备的桌面工作台。** 对话、项目讨论串、交互式回复、定时任务和电脑操控，背后可以是 Codex、Claude Code、Grok、Qoder、Antigravity，或其他支持 [Agent Client Protocol](https://agentclientprotocol.com)（ACP）的 agent。

[English](README.md) · [下载](https://github.com/goldenfox2025/fenn-code/releases) · [从源码编译](#从源码编译)

![Fenn Code：项目主对话和它的讨论串，其中一个在问用哪个标题](docs/screenshots/zh/hero.webp)

## 为什么做 Fenn Code

命令行 agent 干活很强，但每件事都得开一个终端。Fenn Code 给它们一个桌面应用该有的结构：一个地方提需求，长任务各自放在讨论串里，做过的决定和交付的成果都有记录，需要反复做的事按时自动运行。用哪个 agent 由您决定，换一个 agent，项目也不会丢。

## 功能

### 项目和讨论串

每个项目有自己的主对话，由一个协调 agent 负责。小问题它直接回答，要花功夫的工作就开一个**讨论串**去做。每个讨论串都有实时更新的进度清单，会写明当前难点，需要您拍板时发一张选择卡片。概览页列出哪些在等您、哪些在进行、哪些已完成，旁边还有 agent 随时更新的里程碑进度表。

调研、分析和排查串共用项目上下文与目录；需要修改代码的串才使用自己的分支和 worktree。排查转为改代码时，可在同一串申请独立工作区后继续。新 worktree 基于项目已提交的 HEAD 创建，不会带入尚未提交的修改。工作者提交交付后，自动触发主对话核对实际改动、验证证据、交叉修改及合入影响。审核卡位于聊天记录下方、输入框上方；展开后查看分析、合入计划和更改文件，再决定**批准并合并**或**提出意见**。批准后安全合入已审核版本。意见会交给主对话讨论，不会自动重启工作者；您可以留在原串讨论，也可回主对话沟通方向。采纳排查结论不会合并实验代码。交付或集成分支变化后需要重新审核；未提交修改和合并冲突会阻止合入。工作区保留供后续使用，非 Git 项目也能验收，但不执行 Git 合并。

项目记忆、项目文件和进度都属于项目本身，不依赖某个 agent 会话。换一个新会话，甚至换一个后端，也能接着做。

<p>
  <img src="docs/screenshots/zh/project-overview.webp" width="49%" alt="项目概览：等您处理、进行中和已解决的讨论串">
  <img src="docs/screenshots/zh/thread.webp" width="49%" alt="一个讨论串的进度清单和当前难点">
</p>

### 操控电脑

在 设置 → 通用 里打开电脑操控后，模型能看图的 agent 可以在您的其他程序里干活：截屏、点击、输入、滚动、打开程序。它必须先申请要用的程序，您可以给每个程序选**完全控制**、**仅点击**或**仅查看**。点击前会核对指针下是不是被允许的程序；操控期间 Fenn Code 会最小化，屏幕上方的横条显示它在做什么，随时可以停止。

![权限卡片：agent 申请操控记事本，并说明了用途](docs/screenshots/zh/computer.webp)

### 任意 ACP agent，内置五个

内置 Codex、Claude Code、Grok、Qoder 和 Antigravity。首次设置时，按这个顺序推荐第一个已安装的 agent；您可以在 设置 → Agent 后端 里更换默认项。这里会显示安装状态，以及 agent 能提供的登录信息，只有您点了才检查更新。其他 ACP agent 在 `backends.json` 里加一项即可（见[接入新的后端](#接入新的后端)）。

Fenn Code 从不自行安装 agent。安装和升级按钮会先显示要运行的确切命令，等您确认后才执行。模型选择器会隐藏已检测到未安装或未登录的 agent。第一条消息之前就能选模型和后端支持的思考强度，选择会按后端记住；对话也可以换成另一个 agent，新的 agent 会拿到之前的对话内容（正在回复时，从下一条消息起生效）。

如果命令行程序不在 `PATH` 里（比如是 shell 别名，或装在别的应用里），可以在 设置 → Agent 后端 里填路径：Codex 可以填 CLI 和 `codex-acp` 适配器，Qoder 可以填 CLI 以及运行其 JS 入口用的 Node，Antigravity 可以填它的服务程序。用 Qoder 时，用量按钮显示的是账户 Credits，而不是 token。

![设置：Codex 和 Claude Code 已登录，Grok 已是最新](docs/screenshots/zh/backends.webp)

### 交互式回复和成果

可以直接让 agent 画交互图表、做方案对比或小型模拟器。控件显示在回复正文里，跟随对话主题，可以展开到侧栏；agent 也可以直接选择侧栏展示。预览支持版本记录，侧栏会保留最近三个预览，减少反复打开时的重新加载。

内置折线图和柱状图支持悬停查看数值、切换数据系列、键盘操作和数据表。图表库随应用打包，查看这些图表不需要从 CDN 下载。文档和报告默认使用 Markdown，您指定其他格式时以您的要求为准。

提供给 agent 的工具分别是：`render_ui` 绘制回复内控件，`render_chart` 绘制统计图表，`publish_page` 发布独立网页。它们通过 Fenn Code 的 MCP 服务提供。

agent 交付的文件或链接会显示成回复下方的卡片。文件在 Fenn Code 内打开查看，工作文件也可以从项目的「库」进入；添加的项目文件保留在项目面板的菜单里。不再单独设置「成果」页。

### 定时任务

让一段指令只运行一次，或每隔几分钟、每天、每周、按 cron 表达式运行，结果发到项目、某个对话或每次新建的对话里。工作需要反复做时，agent 也会自己建定时任务。

![定时任务：每日早报、每周价格检查和一个提醒](docs/screenshots/zh/routines.webp)

### 主题和语言

浅色、深色或跟随系统，界面支持简体中文和英文。语言默认跟随系统，也可以在 设置 → 外观 里切换。

此外还有：附件、编辑和重新生成（保留历史版本）、按工作文件夹分组的对话、agent 可以把旁支工作交给子对话、带文件和终端工具的工作文件夹、MCP 连接器、全文搜索、桌面通知。

用量按后端区分：Qoder 显示账户 Credits，其他后端显示能获取到的 token 和上下文数据。等效 API 费用会标明是按标价估算，不代表账户账单。回复计时包括首次响应、输出速度，以及数据充分时观测到的平均每 token 间隔（TPOT）。这些是客户端观测值，不是 GPU 耗时；缺失的 token 数不会凭空估算。

## 快速开始

本文介绍当前源码的功能。已发布版本可能落后于源码，请核对对应版本的发布说明，或[从源码编译](#从源码编译)。

1. Windows 用户从 [Releases](https://github.com/goldenfox2025/fenn-code/releases) 下载安装包 `Fenn-Code-Setup-<版本号>.exe`，或免安装的 `Fenn-Code-<版本号>-win.zip`；免安装版解压后运行 `FennCode.exe`。正式发布提供 Windows x64 版本。macOS 和 Linux 请[从源码编译](#从源码编译)。Windows 程序没有代码签名，SmartScreen 可能会提示，点「更多信息 → 仍要运行」即可。
2. 至少安装并登录一个 agent，在终端里做，或者在 设置 → Agent 后端 里点「安装」和「登录」：

   | Agent | 安装 | 登录 | 状态 |
   |---|---|---|---|
   | Codex | `npm install -g @openai/codex @agentclientprotocol/codex-acp` | `codex login` | 已在 Windows 11 上完整实测 |
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
| macOS | 支持为 Apple 芯片和 Intel 从源码编译，仍在持续测试；CI 结果不代表全部桌面功能都已验证。构建使用临时（ad-hoc）签名，未经 Apple 公证。电脑操控需要「辅助功能」和「录屏与系统录音」权限。 |
| Linux | 从源码编译。尚未在桌面真机上验证，欢迎反馈。电脑操控需要 X11 会话和 `xdotool`（不支持 Wayland）。 |

### 在 macOS 上打开未签名的程序

用于测试的 macOS zip 有时可从成功的 [build 工作流](https://github.com/goldenfox2025/fenn-code/actions/workflows/build.yml) 的 Artifacts 下载，包含 Apple 芯片和 Intel 版本。这些产物没有 Apple Developer ID 签名，也未经公证；推荐在自己的 Mac 上编译。

Gatekeeper 可能阻止下载的副本打开，或提示程序「已损坏」。确认构建来源可信后，可以先尝试打开，再到 **系统设置 → 隐私与安全性** 选择「仍要打开」。如果程序带有隔离标记，也可以在终端里移除：

```bash
xattr -dr com.apple.quarantine "/Applications/Fenn Code.app"
```

## 从源码编译

需要 [Node.js](https://nodejs.org) 22 或更新版本，以及 git：

```bash
git clone https://github.com/goldenfox2025/fenn-code.git
cd fenn-code
```

再运行对应系统的命令：

| 系统 | 命令 |
|---|---|
| Windows | `.\build.cmd -Run`（双击 `build.cmd` 只编译，不会启动程序） |
| macOS / Linux | `./build.sh --run` |

脚本会检查 Node.js、安装依赖、编译，最后打印程序位置：Windows 是 `release\win-unpacked\FennCode.exe`，macOS 是 `release/mac-arm64/Fenn Code.app`（Apple 芯片）或 `release/mac/Fenn Code.app`（Intel），Linux x64 是 `release/linux-unpacked/fenn-code`（其他架构会有各自的目录）。要同时生成安装包，加 `-Installer`（Windows）或 `--installer`（macOS / Linux），产物在 `release/` 里：Windows 是 NSIS 安装包和 zip，macOS 是 dmg 和 zip，Linux 是 AppImage 和 deb。需要代理时，先设好 `HTTPS_PROXY`，脚本会让 Node 自己的下载也走代理。

不用脚本的话：先 `npm install`，再 `npm run dist -- --publish never`，会把当前系统的版本打包到 `release/`。

## 已知限制

- macOS 和 Linux 的桌面兼容性仍在验证。macOS 产物没有 Developer ID 签名，也未经公证（见[上文](#在-macos-上打开未签名的程序)）。
- 侧栏只缓存最近三个预览。离开对话再返回时，正文中的交互 UI 可能重新加载，临时控件状态不保证保留。
- 电脑操控需要能看图的模型。在 macOS 上，请在 系统设置 → 隐私与安全性 → 辅助功能 和 → 录屏与系统录音 里允许 Fenn Code；在 Linux 上需要 X11 和 `xdotool`。
- Codex、Claude Code、Grok 和 Qoder 通过 npm 安装，电脑上需要有 Node.js。
- Antigravity 在 Windows 上的服务程序是一个很大的 PyInstaller 单文件程序，每次启动都会往临时文件夹解压约 330 MB。设置 → Agent 后端 里它旁边的「加快启动」会把它一次性解到 `~/.agy-acp-server`，以后启动就不用再解压。
- 登录状态只在 agent 能提供时显示。「已安装」「已登录」不代表完整推理请求一定能成功。
- Fenn Code 会告诉 Antigravity 对话的文件夹就是它的工作目录，所以它的文件会放在那里；但它运行命令时如果没有指定工作目录，命令仍可能在它自己的技能文件夹（`~/.gemini/antigravity-cli/skills`）里运行。
- agent 自己的审查和批准设置可能在工具执行前增加步骤，具体耗时和用量取决于后端配置。
- 自定义指令和项目指令在 agent 声明支持时放进系统提示词（Grok 和 Antigravity 支持；Claude Code 视其适配器是否声明），压缩上下文后仍然有效；其他 agent（如 Codex 和 Qoder）则在每个会话的第一条消息里带上，应用发现它压缩过上下文后会再带一次。

## 隐私

- Fenn Code 自己没有账号、远程服务或遥测。对话、项目和设置留在它的数据目录里。API Key 在系统支持时使用系统加密；系统加密不可用时，密钥值会以明文保存在本地配置中。
- 普通对话发给 agent 的是您写的内容，外加每个会话一次的应用简短说明和您的「自定义指令」（设置 → 通用）。对话标题根据您的第一条消息在本地生成，不会让 agent 来起名。
- 为了让长任务能持续进行，项目会自己给 agent 发一些消息：开讨论串时的任务说明、讨论串之间的留言、应用重启后请它接着做的提示，以及会话上下文快满时，先整理已有工作的摘要、再请它把要点存进项目记忆，然后换一个新会话接手。这种交接只发生在项目里的对话，一个会话超过约 60 轮或 16 万字时才会进行，要多花一次整理摘要的调用和一轮简短对话。定时任务运行的是您设置的指令。这些都和普通消息一样发给您的 agent。
- **agent 不用问就能做的事**：在对话的工作文件夹里读写（会解析链接，链接指向文件夹外的算作外面），以及读取网页。其他操作，比如读取或修改文件夹以外的文件、运行命令，都会在那个对话里请您确认，不会弹窗。设置 → 通用 →「允许读取工作文件夹以外的文件」（默认关闭）打开后，读取外面的文件也不用确认。定时任务从不等待：需要确认的步骤直接跳过，并在它的对话里写明；只有打开了「允许运行命令」（默认关闭）的定时任务可以运行命令。
- **Codex 桌面版**：默认显示 Fenn 的主对话和讨论串，并通过 Codex 的元数据接口同步 Fenn 标题。设置 → Agent 后端 → Codex →「在 Codex 桌面版中显示 Fenn 的 Codex 对话」可以关闭；关闭后在释放会话时归档，继续使用时再恢复。标题、归类等内部文本辅助请求使用原生 `codex exec --ephemeral`，不会进入活动列表或归档列表。Codex 自身的自动标题辅助线程也采用临时模式。只同步 Fenn 所属的对话，不修改账户中其他既有历史。
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

`settings` 会变成设置里的输入框，以环境变量的形式传给 agent；密钥字段的保存方式见[隐私](#隐私)。`login` 会加一个「登录」按钮，在终端里运行那条命令；`upgrade` 会加一个「升级」按钮，运行前先征求您同意。改完点「重新加载」，只有改动过的项会重启。

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

自动化测试使用演示 ACP 测试程序，正式安装包会排除它。调用真实后端的手动测试需要显式启用，见 [CONTRIBUTING.md](CONTRIBUTING.md)。界面文字都在 [`src/shared/i18n`](src/shared/i18n/README.md)，新增一种语言主要就是加一个文件。README 里的截图由 `scripts/readme-shots.mjs` 生成，使用演示数据，不运行真实 agent，也不含个人信息。

## 许可

[MIT](LICENSE)。
