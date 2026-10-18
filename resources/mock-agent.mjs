#!/usr/bin/env node
// A dependency-free ACP agent over stdio (newline-delimited JSON-RPC 2.0).
// It streams a reply word by word, shows a tool call and a plan, and asks for
// permission when the prompt mentions "写" or "write". Used for demos and tests.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// MOCK_EXIT_AT_START=1: dies before answering anything, like an agent missing a dependency.
if (process.env.MOCK_EXIT_AT_START === "1") {
  process.stderr.write("mock: missing dependency libfoo\n");
  process.exit(7);
}

// MOCK_STDIO_MCP=1 makes the mock accept only stdio MCP servers, like some real agents.
const STDIO_ONLY = process.env.MOCK_STDIO_MCP === "1";
const LEGACY_MODES = process.env.MOCK_LEGACY_MODES === "1";
// MOCK_AUTH=1 makes the mock require signing in first, like Grok without an API key.
let signedIn = process.env.MOCK_AUTH !== "1";
// MOCK_FORGETFUL=1 makes the mock never save memory before a handoff, like a model that doesn't cooperate.
const FORGETFUL = process.env.MOCK_FORGETFUL === "1";

const sessions = new Map();
let lostOnce = false;
let nextReq = 1000;
const pendingClientReqs = new Map();

const send = (msg) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const notify = (sessionId, update) =>
  send({ method: "session/update", params: { sessionId, update } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A pause that ends early once the turn is cancelled.
const nap = async (ms, abort) => { for (const end = Date.now() + ms; Date.now() < end && !abort.aborted; ) await sleep(Math.min(50, end - Date.now())); };
const requestClient = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextReq++;
    pendingClientReqs.set(id, { resolve, reject });
    send({ id, method, params });
  });

// MOCK_ALIASES=1: lists stand-ins the way Claude Code does, a "Default (recommended)" model
// that starts selected and a "Default" thinking level.
const ALIASES = process.env.MOCK_ALIASES === "1";
const models = [
  ...(ALIASES ? [{ value: "default", name: "Default (recommended)", description: "Mock Smart · 带思考过程" }] : []),
  { value: "mock-fast", name: "Mock Fast", description: "快速回复" },
  { value: "mock-smart", name: "Mock Smart", description: "带思考过程" },
];
// MOCK_DEFAULT_MODEL: the model a new session opens on (Antigravity's AGY_ACP_DEFAULT_MODEL).
const FIRST_MODEL = ALIASES ? "default" : process.env.MOCK_DEFAULT_MODEL || "mock-fast";

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
        // MOCK_SYSTEM_PROMPT=1: takes a client system prompt, as claude-agent-acp does.
        sessionCapabilities: { resume: {}, close: {}, delete: {}, ...(process.env.MOCK_SYSTEM_PROMPT === "1" ? { systemPrompt: { mode: { override: {} } } } : {}) },
        mcpCapabilities: { http: !STDIO_ONLY },
        // MOCK_META_PROMPT=1: appends a client prompt given at _meta.antigravity.systemPrompt.append (as Antigravity advertises).
        ...(process.env.MOCK_META_PROMPT === "1" ? { _meta: { antigravity: { systemPrompt: { append: true } } } } : {}),
      },
      agentInfo: { name: "fenn-code-mock", version: "0.1.0" },
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
  "session/new": ({ cwd, mcpServers, systemPrompt, _meta }) => {
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
    const mcp = usable.find((m) => m.name === "fenn");
    // Other servers are the user's connectors; each gets its own client state.
    const connectors = usable
      .filter((m) => m !== mcp)
      .map((m) => ({ mcp: m, mcpReady: null, tools: null }));
    sessions.set(sessionId, {
      // A client system prompt, or Grok's way of appending to its own (_meta.rules).
      system: systemPrompt?.content?.map((c) => c.text).join("\n") ?? _meta?.rules ?? _meta?.antigravity?.systemPrompt?.append ?? "",
      cwd,
      model: FIRST_MODEL,
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
        configOptions: configOptions(FIRST_MODEL, sessions.get(sessionId)).filter((o) => o.id === "model"),
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
      };
    // Like Claude Code, offers /compact (sent once the session exists).
    setTimeout(() => notify(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [
      { name: "compact", description: "Compress conversation history to save context window" },
      { name: "model", description: "Switch the model" },
      { name: "context", description: "Show context window usage and session stats" },
      { name: "clear", description: "Start over with an empty context" },
      { name: "deep-research", description: "Research a question across many sources and write a report" }
    ] }), 50);
    return { sessionId, configOptions: configOptions(FIRST_MODEL, sessions.get(sessionId)),
      // Grok lists each model's window in its legacy model list.
      ...(process.env.MOCK_USAGE === "meta" ? { models: { currentModelId: FIRST_MODEL, availableModels: [{ modelId: FIRST_MODEL, name: FIRST_MODEL, _meta: { totalContextTokens: 500000 } }] } } : {}) };
  },
  "session/resume": ({ sessionId, cwd }) => {
    // Sessions live only as long as this process; after a restart there is nothing to resume.
    if (!sessions.has(sessionId))
      throw { code: -32602, message: "unknown session id" };
    const s = sessions.get(sessionId);
    if (cwd) s.cwd = cwd;
    // MOCK_RESUME_LOST=1: resuming a session the agent lost "works" but it stays lost.
    if (process.env.MOCK_RESUME_LOST !== "1") s.lost = false;
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
    // A session whose helper died (Antigravity): every later prompt fails.
    if (s.lost) throw { code: -32603, message: `Session not found: ${sessionId}` };
    const abort = { aborted: false };
    s.abort = abort;
    s.turns++;
    const raw = prompt
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    // 「卡住不动」: an agent that hangs and ignores session/cancel.
    if (raw.trim().endsWith("卡住不动")) return new Promise(() => {});
    // As Grok: "/context" only draws in its own terminal; "/session-info" answers.
    if (raw.trim() === "/context") return { stopReason: "end_turn", _meta: { totalTokens: 0 } };
    if (raw.trim() === "/session-info") {
      await stream(sessionId, `Context: ${s.context ?? 0} / 500000 tokens`, abort);
      return { stopReason: "end_turn", _meta: { totalTokens: 0 } };
    }
    // "/compact" alone: the agent's own command. It must arrive first and untouched.
    if (raw.trim() === "/compact") {
      notify(sessionId, { sessionUpdate: "compaction_update", compactionId: "m" + s.turns, status: "completed" });
      s.context = 1000;
      await stream(sessionId, "上下文已压缩。", abort);
      return { stopReason: "end_turn" };
    }
    // "#压缩": compacts the context the way agents report it (ACP compaction_update).
    if (raw.includes("#压缩")) {
      notify(sessionId, { sessionUpdate: "compaction_update", compactionId: "c" + s.turns, status: "in_progress" });
      notify(sessionId, { sessionUpdate: "compaction_update", compactionId: "c" + s.turns, status: "completed" });
    }
    // "规则在哪": says where the app's notes reached it.
    if (raw.includes("规则在哪")) {
      await stream(sessionId, `系统提示：${s.system.includes("<fenn-context") ? "有" : "无"}；本条消息：${raw.includes("<fenn-context") ? "有" : "无"}`, abort);
      return { stopReason: "end_turn" };
    }
    // "#丢会话" (once per process): the agent loses the session and says so as its reply, as Antigravity does.
    if (raw.includes("#丢会话") && !lostOnce) {
      lostOnce = true;
      s.lost = true;
      await stream(sessionId, "Agent connection was lost and could not be re-established: Failed to rebuild agent: received 1000 (OK); then sent 1000 (OK)", abort);
      return { stopReason: "end_turn" };
    }
    // "#慢取消": streams until stopped, then ends the way MOCK_CANCEL_MODE says real agents do:
    // chunk (a cancel note, then cancelled), err (-32800), late (cancelled, then the note), end (the note, then end_turn).
    if (raw.includes("#慢取消")) {
      await stream(sessionId, "它不以摧", abort);
      while (!abort.aborted) await sleep(30);
      const note = () => notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The request was cancelled by the client." } });
      const mode = process.env.MOCK_CANCEL_MODE;
      if (mode === "err") throw { code: -32800, message: "The request was cancelled by the client." };
      if (mode === "late") {
        setTimeout(note, 20);
        return { stopReason: "cancelled" };
      }
      note();
      await sleep(20);
      return { stopReason: mode === "end" ? "end_turn" : "cancelled" };
    }
    // "#用量上限": answers with a usage-limit notice as an ordinary reply, the way Antigravity does.
    if (raw.includes("#用量上限")) {
      await stream(sessionId, "Usage Limit Reached. You have reached your usage limit; it will reset in 56 seconds.", abort);
      return { stopReason: "end_turn" };
    }
    // "指令是什么": repeats the newest user instructions it was given, and where (system prompt or this message).
    if (raw.includes("指令是什么")) {
      s.said = (s.said ?? []).concat(raw);
      const pick = (text) => [...text.matchAll(/(?:自定义指令|项目指令)（必须遵守）：\n([^\n<]*)/g)].map((m) => m[1]);
      const inMsg = pick(raw), inSys = pick(s.system), cleared = raw.includes("用户清空了之前给你的指令");
      await stream(sessionId, `系统：${inSys.join("|") || "无"}；本条：${cleared ? "已清空" : inMsg.join("|") || "无"}`, abort);
      return { stopReason: "end_turn" };
    }
    // "#难点 …" reports an obstacle through the app's tool ("#难点" alone clears it).
    if (raw.includes("#难点") && s.mcp) {
      const m = raw.match(/#难点\s*([^\n<]*)/);
      await callTool(sessionId, s, "set_blocker", { text: (m?.[1] ?? "").trim() });
    }
    // "#看板 标题" puts a card on the home board through the app's tool.
    if (raw.includes("#看板") && s.mcp) {
      const m = raw.match(/#看板\s*([^\n<]*)/);
      await callTool(sessionId, s, "home_board", { action: "put", title: (m?.[1] ?? "").trim() || "看板", kind: "list", data: { items: [{ text: "重启 db", tone: "warn" }, { text: "换证书", done: true }] } });
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
        await stream(sessionId, "A plain streamed reply for timing checks. ".repeat(8).trim(), abort);
      else if (text === "你看到了什么")
        notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: raw } });
      // "#留言 目标 || 时机 || 产物,… || 内容" leaves a message for another thread; inside a delivered
      // message, "#回信 …" (same fields) tries to write back to the sender.
      else if (s.mcp && (raw.includes("<peer-message") ? /#回信 /.test(raw) : /#留言 /.test(raw))) {
        const body = raw.match(raw.includes("<peer-message") ? /#回信 ([\s\S]*)/ : /#留言 ([\s\S]*)/)[1].replace(/<\/peer-message>[\s\S]*/, "");
        const [to, deliver, outs, ...rest] = body.split("||").map((x) => x.trim());
        const r = await callTool(sessionId, s, "message_thread", {
          thread_id: to, text: rest.join("||").trim(), ...(deliver ? { deliver } : {}), ...(outs ? { outputs: outs.split(",").map((x) => x.trim()) } : {}),
        });
        await stream(sessionId, "留言结果：" + (typeof r === "string" ? r : JSON.stringify(r)), abort);
      }
      else if (raw.includes("<<classify>>")) await classify(sessionId, raw, abort);
      else if (raw.includes("<<summarize>>")) await summarize(sessionId, raw, abort);
      // MOCK_LAZY=1: a model that never calls the app's tools and answers everything inline.
      else if (process.env.MOCK_LAZY === "1")
        await stream(sessionId, `好的，我直接在这里回答「${text.slice(0, 40)}」。` + "这是一个比较完整的回答，涵盖了背景、做法和下一步。".repeat(20), abort);
      else if (s.mcp && (await toolNames(s)).includes("start_thread"))
        await coordinatorTurn(sessionId, s, text, abort, raw);
      else if (s.mcp && !/^(交付文件|附上)|帮我决定|选哪个/.test(text) && (await toolNames(s)).includes("set_resolved"))
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
    // MOCK_USAGE=meta: as Grok reports it: no usage_update, the context in each update's _meta.totalTokens.
    if (mode === "meta") {
      s.context = (s.context ?? 0) + input + output;
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }, _meta: { totalTokens: s.context } } });
      return { stopReason: abort.aborted ? "cancelled" : "end_turn", _meta: { totalTokens: s.context } };
    }
    s.cost = (s.cost ?? 0) + (input + output) * 0.00001;
    s.context = (s.context ?? 0) + input + output;
    // "#大上下文" fills the context; "#静默压缩" compacts it without announcing it (as Qoder does).
    if (raw.includes("#大上下文")) s.context += 50000;
    if (raw.includes("#静默压缩")) s.context = 1000;
    notify(sessionId, { sessionUpdate: "usage_update", used: s.context, size: 200000,
      ...(mode === 'no-cost' ? {} : { cost: { amount: s.cost, currency: "USD" } }) });
    return {
      stopReason: abort.aborted ? "cancelled" : "end_turn",
      // MOCK_CACHE=1: later turns read most of their input from the cache, as real agents do.
      usage: { inputTokens: input, outputTokens: output, totalTokens: input + output, cachedReadTokens: process.env.MOCK_CACHE && s.turns > 1 ? 4000 * s.turns : 0 },
    };
  },
  // Kept, so a closed session can still be resumed (as agents keep their history).
  "session/close": () => ({}),
  // MOCK_SESSION_LOG=<file>: records which sessions the client removed from the agent's history.
  "session/delete": async ({ sessionId }) => {
    if (process.env.MOCK_SESSION_LOG) (await import("node:fs")).appendFileSync(process.env.MOCK_SESSION_LOG, `delete ${sessionId}\n`);
    return {};
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
    // MOCK_NO_MODE=1: no mode option; permissions go through `/always-approve on|off` (as Grok's do).
    ...(process.env.MOCK_NO_MODE === "1" ? [] : [{
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
    }]),
    {
      id: "effort",
      name: "Reasoning Effort",
      category: "thought_level",
      type: "select",
      currentValue: fixedEffort ? 'none' : s.effort ?? (ALIASES ? "default" : "medium"),
      // MOCK_EFFORT_REVERSED=1 lists the levels from high to low, as Codex does.
      options: fixedEffort ? [{ value: 'none', name: 'none' }] : (process.env.MOCK_EFFORT_REVERSED === '1'
        ? [{ value: "xhigh", name: "Extra High" }, { value: "high", name: "High" }, { value: "medium", name: "Medium" }, { value: "low", name: "Low" }]
        : [
        ...(ALIASES ? [{ value: 'default', name: 'Default' }] : []),
        ...(process.env.MOCK_DYNAMIC_EFFORT === '1' ? [{ value: 'none', name: 'none' }] : []),
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ]),
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
    title: `fenn/${name}`,
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
    .replace(/<fenn-context[\s\S]*?<\/fenn-context>/g, "")
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
  const approve = text.trim().match(/^\/always-approve(?:\s+(on|off))?$/);
  if (approve) {
    s.alwaysApprove = approve[1] ? approve[1] === "on" : !s.alwaysApprove;
    await stream(sessionId, `Always-approve mode ${s.alwaysApprove ? "enabled" : "disabled"}.`, abort);
    return;
  }
  if (/当前权限/.test(text)) {
    await stream(sessionId, s.alwaysApprove ? "全部自动批准" : "每次询问", abort);
    return;
  }
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
  // 「#搜新闻」: a turn as Codex streams one: an opening line, raw MCP tool names, reasoning summaries in markdown.
  if (/#搜新闻/.test(text)) {
    await stream(sessionId, "我会按新闻发布时间和事件发生时间核对，整理最近值得关注的动向。", abort);
    const tool = (i, title, rawInput) => notify(sessionId, { sessionUpdate: "tool_call", toolCallId: `news${s.turns}-${i}`, title, kind: "other", status: "completed", rawInput });
    const search = { search_query: [{ q: "扎克伯格 最新 动向" }] };
    tool(0, "Guardian Review", {});
    tool(1, "Start subagent verify_latest", {});
    tool(2, "mcp.codex_apps.search_service.web_run", search);
    await stream(sessionId, "\n\n**Gathering news sources**\n\nI'm considering how to find suitable recent news. I need about four to five substantive pieces from trustworthy outlets.", abort, "agent_thought_chunk");
    tool(3, "mcp.codex_apps.search_service.web_run", { open: [{ ref_id: "https://example.com/news/1" }] });
    tool(4, "Guardian Review", {});
    tool(5, "mcp.codex_apps.search_service.web_run", search);
    tool(6, "mcp.codex_apps.search_service.web_run", search);
    tool(7, "Interact with subagent verify_latest", {});
    tool(8, "Guardian Review", {});
    await stream(sessionId, "\n\n**Checking dates**\n\nThe subagent confirmed the publication dates.", abort, "agent_thought_chunk");
    tool(9, "Complete subagent verify_latest", {});
    await stream(sessionId, "最近有三件事值得关注：\n\n1. **新眼镜发布**：发布会上展示了新一代产品。\n2. **AI 投入**：公司继续加大数据中心投资。\n3. **播客访谈**：谈到了开源模型的路线。", abort);
    return;
  }
  // 「#啰嗦」: a talkative agent that narrates every move (as some models do); 「#啰嗦慢」 lingers so the working mark shows.
  if (/#啰嗦/.test(text)) {
    const slow = /#啰嗦慢/.test(text);
    await stream(sessionId, "收到，先在这里留一句，方便你在看板上看到。", abort);
    await stream(sessionId, "用户想确认看板上的讨论串。先看进度，再回答。", abort, "agent_thought_chunk");
    await stream(sessionId, "这是一次看板上的讨论串测试。我先更新进度，再用一两句话确认你能在看板上看到它。", abort);
    for (const [i, file] of ["README.md", "docs/plan.md"].entries()) {
      notify(sessionId, { sessionUpdate: "tool_call", toolCallId: `chat${s.turns}-${i}`, title: `读取 ${file}`, kind: "read", status: "completed", rawInput: { path: file } });
      await nap(slow ? 1500 : 50, abort);
    }
    if (slow) await nap(4000, abort);
    await stream(sessionId, "这个讨论串已经在看板上，你可以直接打开查看。进度那一栏会随着讨论串的推进自动更新，不需要你手动刷新。\n\n如果之后想把它拆成更小的任务，在讨论串里直接说就行，我会在原处更新，不会另开新的对话。", abort);
    const sub = /开子对话/.test(text) ? await callTool(sessionId, s, "start_subconversation", { title: "整理看板说明", task: "把看板的用法写成一页说明。" }) : null;
    if (sub) await stream(sessionId, "", abort);
    return;
  }
  // 「开子对话 标题」 hands side work to a sub-conversation.
  const sub = text.match(/开子对话\s*(\S+)/);
  if (sub) {
    const r = await callTool(sessionId, s, "start_subconversation", { title: sub[1], task: `把「${sub[1]}」单独处理好，量出改动前后的差别。`, context: "原对话在讨论整体方案。" });
    await stream(sessionId, typeof r === "string" ? r : "已开启子对话。", abort);
    return;
  }
  if (/在哪里工作/.test(text)) {
    await stream(sessionId, `我在 ${s.cwd} 里工作。`, abort);
    return;
  }
  // 「后台运行 命令」 starts a command through the app's terminal and leaves it running (background work).
  const bg = text.match(/后台运行\s*(.+)/);
  if (bg) {
    const r = await requestClient("terminal/create", { sessionId, command: bg[1].trim() }).catch((e) => ({ error: e?.message ?? String(e) }));
    await stream(sessionId, r.terminalId ? `已在后台运行：${bg[1].trim()}` : `没能运行：${r.error}`, abort);
    return;
  }
  // 「在 文件夹 运行 命令」 runs a command in a given folder through the app's terminal.
  const runIn = text.match(/在\s*(\S+)\s*运行\s*(.+)/);
  if (runIn) {
    const r = await requestClient("terminal/create", { sessionId, command: runIn[2].trim(), cwd: runIn[1] }).catch((e) => ({ error: e?.message ?? String(e) }));
    await stream(sessionId, r.terminalId ? `已运行：${runIn[2].trim()}` : `没能运行：${r.error}`, abort);
    return;
  }
  // 「写文件 名字」 writes a file in the working folder, as a coding agent does; 「在哪里工作」 says where that is.
  const write = text.match(/写文件\s*(\S+)/);
  if (write) {
    const path = join(s.cwd, write[1]);
    writeFileSync(path, `# ${write[1]}\n`);
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId: `w${Date.now()}`, title: `写入 ${path}`, kind: "edit", status: "completed", rawInput: { path }, locations: [{ path }] });
    await stream(sessionId, `写好了 ${write[1]}。`, abort);
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
    const typed = await callTool(sessionId, s, "computer_type", { text: "hello from Fenn Code" });
    await stream(
      sessionId,
      `我看了屏幕（${String(seen).slice(0, 60)}）。点击：${String(clicked).slice(0, 80)}。输入：${String(typed).slice(0, 80)}`,
      abort,
    );
    return;
  }
  if (s.model === "mock-smart" || s.model === "default")
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
    // 「写三次」 asks three times in a row; 「同时写三个」 asks three at once.
    const ask = (i) => s.mode === "acceptEdits" || s.mode === "bypassPermissions" ? { outcome: { outcome: "selected", optionId: "allow" } } : requestClient("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: `w${s.turns}-${i}`,
        // MOCK_ASK_TITLE: the call's title (e.g. one of the app's own tools, as Antigravity names them).
        title: process.env.MOCK_ASK_TITLE || (i ? `写入 notes-${i + 1}.md` : "写入 notes.md"),
        // MOCK_ASK_KIND=read|execute|…: asks for another kind of tool call than an edit.
        kind: process.env.MOCK_ASK_KIND || "edit",
        rawInput: { path: i ? `notes-${i + 1}.md` : "notes.md" },
        // MOCK_LOCATED=inside|outside: names the file, in the working folder or elsewhere, as real agents do.
        // MOCK_LOCATED_PATH: names this file exactly.
        ...(process.env.MOCK_LOCATED_PATH ? { locations: [{ path: process.env.MOCK_LOCATED_PATH }] }
          : process.env.MOCK_LOCATED ? { locations: [{ path: join(process.env.MOCK_LOCATED === "inside" ? s.cwd : "/elsewhere", i ? `notes-${i + 1}.md` : "notes.md") }] } : {}),
      },
      // MOCK_ASK_EN=1: English option names, as Antigravity sends them.
      options: process.env.MOCK_ASK_EN ? [
        { optionId: "always", name: "Allow Always", kind: "allow_always" },
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Deny", kind: "reject_once" },
      ] : [
        { optionId: "allow", name: "允许", kind: "allow_once" },
        { optionId: "reject", name: "拒绝", kind: "reject_once" },
      ],
    });
    const results = [];
    if (/同时写三个/.test(text)) results.push(...(await Promise.all([0, 1, 2].map(ask))));
    else for (let i = 0; i < (/写三次/.test(text) ? 3 : 1); i++) results.push(await ask(i));
    const ok = results.every((res) => res?.outcome?.outcome === "selected" && (res.outcome.optionId === "allow" || res.outcome.optionId === "always"));
    await stream(
      sessionId,
      ok ? "已获得许可（演示中不会真的写文件）。\n\n" : "好的，不写文件。\n\n",
      abort,
    );
  }

  const reply =
    (s.turns === 1
      ? "您好！我是**演示 Agent**，用来让您先看看 Fenn Code 怎么用。我的回复是预设的，并不会真正理解您的问题。\n\n"
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
  // MOCK_METHOD_LOG=<file>: one line per request the client sent, to count session/new and session/prompt.
  if (process.env.MOCK_METHOD_LOG) (await import("node:fs")).appendFileSync(process.env.MOCK_METHOD_LOG, `${msg.method}\n`);
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
