import "./env";
import { homedir, release } from "node:os";
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
  session,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { existsSync, mkdirSync, watch } from "node:fs";
import { moveAppData } from "./store/migrateFolder";
import { mergePath, usualBinDirs } from "./loginPath";
import { API_METHODS, type ApiMethod, type CoreApi } from "../shared/ipc";

// Filled in at build time (electron.vite.config.ts).
declare const __OC_COMMIT__: string;
declare const __OC_BUILT_AT__: string;
declare const __OC_UPDATE_FEED__: string;
import type { AppEvent, AppSettings, BoardWidgetBody } from "../shared/model";
import { BackendManager } from "./backends/BackendManager";
import { builtinPlugins, loadPlugins } from "./backends/registry";
import { openTerminal } from "./backends/terminal";
import { AppCore } from "./core/AppCore";
import { Notifier } from "./core/Notifier";
import type { DisplayInfo, ScreenSource } from "./computer/ComputerControl";
import { inputDriver, type Coords } from "./computer/drivers";
import { ControlWindow } from "./computer/controlWindow";
import { legacyMacKey, OLD_NAMES, repairSecrets } from "./store/secrets";
import { resolveLang, setLang, t } from "../shared/i18n";
import { Store } from "./store/Store";
import { ToolServer } from "./tools/ToolServer";

// Apps opened from the macOS Dock or a Linux launcher get a minimal PATH, so
// agents installed with Homebrew, nvm or npm aren't found. Borrow the PATH the
// user's login shell would have.
function adoptLoginShellPath(): Promise<void> {
  if (process.platform === "win32") return Promise.resolve();
  // The usual places right away; the shell's own PATH (which may be slow: oh-my-zsh, nvm) is put in front once it answers.
  process.env.PATH = mergePath(undefined, process.env.PATH, usualBinDirs(homedir()));
  const shellPath = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    execFile(
      shellPath,
      ["-ilc", 'printf "__OC_PATH__%s__OC_PATH__" "$PATH"'],
      { encoding: "utf8", timeout: 4000, windowsHide: true },
      (_err, out) => {
        const found = String(out ?? "").match(/__OC_PATH__(.*)__OC_PATH__/)?.[1];
        // A slow or broken shell profile: the usual places above still apply.
        if (found) process.env.PATH = mergePath(found, process.env.PATH, []);
        resolve();
      },
    ).stdin?.end();
  });
}
const loginPath = adoptLoginShellPath();

// The app used to be called openclaude, then Cove, then Ancora: the newest of their data moves to the new
// folder once (store/migrateFolder.ts). While an old copy still runs on it, or if it can't be moved,
// the old folder is used where it is.
if (!process.env.FENN_DATA_DIR) {
  const current = app.getPath("userData");
  for (const oldName of ["Ancora", "Cove", "openclaude"]) {
    const legacy = join(app.getPath("appData"), oldName);
    if (current.toLowerCase() === legacy.toLowerCase() || !existsSync(join(legacy, "data")) || existsSync(join(current, "data"))) continue;
    let ok = false;
    try {
      ok = moveAppData(legacy, current);
    } catch {
      // Left as it was.
    }
    if (!ok) app.setPath("userData", legacy);
    break;
  }
}

let win: BrowserWindow | null = null;
const dataDir =
  process.env.FENN_DATA_DIR || join(app.getPath("userData"), "data");
const resourcesDir = app.isPackaged
  ? process.resourcesPath
  : join(import.meta.dirname, "../../resources");

// Windows 11 22H2 (build 22621) added acrylic for app windows.
const nativeGlass =
  process.platform === "darwin" ||
  (process.platform === "win32" && Number(release().split(".")[2] ?? 0) >= 22621);

function publish(e: AppEvent): void {
  if (e.type === "settings") applyWindowMaterial(e.settings);
  win?.webContents.send("oc:event", e);
  notifier.observe(e);
}

const notifier = new Notifier({
  enabled: () =>
    store.settings.notifications !== false && Notification.isSupported(),
  focused: () => !!win?.isFocused(),
  project: (id) => store.project(id),
  onlyStartedThreads: (id) => {
    const last = [...store.messagesOf(id)].reverse().find((m) => m.role === 'assistant' && !m.hidden)
    const text = last?.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('').trim() ?? ''
    return !!last?.blocks.some((b) => b.type === 'thread-card') && text.length <= 40
  },
  show: ({ title, body, conversationId }) => {
    const n = new Notification({
      title,
      body: body.slice(0, 180),
      silent: false,
    });
    n.on("click", () => {
      // On macOS the window may be closed while the app runs: open it, then the conversation once it has loaded.
      const fresh = !win;
      showWindow();
      if (fresh) win?.webContents.once("did-finish-load", () => publish({ type: "open-conversation", conversationId }));
      else publish({ type: "open-conversation", conversationId });
    });
    n.show();
  },
});

// Paths saved while the data lived in a former folder (output cards, chats' folders) point here now.
const movedFolders = process.env.FENN_DATA_DIR
  ? []
  : ["Ancora", "Cove", "openclaude"]
      .map((n) => join(app.getPath("appData"), n))
      .filter((old) => old.toLowerCase() !== app.getPath("userData").toLowerCase() && !existsSync(join(old, "data")))
      .map((from) => ({ from, to: app.getPath("userData") }));
const store = new Store(dataDir, movedFolders);
let core: AppCore;

// backends.json sits next to the data folder; it can be edited and reloaded live.
const configDir = process.env.FENN_DATA_DIR
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

/** A secret the keychain won't open (access refused, or the app's signature changed): the value is kept, and Settings asks for it again. */
const unreadable = new Set<string>();
function secretLabel(id: string, key: string): string {
  const p = plugins.find((x) => x.id === id);
  return t("{0} 的 {1}", p?.name ?? id, t(p?.settings?.find((x) => x.key === key)?.label ?? key));
}
function unreadableSecret(id: string, key: string): void {
  if (unreadable.has(`${id}\0${key}`)) return;
  unreadable.add(`${id}\0${key}`);
  setTimeout(() => {
    const label = secretLabel(id, key);
    const list = store.settings.secretsToReenter ?? [];
    if (core && !list.includes(label)) void core.updateSettings({ secretsToReenter: [...list, label] });
  }, 0);
}

const backends = new BackendManager({
  plugins,
  settings: {
    get: (id) =>
      Object.fromEntries(
        Object.entries(store.backendSettings(id)).map(([k, v]) => {
          const plain = unseal(v);
          if (v.startsWith("enc:") && !plain) unreadableSecret(id, k);
          return [k, plain];
        }),
      ),
    set: (id, k, v) =>
      store.setBackendSetting(id, k, isSecret(id, k) ? seal(v) : v),
  },
  resourcesDir,
  nodeCommand: {
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  },
  // Sessions with no folder of their own (model probes, titles) run in the app's scratch space, never the home folder.
  defaultCwd: (mkdirSync(join(dataDir, "workspaces", "_app"), { recursive: true }), join(dataDir, "workspaces", "_app")),
  canWorkIn: (path) => !!core && !core.unsafeFolder(path),
  defaultModel: (id) => store.settings.backendModelDefaults?.[id],
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
          ? t("无法截屏：请在「系统设置 → 隐私与安全性 → 录屏与系统录音」里允许 Fenn Code。")
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
// While an agent controls the computer, Fenn Code gets out of the way (so the
// agent doesn't act on its own window) and a small always-on-top bar offers Stop.
const controlling = new Set<string>();
let controlBar: BrowserWindow | null = null;
const CONTROL_BAR_HTML = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;font:13px system-ui,-apple-system,"Segoe UI",sans-serif}
.bar{display:flex;align-items:center;gap:10px;height:100%;box-sizing:border-box;padding:0 6px 0 14px;border-radius:12px;background:#1f1e1d;color:#f5f4ef}
.dot{width:8px;height:8px;border-radius:50%;background:#3fd6f5;animation:p 1.2s infinite}
@keyframes p{50%{opacity:.35}}span{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;-webkit-app-region:drag}
button{border:0;border-radius:8px;padding:6px 12px;background:#3fd6f5;color:#062630;font:inherit;cursor:pointer}
</style><div class="bar"><i class="dot"></i><span id="t">${t("Fenn Code 正在操控电脑")}</span><button onclick="location.href='oc-stop:now'">${t("停止")}</button></div>`;

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
  const text = label ? t("Fenn Code 正在{0}", label) : t("Fenn Code 正在操控电脑");
  void controlBar.webContents
    .executeJavaScript(`document.getElementById('t').textContent=${JSON.stringify(text)}`)
    .catch(() => {});
}

const controlWindow = new ControlWindow(() => win, process.platform);

function onComputerActive(conversationId: string, active: boolean): void {
  controlWindow.setActive(conversationId, active);
  if (active) {
    controlling.add(conversationId);
    showControlBar();
    return;
  }
  controlling.delete(conversationId);
  if (controlling.size) return;
  controlLabel = "";
  controlBar?.close();
}

/** An agent asks for access to more programs: the card is in the main window, so it comes back, on that chat. */
function onComputerAsking(conversationId: string, asking: boolean): void {
  controlWindow.setAsking(conversationId, asking);
  if (asking) publish({ type: "open-conversation", conversationId });
}

const inputs = inputDriver(process.platform, coords, resourcesDir, () => {
  // Asking for Accessibility also shows macOS's own prompt the first time.
  if (!systemPreferences.isTrustedAccessibilityClient(true))
    return t("macOS 需要授权：在「系统设置 → 隐私与安全性 → 辅助功能」里允许 Fenn Code，然后再试。");
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted")
    return t("macOS 需要授权：在「系统设置 → 隐私与安全性 → 屏幕录制」里允许 Fenn Code，然后重新打开 Fenn Code 再试。");
  return undefined;
});
app.on("will-quit", () => inputs.dispose?.());
const computer = {
  onActive: onComputerActive,
  onAsking: onComputerAsking,
  onAction: (_id: string, label: string) => setControlLabel(label),
  screen: screenSource,
  input: inputs,
  // Fenn Code's windows belong to its main process.
  isOwnApp: (a: { pid?: number; id: string; name: string }) =>
    a.pid === process.pid || (!a.pid && [a.id, a.name].some((n) => ["fenn", "fenncode", app.getName().toLowerCase()].includes(n.trim().toLowerCase()))),
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
// Any card in a conversation that controls the computer (an agent asking to run a command) is in the main window too.
core.chat.cardListeners.add((conversationId, waiting) => {
  controlWindow.setCard(conversationId, waiting);
  if (waiting && controlWindow.fronts(conversationId)) publish({ type: "open-conversation", conversationId });
});
// Watch the directory so atomic editor saves (rename + replace) also take effect.
let configReloadTimer: NodeJS.Timeout | undefined;
let configReload = Promise.resolve();
const configWatcher = watch(configDir, (_event, filename) => {
  if (filename && filename.toString() !== 'backends.json') return;
  clearTimeout(configReloadTimer);
  configReloadTimer = setTimeout(() => {
    configReload = configReload.then(async () => { await core.reloadBackends(); }).catch((error) => console.warn('Reloading backends', error));
  }, 400);
});
configWatcher.unref();
core.openTerminal = openTerminal;
// Test runs keep the folders made for chats inside their own data folder.
core.documentsDir = process.env.FENN_DATA_DIR
  ? join(process.env.FENN_DATA_DIR, "Documents")
  : app.getPath("documents");
core.shellOpen = async (path, reveal) => {
  if (reveal) {
    shell.showItemInFolder(path);
    return undefined;
  }
  return (await shell.openPath(path)) || undefined;
};
core.shellTrash = (path) => shell.trashItem(path);
core.backendsConfigError = backendsError;
core.backendsFile = backendsFile;
core.dialogs = {
  openFolder: async (defaultPath) => {
    const r = await dialog.showOpenDialog(win!, { defaultPath, properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  },
  saveFile: async (defaultName, filters) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: defaultName, filters });
    return r.canceled || !r.filePath ? null : r.filePath;
  },
};
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
core.updateFeed = process.env.FENN_UPDATE_FEED || __OC_UPDATE_FEED__ || undefined;
core.fetchJson = async (url) => {
  const res = await net.fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// Every API method is an AppCore method of the same name; the compiler checks each one's
// parameters and result against FennApi, so adding a method means the list plus AppCore.
const handlers: { [K in ApiMethod]: (...a: Parameters<CoreApi[K]>) => ReturnType<CoreApi[K]> | Awaited<ReturnType<CoreApi[K]>> } = core;
for (const name of API_METHODS) {
  ipcMain.handle(`oc:${name}`, (_e, ...args) =>
    (handlers[name] as (...a: unknown[]) => unknown).apply(core, args),
  );
}
ipcMain.on("oc:window", (_e, action: string) => {
  if (!win) return;
  if (action === "minimize") win.minimize();
  else if (action === "maximize")
    win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === "close") win.close();
});

/**
 * The glass look lets the desktop show through, blurred, where the OS can do it.
 * The page cross-fades between looks (App.tsx): glass turns on under the still-opaque
 * page, and turns off only once the page has faded to opaque, so the switch of the
 * window's material never shows as a flash.
 */
let materialTimer: NodeJS.Timeout | undefined;
let glassShown: boolean | undefined;
function applyWindowMaterial(settings: { theme?: string; glass?: boolean }): void {
  followLook(settings);
  if (!win || !nativeGlass) return;
  const glass = !!settings.glass;
  clearTimeout(materialTimer);
  if (glassShown && !glass) {
    glassShown = false;
    materialTimer = setTimeout(() => setWindowMaterial(settings), 450);
    return;
  }
  glassShown = glass;
  setWindowMaterial(settings);
}

/**
 * The window's own parts (its frame and border on Windows, the glass material on macOS,
 * native menus and dialogs) take the look chosen in the app, not only the system's.
 */
function followLook(settings: { theme?: string }): void {
  const source = settings.theme === "light" ? "light" : settings.theme === "dark" || settings.theme === "glass" ? "dark" : "system";
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
}

function setWindowMaterial(settings: { theme?: string; glass?: boolean }): void {
  if (!win) return;
  const glass = !!settings.glass;
  const dark = settings.theme === "dark" || (settings.theme !== "light" && nativeTheme.shouldUseDarkColors);
  try {
    if (process.platform === "darwin") win.setVibrancy(glass ? "under-window" : null);
    else win.setBackgroundMaterial(glass ? "acrylic" : "none");
    win.setBackgroundColor(glass ? "#00000000" : dark ? "#262624" : "#faf9f5");
  } catch (err) {
    console.warn("window material", err);
  }
}

function createWindow(): void {
  const isMac = process.platform === "darwin";
  // A window reopened from the Dock saves what is typed in its files on close and quit, like the first.
  editsFlushed = false;
  followLook(store.settings);
  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1440, area.width);
  const height = Math.min(900, area.height);
  win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(860, width),
    minHeight: Math.min(560, height),
    show: false,
    title: "Fenn Code",
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
  applyWindowMaterial(store.settings);
  win.once("ready-to-show", () => win?.show());
  // Only web and mail links leave the app. Anything else (file:, a relative link resolved against the
  // app itself, a custom scheme) would have the system open or run it, from text an agent wrote.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.split("#")[0] !== win?.webContents.getURL().split("#")[0]) e.preventDefault();
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
    ) {
      // Text typed in a file a moment ago is saved before the window goes.
      if (!editsFlushed && win && !quitting) {
        e.preventDefault();
        void flushEdits().then(() => win?.close());
      }
      return;
    }
    e.preventDefault();
    win?.hide();
    ensureTray();
  });
  win.on("closed", () => (win = null));
}

let quitting = false;
let tray: Tray | null = null;

/** On Windows the .ico, whose 16–256 px sizes are drawn for each size (a scaled-down PNG blurs in the taskbar). */
function appIcon() {
  return nativeImage.createFromPath(join(resourcesDir, process.platform === "win32" ? "icon.ico" : "icon.png"));
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
    process.platform === "win32" ? appIcon() : appIcon().resize({ width: 22 }),
  );
  tray.setToolTip("Fenn Code");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("打开 Fenn Code"), click: showWindow },
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
/** An html card's page, starting from the app's colors so it can match the look it sits in. */
function boardPage(body: BoardWidgetBody | undefined, colors: URLSearchParams): string | undefined {
  if (body?.kind !== 'html') return undefined
  const vars = [...colors].filter(([k, v]) => /^[a-z0-9-]{1,24}$/.test(k) && /^[#(),.%\w\s-]{1,60}$/.test(v)).map(([k, v]) => `--${k}:${v}`).join(';')
  return `<!doctype html><meta charset="utf-8"><style>:root{${vars}}html,body{margin:0;background:transparent;color:var(--text);font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}</style>${body.html}`
}
const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'"

/**
 * The menu bar. On macOS: the app menu with 设置… (⌘,), Edit (copy, paste, undo in every field) and Window.
 * Reload and the developer tools stay out of a packaged build.
 */
function appMenu(): void {
  // Windows and Linux show no menu bar; a packaged build drops Electron's default one too (Reload, DevTools).
  // Copy, paste and undo in text fields work without it there.
  if (process.platform !== "darwin") {
    if (app.isPackaged) Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.getName(),
        submenu: [
          { role: "about", label: t("关于 Fenn Code") },
          { type: "separator" },
          { label: t("设置…"), accelerator: "Cmd+,", click: () => (showWindow(), publish({ type: "open-settings" })) },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: t("退出 Fenn Code") },
        ],
      },
      { role: "editMenu" },
      ...(app.isPackaged ? [] : [{ role: "viewMenu" as const }]),
      { role: "windowMenu" },
    ]),
  );
}

// One running copy: a second launch just brings the window back.
if (!app.requestSingleInstanceLock()) app.quit();
// Notifications and the taskbar group under the installed app's id (the installer's shortcuts carry the same).
if (process.platform === "win32") app.setAppUserModelId("dev.fenncode.desktop");
app.on("second-instance", showWindow);

/**
 * Programs the app starts (npm, curl, the agents) take a proxy from the environment, not from
 * the system's proxy settings. When the environment names none, pass on the system's, so
 * installs and agents work the same whether Fenn Code was started from a terminal or a shortcut.
 */
async function adoptSystemProxy(): Promise<void> {
  if (["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some((k) => process.env[k])) return;
  try {
    const rule = await session.defaultSession.resolveProxy("https://registry.npmjs.org");
    const m = /^(PROXY|HTTPS)\s+([^;\s]+)/.exec(rule.trim());
    if (!m) return;
    const url = `${m[1] === "HTTPS" ? "https" : "http"}://${m[2]}`;
    process.env.HTTPS_PROXY = url;
    process.env.HTTP_PROXY = url;
    // The app's own tool server and bridges are on this computer.
    process.env.NO_PROXY ??= "localhost,127.0.0.1,::1";
    // Node programs (npm, ACP adapters) read these variables only when told to.
    process.env.NODE_USE_ENV_PROXY ??= "1";
  } catch {
    // No proxy settings to read: leave the environment as it is.
  }
}

app.whenReady().then(async () => {
  // A packaged app takes its Dock icon from the bundle; one run from source would show Electron's.
  if (process.platform === "darwin" && !app.isPackaged)
    app.dock?.setIcon(nativeImage.createFromPath(join(import.meta.dirname, "../../build/icon.png")));
  // Agents are looked for on the PATH: wait for the login shell's (it gives up by itself after 4 s).
  await loginPath;
  await adoptSystemProxy();
  // Menus, notifications and the app's own messages follow the UI language.
  const applyLanguage = (s: AppSettings) => setLang(resolveLang(s.language, app.getLocale()));
  applyLanguage(store.settings);
  core.onSettingsChanged = applyLanguage;
  protocol.handle('oc-page', (req) => {
    // oc-page://page/<id>/<version>, or oc-page://board/<card id>/<updated>?<the look's colors> for an html card on the home board
    const url = new URL(req.url)
    const [, id, version] = url.pathname.split('/')
    const html = url.host === 'board' ? boardPage(core.snapshot().boardWidgets?.find((w) => w.id === id)?.body, url.searchParams) : core.artifacts.html(id, Number(version) || undefined)
    return new Response(html ?? 'not found', {
      status: html ? 200 : 404,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP }
    })
  })
  await tools.start();
  // Secrets saved under the old name: carry them over once, or say which to enter again.
  // Only while the keychain works: a locked or missing one says nothing about the values.
  // After the window is up, and without blocking it: macOS may ask the user about each old key.
  const repairOldSecrets = async () => {
    if (store.settings.secretsRepairedFor === app.getName()) return;
    const keychainUsable =
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" || !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend()));
    if (!keychainUsable) return;
    const legacyKeys = async () => {
      if (process.platform !== "darwin") return [];
      const keys: Buffer[] = [];
      // One at a time: each may bring up its own keychain prompt.
      for (const name of OLD_NAMES) {
        const k = await legacyMacKey(name);
        if (k) keys.push(k);
      }
      return keys;
    };
    const lost = await repairSecrets(
      store,
      { open: (v) => safeStorage.decryptString(Buffer.from(v.slice(4), "base64")), seal },
      secretLabel,
      legacyKeys,
    );
    core.updateSettings({
      secretsRepairedFor: app.getName(),
      ...(lost.length ? { secretsToReenter: [...new Set([...(store.settings.secretsToReenter ?? []), ...lost])] } : {}),
    });
  };
  // Without GPU compositing, backdrop blur makes scrolling choppy; the glass theme then skips it.
  // At ready the GPU process may not have reported yet, so the answer is read again when it does.
  const readCompositing = () => {
    const compositing = String(app.getGPUFeatureStatus().gpu_compositing ?? "");
    const software = !compositing.startsWith("enabled") && !process.env.FENN_FORCE_BLUR;
    if (software === core.info.softwareRendering) return;
    core.info.softwareRendering = software;
    publish({ type: "rendering", softwareRendering: software });
  };
  readCompositing();
  app.on("gpu-info-update", readCompositing);
  appMenu();
  createWindow();
  core.scheduler.start();
  core.resumeInterrupted();
  // Once the window is up: the agents the user wants ready start alongside (no prompt is sent),
  // after old secrets are carried over so they start with keys they can read.
  const repaired = new Promise<void>((done) => setTimeout(() => void repairOldSecrets().catch((e) => console.warn("secret repair failed:", e)).finally(done), 500));
  setTimeout(() => void repaired.then(() => core.prestartBackends()), 1500);
  app.on(
    "activate",
    () => BrowserWindow.getAllWindows().length === 0 && createWindow(),
  );
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/** Set once the window has saved what was typed in its files; quitting waits for that (a second at most). */
let editsFlushed = false;
async function flushEdits(): Promise<void> {
  const w = win;
  if (w && !w.isDestroyed())
    await Promise.race([
      w.webContents.executeJavaScript("window.__fennFlushEdits?.()").catch(() => undefined),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  editsFlushed = true;
}

/** Set once the agents' programs have been stopped; quitting waits for that (a few seconds at most). */
let agentsStopped = false;
let stoppingAgents = false;

app.on("before-quit", (e) => {
  if (!editsFlushed && win && !win.isDestroyed()) {
    e.preventDefault();
    void flushEdits().then(() => app.quit());
    return;
  }
  if (agentsStopped) return;
  e.preventDefault();
  if (stoppingAgents) return;
  stoppingAgents = true;
  quitting = true;
  clearTimeout(configReloadTimer);
  configWatcher.close();
  store.freeze();
  tools.stop();
  core.scheduler.stop();
  // An agent's program outlives the app unless it is stopped first (Antigravity's server cleans up after itself only then).
  void Promise.race([backends.disposeAll(), new Promise((r) => setTimeout(r, 6000))]).then(() => {
    agentsStopped = true;
    app.quit();
  });
});
