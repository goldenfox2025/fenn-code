import "./env";
import { release } from "node:os";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  Notification,
  safeStorage,
  screen,
  shell,
  Tray,
} from "electron";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { API_METHODS } from "../shared/ipc";

// Filled in at build time (electron.vite.config.ts).
declare const __OC_COMMIT__: string;
declare const __OC_BUILT_AT__: string;
declare const __OC_UPDATE_FEED__: string;
import type { AppEvent, AppSettings } from "../shared/model";
import { BackendManager } from "./backends/BackendManager";
import { builtinPlugins, loadPlugins } from "./backends/registry";
import { openTerminal } from "./backends/terminal";
import { AppCore } from "./core/AppCore";
import { Notifier } from "./core/Notifier";
import type { DisplayInfo, ScreenSource } from "./computer/ComputerControl";
import { inputDriver, type Coords } from "./computer/drivers";
import { legacyMacKey, OLD_NAMES, repairSecrets } from "./store/secrets";
import { resolveLang, setLang, t } from "../shared/i18n";
import { Store } from "./store/Store";
import { ToolServer } from "./tools/ToolServer";

// Apps opened from the macOS Dock or a Linux launcher get a minimal PATH, so
// agents installed with Homebrew, nvm or npm aren't found. Borrow the PATH the
// user's login shell would have.
function adoptLoginShellPath(): void {
  if (process.platform === "win32") return;
  const shellPath = process.env.SHELL || "/bin/zsh";
  try {
    const out = execFileSync(
      shellPath,
      ["-ilc", 'printf "__OC_PATH__%s__OC_PATH__" "$PATH"'],
      { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const found = out.match(/__OC_PATH__(.*)__OC_PATH__/)?.[1];
    if (!found) return;
    const merged = [...found.split(":"), ...(process.env.PATH ?? "").split(":")];
    process.env.PATH = [...new Set(merged.filter(Boolean))].join(":");
  } catch {
    // Keep the PATH we have.
  }
}
adoptLoginShellPath();

// The app used to be called openclaude, then Cove: the newest of their data moves to the new
// folder once. Electron may already have created the new folder, so entries move one by one
// (never overwriting); if the data can't be moved (e.g. an old copy is still running), the old
// folder is used where it is.
if (!process.env.ANCORA_DATA_DIR) {
  const current = app.getPath("userData");
  for (const oldName of ["Cove", "openclaude"]) {
    const legacy = join(app.getPath("appData"), oldName);
    if (current.toLowerCase() === legacy.toLowerCase() || !existsSync(join(legacy, "data")) || existsSync(join(current, "data"))) continue;
    try {
      mkdirSync(current, { recursive: true });
      for (const name of readdirSync(legacy))
        if (!existsSync(join(current, name))) renameSync(join(legacy, name), join(current, name));
      // Everything moved: the empty old folder goes too.
      if (!readdirSync(legacy).length) rmdirSync(legacy);
    } catch {
      if (!existsSync(join(current, "data"))) app.setPath("userData", legacy);
    }
    break;
  }
}

let win: BrowserWindow | null = null;
const dataDir =
  process.env.ANCORA_DATA_DIR || join(app.getPath("userData"), "data");
const resourcesDir = app.isPackaged
  ? process.resourcesPath
  : join(import.meta.dirname, "../../resources");

// Windows 11 22H2 (build 22621) added acrylic for app windows.
const nativeGlass =
  process.platform === "darwin" ||
  (process.platform === "win32" && Number(release().split(".")[2] ?? 0) >= 22621);

function publish(e: AppEvent): void {
  if (e.type === "settings") applyWindowMaterial(e.settings.theme);
  win?.webContents.send("oc:event", e);
  notifier.observe(e);
}

const notifier = new Notifier({
  enabled: () =>
    store.settings.notifications !== false && Notification.isSupported(),
  focused: () => !!win?.isFocused(),
  project: (id) => store.project(id),
  show: ({ title, body, conversationId }) => {
    const n = new Notification({
      title,
      body: body.slice(0, 180),
      silent: false,
    });
    n.on("click", () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      publish({ type: "open-conversation", conversationId });
    });
    n.show();
  },
});

const store = new Store(dataDir);
let core: AppCore;

// backends.json sits next to the data folder; it can be edited and reloaded live.
const configDir = process.env.ANCORA_DATA_DIR
  ? dataDir
  : app.getPath("userData");
const backendsFile = join(configDir, "backends.json");
// A broken backends.json must not take the app down: start with the built-in
// backends and show the error in settings.
let backendsError: string | undefined;
let plugins = (() => {
  try {
    return loadPlugins(backendsFile);
  } catch (e) {
    backendsError = e instanceof Error ? e.message : String(e);
    return builtinPlugins();
  }
})();
const isSecret = (id: string, key: string) =>
  !!plugins.find((p) => p.id === id)?.settings?.find((s) => s.key === key)
    ?.secret;

// Secrets (API keys) are encrypted with the OS keychain when available.
const seal = (v: string) =>
  v && safeStorage.isEncryptionAvailable()
    ? "enc:" + safeStorage.encryptString(v).toString("base64")
    : v;
const unseal = (v: string) => {
  if (!v.startsWith("enc:")) return v;
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(4), "base64"));
  } catch {
    return "";
  }
};

const backends = new BackendManager({
  plugins,
  settings: {
    get: (id) =>
      Object.fromEntries(
        Object.entries(store.backendSettings(id)).map(([k, v]) => [
          k,
          unseal(v),
        ]),
      ),
    set: (id, k, v) =>
      store.setBackendSetting(id, k, isSecret(id, k) ? seal(v) : v),
  },
  resourcesDir,
  nodeCommand: {
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  },
  defaultCwd: app.getPath("home"),
  emit: (e) => {
    if (e.type === "permission")
      core.chat.routePermission(e.backendId, e.request);
    if (e.type === "permission-dropped")
      core.chat.permissionDropped(e.requestId);
  },
});
const tools = new ToolServer();
// Computer control: displays captured with Electron's own API.
const displays = (): DisplayInfo[] => {
  const primary = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    name: d.label || t('显示器 {0}', i + 1),
    bounds: d.bounds,
    primary: d.id === primary,
  }))
}
const screenSource: ScreenSource = {
  displays,
  async capture(displayId, maxWidth, maxHeight, region) {
    const all = screen.getAllDisplays()
    const index = Math.max(0, all.findIndex((x) => String(x.id) === displayId))
    const d = all[index] ?? screen.getPrimaryDisplay()
    const r = region ?? { x: 0, y: 0, width: d.size.width, height: d.size.height }
    const whole = r.x <= 0 && r.y <= 0 && r.width >= d.size.width && r.height >= d.size.height
    // The whole screen is captured straight at the size the agent gets; a zoom needs full resolution to crop from.
    const fit = Math.min(maxWidth / d.size.width, maxHeight / d.size.height, 1)
    const thumb = whole
      ? { width: Math.round(d.size.width * fit), height: Math.round(d.size.height * fit) }
      : { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: thumb })
    const src = sources.find((x) => x.display_id === String(d.id)) ?? sources[index] ?? sources[0]
    if (!src || src.thumbnail.isEmpty())
      throw new Error(
        process.platform === "darwin"
          ? t("无法截屏：请在「系统设置 → 隐私与安全性 → 录屏与系统录音」里允许 Ancora。")
          : t("无法截屏。"),
      )
    let img = src.thumbnail
    if (!whole) {
      const k = img.getSize().width / d.size.width
      img = img.crop({
        x: Math.round(r.x * k),
        y: Math.round(r.y * k),
        width: Math.max(1, Math.round(r.width * k)),
        height: Math.max(1, Math.round(r.height * k)),
      })
      const s = img.getSize()
      const z = Math.min(maxWidth / s.width, maxHeight / s.height, 2)
      if (Math.abs(z - 1) > 0.01) img = img.resize({ width: Math.round(s.width * z), height: Math.round(s.height * z), quality: "best" })
    }
    const size = img.getSize()
    return { data: img.toPNG().toString("base64"), width: size.width, height: size.height }
  },
}
// Logical points to what each platform's input API wants.
const coords: Coords =
  process.platform === "win32"
    ? {
        toDevice: (x, y) => {
          const p = screen.dipToScreenPoint({ x, y })
          return [p.x, p.y]
        },
        fromDevice: (x, y) => {
          const p = screen.screenToDipPoint({ x, y })
          return [p.x, p.y]
        },
      }
    : process.platform === "linux"
      ? {
          toDevice: (x, y) => {
            const k = screen.getPrimaryDisplay().scaleFactor
            return [x * k, y * k]
          },
          fromDevice: (x, y) => {
            const k = screen.getPrimaryDisplay().scaleFactor
            return [x / k, y / k]
          },
        }
      : { toDevice: (x, y) => [x, y], fromDevice: (x, y) => [x, y] }
// While an agent controls the computer, Ancora gets out of the way (so the
// agent doesn't act on its own window) and a small always-on-top bar offers Stop.
const controlling = new Set<string>();
let controlBar: BrowserWindow | null = null;
let minimizedForControl = false;
const CONTROL_BAR_HTML = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;font:13px system-ui,-apple-system,"Segoe UI",sans-serif}
.bar{display:flex;align-items:center;gap:10px;height:100%;box-sizing:border-box;padding:0 6px 0 14px;border-radius:12px;background:#1f1e1d;color:#f5f4ef}
.dot{width:8px;height:8px;border-radius:50%;background:#d97757;animation:p 1.2s infinite}
@keyframes p{50%{opacity:.35}}span{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;-webkit-app-region:drag}
button{border:0;border-radius:8px;padding:6px 12px;background:#d97757;color:#fff;font:inherit;cursor:pointer}
</style><div class="bar"><i class="dot"></i><span id="t">${t("Ancora 正在操控电脑")}</span><button onclick="location.href='oc-stop:now'">${t("停止")}</button></div>`;

function showControlBar(): void {
  if (controlBar) return;
  const area = screen.getPrimaryDisplay().workArea;
  controlBar = new BrowserWindow({
    width: 360,
    height: 44,
    x: Math.round(area.x + (area.width - 360) / 2),
    y: area.y + 12,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  controlBar.setAlwaysOnTop(true, "screen-saver");
  // Keeps the bar out of the agent's screenshots where the OS supports it.
  controlBar.setContentProtection(true);
  controlBar.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    if (url.startsWith("oc-stop:"))
      for (const id of [...controlling]) void core.stopComputer(id);
  });
  void controlBar.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent(CONTROL_BAR_HTML),
  );
  controlBar.once("ready-to-show", () => controlBar?.showInactive());
  controlBar.webContents.once("did-finish-load", () => setControlLabel(controlLabel));
  controlBar.on("closed", () => (controlBar = null));
}

let controlLabel = "";
/** The stop bar says what the agent is doing right now. */
function setControlLabel(label: string): void {
  controlLabel = label;
  if (!controlBar || controlBar.webContents.isLoading()) return;
  const text = label ? t("Ancora 正在{0}", label) : t("Ancora 正在操控电脑");
  void controlBar.webContents
    .executeJavaScript(`document.getElementById('t').textContent=${JSON.stringify(text)}`)
    .catch(() => {});
}

function onComputerActive(conversationId: string, active: boolean): void {
  if (active) {
    controlling.add(conversationId);
    if (win && win.isVisible() && !win.isMinimized()) {
      // Linux window managers vary (and some can't minimize at all), so hide there.
      if (process.platform === "linux") win.hide();
      else win.minimize();
      minimizedForControl = true;
    }
    showControlBar();
    return;
  }
  controlling.delete(conversationId);
  if (controlling.size) return;
  controlLabel = "";
  controlBar?.close();
  if (minimizedForControl && win) {
    if (win.isMinimized()) win.restore();
    else if (!win.isVisible()) win.showInactive();
  }
  minimizedForControl = false;
}

const inputs = inputDriver(process.platform, coords, resourcesDir);
app.on("will-quit", () => inputs.dispose?.());
const computer = {
  onActive: onComputerActive,
  onAction: (_id: string, label: string) => setControlLabel(label),
  screen: screenSource,
  input: inputs,
  // Ancora's windows belong to its main process.
  isOwnApp: (a: { pid?: number; id: string; name: string }) =>
    a.pid === process.pid || (!a.pid && [a.id, a.name].some((n) => ["ancora", app.getName().toLowerCase()].includes(n.trim().toLowerCase()))),
  clipboard: {
    read: () => clipboard.readText(),
    write: (t: string) => clipboard.writeText(t),
  },
  // Windows and Linux type any text directly; macOS key events can't produce non-ASCII text, so it is pasted.
  pasteChord: process.platform === "darwin" ? "cmd+v" : undefined,
};
core = new AppCore(store, backends, publish, process.platform, tools, {
  computer,
  secrets: { seal, unseal },
  backendsConfigError: backendsError,
});
core.reloadPlugins = () => (plugins = loadPlugins(backendsFile));
core.openTerminal = openTerminal;
core.shellOpen = async (path, reveal) => {
  if (reveal) {
    shell.showItemInFolder(path);
    return undefined;
  }
  return (await shell.openPath(path)) || undefined;
};
core.backendsConfigError = backendsError;
core.info = {
  name: app.getName(),
  version: app.getVersion(),
  commit: __OC_COMMIT__ || undefined,
  builtAt: __OC_BUILT_AT__ || undefined,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  nativeGlass,
};
core.updateFeed = process.env.ANCORA_UPDATE_FEED || __OC_UPDATE_FEED__ || undefined;
core.fetchJson = async (url) => {
  const res = await net.fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// Every API method is an AppCore method of the same name.
for (const name of API_METHODS) {
  ipcMain.handle(`oc:${name}`, (_e, ...args) =>
    (core[name] as (...a: unknown[]) => unknown)(...args),
  );
}
ipcMain.handle("oc:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ["openDirectory", "createDirectory"],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("oc:exportConversation", async (_e, id: string) => {
  const conv = store.conversation(id);
  if (!conv) return false;
  const r = await dialog.showSaveDialog(win!, {
    defaultPath: `${conv.title.replace(/[\\/:*?"<>|]/g, "_")}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (r.canceled || !r.filePath) return false;
  writeFileSync(r.filePath, core.markdownOf(id));
  return true;
});
ipcMain.handle("oc:openConfigFolder", () => {
  if (!existsSync(backendsFile)) writeFileSync(backendsFile, "[]\n");
  shell.showItemInFolder(backendsFile);
});
ipcMain.on("oc:window", (_e, action: string) => {
  if (!win) return;
  if (action === "minimize") win.minimize();
  else if (action === "maximize")
    win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === "close") win.close();
});

/** The 太空玻璃 theme lets the desktop show through, blurred, where the OS can do it. */
function applyWindowMaterial(theme: string | undefined): void {
  if (!win || !nativeGlass) return;
  const glass = theme === "glass";
  try {
    if (process.platform === "darwin") win.setVibrancy(glass ? "under-window" : null);
    else win.setBackgroundMaterial(glass ? "acrylic" : "none");
    win.setBackgroundColor(glass ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#262624" : "#faf9f5");
  } catch (err) {
    console.warn("window material", err);
  }
}

function createWindow(): void {
  const isMac = process.platform === "darwin";
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: "Ancora",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#262624" : "#faf9f5",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 14, y: 14 },
    icon: appIcon(),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
    },
  });
  applyWindowMaterial(store.settings.theme);
  win.once("ready-to-show", () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL)
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  // Closing the window keeps the app running in the tray, so scheduled tasks and threads carry on.
  win.on("close", (e) => {
    if (
      quitting ||
      store.settings.runInBackground === false ||
      process.platform === "darwin"
    )
      return;
    e.preventDefault();
    win?.hide();
    ensureTray();
  });
  win.on("closed", () => (win = null));
}

let quitting = false;
let tray: Tray | null = null;

function appIcon() {
  return nativeImage.createFromPath(join(resourcesDir, "icon.png"));
}

function showWindow(): void {
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function ensureTray(): void {
  if (tray) return;
  tray = new Tray(
    appIcon().resize({ width: process.platform === "win32" ? 16 : 22 }),
  );
  tray.setToolTip("Ancora");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("打开 Ancora"), click: showWindow },
      { type: "separator" },
      { label: t("退出"), click: () => ((quitting = true), app.quit()) },
    ]),
  );
  tray.on("click", showWindow);
}

// Published pages are served from their own scheme, with their own strict policy,
// into a sandboxed iframe: scripts run, but can't reach the app or the network
// beyond loading assets.
protocol.registerSchemesAsPrivileged([{ scheme: 'oc-page', privileges: { standard: true, secure: true } }])
const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'"

// One running copy: a second launch just brings the window back.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", showWindow);

app.whenReady().then(async () => {
  // Menus, notifications and the app's own messages follow the UI language.
  const applyLanguage = (s: AppSettings) => setLang(resolveLang(s.language, app.getLocale()));
  applyLanguage(store.settings);
  core.onSettingsChanged = applyLanguage;
  protocol.handle('oc-page', (req) => {
    // oc-page://page/<id>/<version>
    const [, id, version] = new URL(req.url).pathname.split('/')
    const html = core.artifacts.html(id, Number(version) || undefined)
    return new Response(html ?? 'not found', {
      status: html ? 200 : 404,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP }
    })
  })
  await tools.start();
  // Secrets saved under the old name: carry them over once, or say which to enter again.
  // Only while the keychain works: a locked or missing one says nothing about the values.
  const keychainUsable =
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" || !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend()));
  if (store.settings.secretsRepairedFor !== app.getName() && keychainUsable) {
    const lost = repairSecrets(
      store,
      { open: (v) => safeStorage.decryptString(Buffer.from(v.slice(4), "base64")), seal },
      (id, key) => {
        const p = plugins.find((x) => x.id === id);
        return t("{0} 的 {1}", p?.name ?? id, t(p?.settings?.find((x) => x.key === key)?.label ?? key));
      },
      () => (process.platform === "darwin" ? OLD_NAMES.map(legacyMacKey).filter((k): k is Buffer => !!k) : []),
    );
    core.updateSettings({
      secretsRepairedFor: app.getName(),
      ...(lost.length ? { secretsToReenter: [...new Set([...(store.settings.secretsToReenter ?? []), ...lost])] } : {}),
    });
  }
  // Without GPU compositing, backdrop blur makes scrolling choppy; the glass theme then skips it.
  const compositing = String(app.getGPUFeatureStatus().gpu_compositing ?? "");
  core.info.softwareRendering = !compositing.startsWith("enabled") && !process.env.ANCORA_FORCE_BLUR;
  createWindow();
  core.scheduler.start();
  core.resumeInterrupted();
  app.on(
    "activate",
    () => BrowserWindow.getAllWindows().length === 0 && createWindow(),
  );
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  store.flush();
  tools.stop();
  core.scheduler.stop();
  void backends.disposeAll();
});
