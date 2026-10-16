#!/usr/bin/env node
// A dependency-free ACP agent over stdio (newline-delimited JSON-RPC 2.0).
// It streams a reply word by word, shows a tool call and a plan, and asks for
// permission when the prompt mentions "写" or "write". Used for demos and tests.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from 'node:fs';

// MOCK_STDIO_MCP=1 makes the mock accept only stdio MCP servers, like some real agents.
const STDIO_ONLY = process.env.MOCK_STDIO_MCP === "1";
const LEGACY_MODES = process.env.MOCK_LEGACY_MODES === "1";
// MOCK_AUTH=1 makes the mock require signing in first, like Grok without an API key.
let signedIn = process.env.MOCK_AUTH !== "1";
// MOCK_FORGETFUL=1 makes the mock never save memory before a handoff, like a model that doesn't cooperate.
const FORGETFUL = process.env.MOCK_FORGETFUL === "1";

const sessions = new Map();
let nextReq = 1000;
const pendingClientReqs = new Map();

const send = (msg) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const notify = (sessionId, update) =>
  send({ method: "session/update", params: { sessionId, update } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const requestClient = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextReq++;
    pendingClientReqs.set(id, { resolve, reject });
    send({ id, method, params });
  });

const models = [
  { value: "mock-fast", name: "Mock Fast", description: "快速回复" },
  { value: "mock-smart", name: "Mock Smart", description: "带思考过程" },
];

const handlers = {
  initialize: async () => {
    while (process.env.MOCK_CATALOG_GATE && !existsSync(process.env.MOCK_CATALOG_GATE)) await sleep(20);
    if (process.env.MOCK_CATALOG_FAIL_ONCE && !existsSync(process.env.MOCK_CATALOG_FAIL_ONCE)) {
      writeFileSync(process.env.MOCK_CATALOG_FAIL_ONCE, 'failed');
      throw new Error('Catalog temporarily unavailable');
    }
    // MOCK_SLOW_START=<ms> simulates a slow first launch (e.g. npx downloading the agent).
    await sleep(Number(process.env.MOCK_SLOW_START) || 0);
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { embeddedContext: true, image: process.env.MOCK_IMAGES !== '0' },
        sessionCapabilities: { resume: {} },
        mcpCapabilities: { http: !STDIO_ONLY },
      },
      agentInfo: { name: "ancora-mock", version: "0.1.0" },
      authMethods: signedIn
        ? []
        : [
            {
              id: "mock-login",
              name: "演示登录",
              description: "模拟浏览器登录",
            },
          ],
    };
  },
  authenticate: async ({ methodId }) => {
    if (methodId !== "mock-login")
      throw Object.assign(new Error("unknown auth method"), { code: -32602 });
    await sleep(200);
    signedIn = true;
    return {};
  },
  "session/new": ({ cwd, mcpServers }) => {
    if (process.env.MOCK_SESSION_FILE_ERROR === '1')
      throw Object.assign(new Error('Failed to read authentication state'), {
        code: -32603,
        data: { error: "EPERM: operation not permitted, open '/Users/test/.qoder/.auth/machine_id'" }
      });
    if (!signedIn)
      throw Object.assign(new Error("Authentication required"), {
        code: -32000,
      });
    const sessionId = "mock-" + Math.random().toString(36).slice(2, 10);
    const usable = (mcpServers ?? []).filter((m) =>
      STDIO_ONLY ? m.command : true,
    );
    const mcp = usable.find((m) => m.name === "ancora");
    // Other servers are the user's connectors; each gets its own client state.
    const connectors = usable
      .filter((m) => m !== mcp)
      .map((m) => ({ mcp: m, mcpReady: null, tools: null }));
    sessions.set(sessionId, {
      cwd,
      model: "mock-fast",
      turns: 0,
      abort: null,
      mcp,
      mcpReady: null,
      tools: null,
      connectors,
    });
    // MOCK_LEGACY_MODES=1: offer the mode as ACP session modes instead of a config option.
    if (LEGACY_MODES)
      return {
        sessionId,
        configOptions: configOptions("mock-fast", sessions.get(sessionId)).filter((o) => o.id === "model"),
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
      };
    return { sessionId, configOptions: configOptions("mock-fast", sessions.get(sessionId)) };
  },
  "session/resume": ({ sessionId }) => {
    // Sessions live only as long as this process; after a restart there is nothing to resume.
    if (!sessions.has(sessionId))
      throw { code: -32602, message: "unknown session id" };
    const s = sessions.get(sessionId);
    return { configOptions: configOptions(s.model, s) };
  },
  "session/set_mode": ({ sessionId, modeId }) => {
    sessions.get(sessionId).mode = modeId;
    return {};
  },
  "session/set_config_option": ({ sessionId, configId, value }) => {
    const s = sessions.get(sessionId);
    if (configId === "model") s.model = value;
    else if (configId === "mode") s.mode = value;
    else if (configId === "effort") s.effort = value;
    else throw { code: -32602, message: `Unknown config option: ${configId}` };
    return { configOptions: configOptions(s.model, s) };
  },
  "session/prompt": async ({ sessionId, prompt }) => {
    const s = sessions.get(sessionId);
    if (!s) throw { code: -32602, message: "unknown session" };
    const abort = { aborted: false };
    s.abort = abort;
    s.turns++;
    const raw = prompt
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    // "#难点 …" reports an obstacle through the app's tool ("#难点" alone clears it).
    if (raw.includes("#难点") && s.mcp) {
      const m = raw.match(/#难点\s*([^\n<]*)/);
      await callTool(sessionId, s, "set_blocker", { text: (m?.[1] ?? "").trim() });
    }
    // "#进度 里程碑 / 任务" records work on the project board through the app's tool.
    if (raw.includes("#进度") && s.mcp) {
      const m = [...raw.matchAll(/#进度\s*([^\n<]*)/g)].pop();
      const [milestone, task] = (m?.[1] ?? "").split("/").map((x) => x.trim());
      if (milestone) await callTool(sessionId, s, "progress_update", { title: milestone, status: "doing" });
      if (milestone && task) await callTool(sessionId, s, "progress_update", { milestone, title: task, status: "done" });
    }
    // Failure modes the app should explain in plain words.
    if (raw.includes("#fail-auth"))
      throw { code: -32000, message: "Authentication required: run mock-cli login" };
    // Fails the first time only, like a sign-in being renewed by another process.
    if (raw.includes("#fail-refresh-once") && !s.refreshFailed) {
      s.refreshFailed = true;
      throw { code: -32603, message: "Internal error: Failed to refresh OAuth token: another mock process is refreshing it" };
    }
    if (raw.includes("#fail-net"))
      throw { code: -32603, message: "fetch failed: getaddrinfo ENOTFOUND api.example.com" };
    const text = userText(raw);
    // Test hook: simulate the agent process crashing mid-turn.
    if (text === "/crash") {
      process.stderr.write("mock agent: simulated crash\n");
      process.exit(3);
    }
    try {
      // "你看到了什么" echoes the whole prompt, so tests can check what a session was given.
      if (process.env.MOCK_SIMPLE_STREAM === '1')
        await stream(sessionId, "A plain streamed reply for timing checks.", abort);
      else if (text === "你看到了什么")
        notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: raw } });
      else if (raw.includes("<<classify>>")) await classify(sessionId, raw, abort);
      else if (raw.includes("<<summarize>>")) await summarize(sessionId, raw, abort);
      // MOCK_LAZY=1: a model that never calls the app's tools and answers everything inline.
      else if (process.env.MOCK_LAZY === "1")
        await stream(sessionId, `好的，我直接在这里回答「${text.slice(0, 40)}」。` + "这是一个比较完整的回答，涵盖了背景、做法和下一步。".repeat(20), abort);
      else if (s.mcp && (await toolNames(s)).includes("start_thread"))
        await coordinatorTurn(sessionId, s, text, abort, raw);
      else if (s.mcp && !/^(交付文件|附上)/.test(text) && (await toolNames(s)).includes("set_resolved"))
        await threadTurn(sessionId, s, text, abort);
      else await turn(sessionId, s, text, abort, raw.includes("<history>"));
    } catch (e) {
      if (abort.aborted) return { stopReason: "cancelled" };
      throw e;
    }
    // Usage, the way real agents report it. MOCK_USAGE=none reports nothing; =quota reports it
    // only in a vendor field (as Qoder does); otherwise ACP usage plus a cumulative cost update.
    const input = Math.ceil(raw.length / 2);
    const output = 40 + s.turns;
    const mode = process.env.MOCK_USAGE;
    if (mode === "quota")
      return {
        stopReason: abort.aborted ? "cancelled" : "end_turn",
        _meta: { quota: { token_count: { input_tokens: input, output_tokens: output } } },
      };
    if (mode === "none") return { stopReason: abort.aborted ? "cancelled" : "end_turn" };
    s.cost = (s.cost ?? 0) + (input + output) * 0.00001;
    s.context = (s.context ?? 0) + input + output;
    notify(sessionId, { sessionUpdate: "usage_update", used: s.context, size: 200000,
      ...(mode === 'no-cost' ? {} : { cost: { amount: s.cost, currency: "USD" } }) });
    return {
      stopReason: abort.aborted ? "cancelled" : "end_turn",
      usage: { inputTokens: input, outputTokens: output, totalTokens: input + output, cachedReadTokens: 0 },
    };
  },
  "session/cancel": ({ sessionId }) => {
    const s = sessions.get(sessionId);
    if (s?.abort) s.abort.aborted = true;
  },
};

function configOptions(current, s = {}) {
  // Regression fixture: one model has no configurable reasoning, another does.
  const fixedEffort = process.env.MOCK_DYNAMIC_EFFORT === '1' && current === 'mock-fast';
  return [
    {
      id: "model",
      name: "模型",
      category: "model",
      type: "select",
      currentValue: current,
      options: models,
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: s.mode ?? "default",
      options: [
        { value: "default", name: "Default", description: "Prompts for approval" },
        { value: "acceptEdits", name: "Accept Edits", description: "Auto-approves edit tools" },
        { value: "bypassPermissions", name: "Bypass Permissions", description: "Auto-approves all tools" },
      ],
    },
    {
      id: "effort",
      name: "Reasoning Effort",
      category: "thought_level",
      type: "select",
      currentValue: fixedEffort ? 'none' : s.effort ?? "medium",
      options: fixedEffort ? [{ value: 'none', name: 'none' }] : [
        ...(process.env.MOCK_DYNAMIC_EFFORT === '1' ? [{ value: 'none', name: 'none' }] : []),
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ];
}

async function stream(sessionId, text, abort, kind = "agent_message_chunk") {
  for (const piece of text.match(/[\s\S]{1,3}/g) ?? []) {
    if (abort.aborted) throw new Error("cancelled");
    notify(sessionId, {
      sessionUpdate: kind,
      content: { type: "text", text: piece },
    });
    await sleep(12);
  }
}

// ---- tools via MCP (streamable HTTP, JSON responses; or stdio) -----------
function stdioPost(s, body) {
  if (!s.proc) {
    const env = { ...process.env };
    for (const e of s.mcp.env ?? []) env[e.name] = e.value;
    s.proc = spawn(s.mcp.command, s.mcp.args ?? [], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    s.waiting = new Map();
    createInterface({ input: s.proc.stdout }).on("line", (l) => {
      const m = JSON.parse(l);
      s.waiting.get(m.id)?.(m);
      s.waiting.delete(m.id);
    });
  }
  s.proc.stdin.write(JSON.stringify(body) + "\n");
  if (body.id === undefined) return Promise.resolve(null);
  return new Promise((resolve) => s.waiting.set(body.id, resolve));
}

let rpcSeq = 1;
async function mcpPost(s, body) {
  if (s.mcp.command) return stdioPost(s, body);
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  for (const h of s.mcp.headers ?? []) headers[h.name] = h.value;
  if (s.mcpSession) headers["mcp-session-id"] = s.mcpSession;
  const res = await fetch(s.mcp.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) s.mcpSession = sid;
  if (
    res.status === 202 ||
    !(res.headers.get("content-type") ?? "").includes("json")
  )
    return null;
  return res.json();
}
async function mcpInit(s) {
  s.mcpReady ??= (async () => {
    await mcpPost(s, {
      jsonrpc: "2.0",
      id: rpcSeq++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mock", version: "0" },
      },
    });
    await mcpPost(s, { jsonrpc: "2.0", method: "notifications/initialized" });
  })();
  return s.mcpReady;
}
async function toolNames(s) {
  if (!s.tools) {
    await mcpInit(s);
    const r = await mcpPost(s, {
      jsonrpc: "2.0",
      id: rpcSeq++,
      method: "tools/list",
    });
    s.tools = (r?.result?.tools ?? []).map((t) => t.name);
  }
  return s.tools;
}
async function callTool(sessionId, s, name, args) {
  const id = `mcp-${rpcSeq}`;
  notify(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: id,
    title: `ancora/${name}`,
    kind: "other",
    status: "in_progress",
    rawInput: args,
  });
  await mcpInit(s);
  const r = await mcpPost(s, {
    jsonrpc: "2.0",
    id: rpcSeq++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const out = r?.result?.content?.[0]?.text ?? JSON.stringify(r?.error ?? null);
  notify(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    status: r?.result?.isError || r?.error ? "failed" : "completed",
    content: [{ type: "content", content: { type: "text", text: out } }],
  });
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

/** Strips the app's context blocks so the mock reacts to what the user typed. */
function userText(raw) {
  let t = raw
    .replace(/<ancora-context[\s\S]*?<\/ancora-context>/g, "")
    .replace(/<thread-updates>[\s\S]*?<\/thread-updates>/g, "")
    .replace(/<threads>[\s\S]*?<\/threads>/g, "")
    .replace(/以下是此前的对话记录[\s\S]*?<\/history>/g, "");
  const i = t.lastIndexOf("新消息：");
  if (i >= 0) t = t.slice(i + 4);
  return t.trim();
}

async function coordinatorTurn(sessionId, s, text, abort, raw = "") {
  if (raw.includes("<handoff>")) await stream(sessionId, "（已接手）", abort);
  if (text.includes("上下文快满了") && FORGETFUL) {
    await stream(sessionId, "好了", abort);
    return;
  }
  if (text.includes("上下文快满了")) {
    await callTool(sessionId, s, "memory_write", {
      name: "handoff-note",
      description: "交接前保存的要点",
      type: "project",
      body: "会话轮换前的要点",
    });
    await stream(sessionId, "好了", abort);
    return;
  }
  const remember = text.match(/^记住[:：]\s*(.+)/s);
  if (remember) {
    await callTool(sessionId, s, "memory_write", {
      name: "fact-" + s.turns,
      description: remember[1].slice(0, 60),
      type: "project",
      body: remember[1],
    });
    await stream(sessionId, "记下了。", abort);
    return;
  }
  if (/项目文件|看看文件/.test(text)) {
    const files = await callTool(sessionId, s, "project_files_list", {});
    if (!Array.isArray(files) || !files.length) {
      await stream(sessionId, "项目里还没有文件。", abort);
      return;
    }
    const body = await callTool(sessionId, s, "project_file_read", {
      name: files[0].name,
    });
    await stream(
      sessionId,
      `我读了 ${files[0].name}：${String(body).slice(0, 80)}`,
      abort,
    );
    return;
  }
  if (/你记得什么|记忆/.test(text)) {
    const idx = await callTool(sessionId, s, "memory_list", {});
    await stream(sessionId, `项目记忆：\n${idx}`, abort);
    return;
  }
  if (/谢谢|thanks|多谢/i.test(text)) {
    await callTool(sessionId, s, "react", { emoji: "👍" });
    return;
  }
  if (/现在|进展|状态|status/i.test(text)) {
    const threads = await callTool(sessionId, s, "list_threads", {});
    const lines =
      Array.isArray(threads) && threads.length
        ? threads
            .map(
              (t) =>
                `- **${t.title}**：${t.status === "working" ? "进行中" : t.status === "resolved" ? "已解决" : "等你回复"}${t.current_step ? `（${t.current_step}）` : ""}`,
            )
            .join("\n")
        : "目前还没有讨论串。";
    await stream(sessionId, lines, abort);
    return;
  }
  if (/帮我|做|写|调研|实现|修|整理|开个/.test(text)) {
    const title =
      text
        .replace(/^(帮我|请|麻烦)/, "")
        .replace(/[，。！？,.!?].*$/s, "")
        .slice(0, 14) || "新任务";
    await callTool(sessionId, s, "start_thread", {
      title,
      instructions: text,
      ack: "我先把需求拆成几步。",
    });
    await stream(sessionId, "好的，开始处理。", abort);
    return;
  }
  await stream(
    sessionId,
    `收到。这是演示协调者的回复：项目里的简单问题我会直接回答，需要专门处理的工作（比如「帮我调研一下 X」）我会开一个讨论串。`,
    abort,
  );
}

async function threadTurn(sessionId, s, text, abort) {
  const task = text
    .replace(/^协调者(交给你的任务|转来的消息)：\s*/, "")
    .slice(0, 30);
  const steps = ["理解需求", "收集资料", "整理结论"];
  const list = (k) =>
    `${task}\n\n` +
    steps
      .map(
        (st, i) =>
          `${i < k ? "✓" : i === k ? "✱" : "○"} ${i === k - 1 ? `**${st}**` : st}`,
      )
      .join("\n");
  for (let k = 0; k < steps.length; k++) {
    await callTool(sessionId, s, "update_status", { text: list(k) });
    await sleep(700);
    if (abort.aborted) throw new Error("cancelled");
  }
  await callTool(sessionId, s, "update_status", { text: list(steps.length) });
  await stream(
    sessionId,
    `做完了。关于「${task}」，演示 agent 的结论是：一切顺利。\n\n需要你确认的只有一件事：结果是否符合预期？`,
    abort,
  );
  if (/完成后解决|resolve/i.test(text))
    await callTool(sessionId, s, "set_resolved", { resolved: true });
}

// Stands in for a model summarizing: keeps the previous summary and adds what
// the user said only once (repeated chatter differs only in its numbers).
// MOCK_SUMMARY_FAIL=1 makes summarizing fail, to exercise the fallback.
async function summarize(sessionId, raw, abort) {
  if (process.env.MOCK_SUMMARY_FAIL === "1") throw new Error("summary unavailable");
  const prev = (raw.match(/<previous-summary>\n([\s\S]*?)\n<\/previous-summary>/) ?? [])[1] ?? "";
  const conv = (raw.match(/<conversation>\n([\s\S]*?)\n<\/conversation>/) ?? [])[1] ?? "";
  const kept = prev.split("\n").filter((l) => l.startsWith("- "));
  const said = conv
    .split(/\n\n(?=用户：|助手：|（内部消息）：)/)
    .filter((l) => l.startsWith("用户："))
    .flatMap((l) => l.slice(3).split(/(?<=[。！？!?])|(?<=[.!?])\s+/))
    .map((x) => x.trim())
    .filter((x) => x.length >= 4);
  const key = (x) => x.replace(/\d+/g, "#");
  const count = new Map();
  for (const x of said) count.set(key(x), (count.get(key(x)) ?? 0) + 1);
  for (const x of said) {
    const line = `- ${x}`;
    if (count.get(key(x)) === 1 && !kept.includes(line)) kept.push(line);
  }
  notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: kept.join("\n") || "- （暂无）" } });
}

async function classify(sessionId, raw, abort) {
  // Pick the project whose words overlap most with the chat; "none" if nothing fits.
  const chat = (raw.match(/<chat>([\s\S]*?)<\/chat>/) ?? [])[1] ?? "";
  const projects = [
    ...raw.matchAll(/<project id="([^"]+)">([\s\S]*?)<\/project>/g),
  ];
  let best = "none",
    bestScore = 0;
  for (const [, id, desc] of projects) {
    const words = desc
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1);
    const score = words.filter((w) => chat.toLowerCase().includes(w)).length;
    if (score > bestScore) [best, bestScore] = [id, score];
  }
  // Titled after the latest thing the user said.
  const said = [...chat.matchAll(/用户：([^\n]*)/g)].map((m) => m[1]);
  const title = (said[said.length - 1] ?? "")
    .split(/[\n，。？！,.?!]/)[0]
    .trim()
    .slice(0, 12);
  await stream(sessionId, JSON.stringify({ title, project: best }), abort);
}

async function turn(sessionId, s, text, abort, sawHistory) {
  if (sawHistory)
    await stream(sessionId, "（我看到了之前的对话记录。）\n\n", abort);
  if (
    /做个页面|改一下页面/.test(text) &&
    (await toolNames(s).catch(() => [])).includes("publish_page")
  ) {
    const v = s.pageId ? 2 : 1;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#faf9f5;color:#141413}
.card{padding:32px 40px;border-radius:16px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}
button{margin-top:16px;padding:8px 16px;border-radius:8px;border:0;background:#d97757;color:#fff;font-size:15px}
</style></head><body><div class="card"><h1>计数器 v${v}</h1><div id="n" style="font-size:48px">0</div>
<button id="b">加一</button></div><script>let n=0;document.getElementById('b').onclick=()=>{document.getElementById('n').textContent=++n}<\/script></body></html>`;
    const r = await callTool(sessionId, s, "publish_page", {
      title: "计数器",
      html,
      ...(s.pageId ? { page_id: s.pageId } : {}),
    });
    s.pageId = r?.page_id ?? s.pageId;
    await stream(
      sessionId,
      v === 1 ? "做好了，页面在右边。" : "改好了，这是第 2 版。",
      abort,
    );
    return;
  }
  if (
    /帮我决定|选哪个/.test(text) &&
    (await toolNames(s).catch(() => [])).includes("ask_decision")
  ) {
    await stream(sessionId, "有一件事需要你拍板。", abort);
    await callTool(sessionId, s, "ask_decision", {
      question: "发布日期定在哪天？",
      context: "两个日期都可行，区别在测试时间。",
      options: [
        { label: "11 月 1 日", consequence: "多一周测试，更稳。" },
        { label: "10 月 25 日", consequence: "早一周上线，测试时间紧。" },
      ],
      recommended: 0,
    });
    return;
  }
  // 「更正上一条」 strikes out a sentence of the previous reply and notes the correction there.
  if (text.includes("更正上一条")) {
    await callTool(sessionId, s, "correct_message", { wrong: "我的回复是预设的", correction: "演示 Agent 的回复都是预设的，这句本身没错，这里只是演示更正。" });
    await stream(sessionId, "已在上一条回复里更正。", abort);
    return;
  }
  // 「开子对话 标题」 hands side work to a sub-conversation.
  const sub = text.match(/开子对话\s*(\S+)/);
  if (sub) {
    const r = await callTool(sessionId, s, "start_subconversation", { title: sub[1], task: `把「${sub[1]}」单独处理好，量出改动前后的差别。`, context: "原对话在讨论整体方案。" });
    await stream(sessionId, typeof r === "string" ? r : "已开启子对话。", abort);
    return;
  }
  // 「交付文件 名字」 writes a project file; 「附上 路径」 or 「附上链接 URL」 attaches an output.
  const deliver = text.match(/交付文件\s*(\S+)/);
  if (deliver) {
    const r = await callTool(sessionId, s, "project_file_write", { name: deliver[1], content: `# ${deliver[1]}\n结论：可以做。\n` });
    await stream(sessionId, r && typeof r === "object" && r.name ? `写好了：${r.name}` : `没能写好：${typeof r === "string" ? r : "这里没有项目文件夹"}`, abort);
    return;
  }
  const attach = text.match(/附上(链接)?\s*(\S+)/);
  if (attach) {
    const r = await callTool(sessionId, s, "attach_output", attach[1] ? { url: attach[2], title: "需求文档" } : { path: attach[2] });
    await stream(sessionId, `附上了：${r}`, abort);
    return;
  }
  if (/每天提醒/.test(text)) {
    const r = await callTool(sessionId, s, "create_routine", { name: "每日提醒", prompt: "提醒用户看日报", schedule: "daily", time: "09:00" });
    const list = await callTool(sessionId, s, "list_routines", {});
    await stream(sessionId, `${r}\n${list}`, abort);
    return;
  }
  const use = text.match(/用连接器\s*(\S+)\s+(\S+)/);
  if (use) {
    const c = s.connectors?.find((x) => x.mcp.name === use[1]);
    if (!c) {
      await stream(sessionId, `没有名为 ${use[1]} 的连接器。`, abort);
      return;
    }
    const out = await callTool(sessionId, c, use[2], { text: "ping" });
    await stream(
      sessionId,
      `连接器返回：${typeof out === "string" ? out : JSON.stringify(out)}`,
      abort,
    );
    return;
  }
  if (
    /截屏|截图|操控电脑|screenshot|use the computer/i.test(text) &&
    (await toolNames(s).catch(() => [])).includes("computer_screenshot")
  ) {
    // 「操控电脑，用 X」 names the app to ask for.
    // In English: "use the computer … in X" (and the request reads in English too).
    const english = !/[\u4e00-\u9fff]/.test(text);
    const app = (english ? /\bin ([A-Z][\w ]*?)(?:[.,]|$)/.exec(text)?.[1] : /用\s*([^\s，。]+)/.exec(text)?.[1]) ?? (english ? "Notepad" : "记事本");
    const reason = english ? "Write today's standup notes in Notepad and save them" : `用${app}写今天的站会笔记并保存`;
    const granted = await callTool(sessionId, s, "computer_request_access", { apps: [app], reason });
    if (typeof granted !== "string" || !granted.includes("现在允许")) {
      await stream(sessionId, `没能操控电脑：${granted}`, abort);
      return;
    }
    const seen = await callTool(sessionId, s, "computer_screenshot", {});
    const clicked = await callTool(sessionId, s, "computer_left_click", { coordinate: [200, 150] });
    const typed = await callTool(sessionId, s, "computer_type", { text: "hello from Ancora" });
    await stream(
      sessionId,
      `我看了屏幕（${String(seen).slice(0, 60)}）。点击：${String(clicked).slice(0, 80)}。输入：${String(typed).slice(0, 80)}`,
      abort,
    );
    return;
  }
  if (s.model === "mock-smart")
    await stream(
      sessionId,
      `用户说：「${text.slice(0, 40)}」。我先想一想怎么回答。`,
      abort,
      "agent_thought_chunk",
    );

  notify(sessionId, {
    sessionUpdate: "plan",
    entries: [
      { content: "理解问题", status: "completed", priority: "high" },
      { content: "查看工作目录", status: "in_progress", priority: "medium" },
      { content: "组织回答", status: "pending", priority: "medium" },
    ],
  });
  notify(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: `t${s.turns}`,
    title: `列出 ${s.cwd}`,
    kind: "read",
    status: "in_progress",
    rawInput: { path: s.cwd },
  });
  await sleep(300);
  notify(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: `t${s.turns}`,
    status: "completed",
    content: [
      {
        type: "content",
        content: { type: "text", text: "README.md\npackage.json\nsrc/" },
      },
    ],
  });

  if (/写|write/i.test(text)) {
    // Like real agents, the session's mode decides whether edits need asking.
    const res = s.mode === "acceptEdits" || s.mode === "bypassPermissions" ? { outcome: { outcome: "selected", optionId: "allow" } } : await requestClient("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: `w${s.turns}`,
        title: "写入 notes.md",
        kind: "edit",
        rawInput: { path: "notes.md" },
      },
      options: [
        { optionId: "allow", name: "允许", kind: "allow_once" },
        { optionId: "reject", name: "拒绝", kind: "reject_once" },
      ],
    });
    const ok =
      res?.outcome?.outcome === "selected" && res.outcome.optionId === "allow";
    await stream(
      sessionId,
      ok ? "已获得许可（演示中不会真的写文件）。\n\n" : "好的，不写文件。\n\n",
      abort,
    );
  }

  const reply =
    (s.turns === 1
      ? "您好！我是**演示 Agent**，用来让您先看看 Ancora 怎么用。我的回复是预设的，并不会真正理解您的问题。\n\n"
      : `这是演示 Agent 的第 ${s.turns} 次回复。\n\n`) +
    `您刚才说：\n\n> ${text.replace(/\n/g, "\n> ")}\n\n` +
    "想让 AI 真正帮您做事，请在 设置 → Agent 后端 里装好并登录 Claude Code、Codex、Grok 或 Qoder。\n\n" +
    `（演示模型：\`${s.model}\`${s.mode && s.mode !== "default" ? `，模式：\`${s.mode}\`` : ""}）`;
  notify(sessionId, {
    sessionUpdate: "plan",
    entries: [
      { content: "理解问题", status: "completed", priority: "high" },
      { content: "查看工作目录", status: "completed", priority: "medium" },
      { content: "组织回答", status: "completed", priority: "medium" },
    ],
  });
  await stream(sessionId, reply, abort);
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method == null && msg.id != null) {
    const p = pendingClientReqs.get(msg.id);
    pendingClientReqs.delete(msg.id);
    if (p) msg.error ? p.reject(msg.error) : p.resolve(msg.result);
    return;
  }
  const h = handlers[msg.method];
  if (msg.id == null) return h?.(msg.params ?? {});
  if (!h)
    return send({
      id: msg.id,
      error: { code: -32601, message: `method not found: ${msg.method}` },
    });
  try {
    send({ id: msg.id, result: (await h(msg.params ?? {})) ?? {} });
  } catch (e) {
    send({
      id: msg.id,
      error: { code: e?.code ?? -32603, message: e?.message ?? String(e), ...(e?.data ? { data: e.data } : {}) },
    });
  }
});
