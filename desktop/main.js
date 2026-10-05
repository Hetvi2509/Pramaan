// Pramaan desktop shell. Starts the existing Express backend in this process and points the window
// at it, so the web app runs unchanged and entirely offline.
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const util = require("util");
const fs = require("fs");
const net = require("net");

// PRAMAAN_RES lets the staged tree be run without building an installer.
// Chromium's own cache and local storage default to %APPDATA% on C:. Keep them beside the install when that
// folder is writable (the user picked it), so a D: install stays on D:.
try {
  const home = path.join(path.dirname(app.getPath("exe")), "userdata");
  fs.mkdirSync(home, { recursive: true });
  app.setPath("userData", home);
} catch { /* read-only install location: leave Electron's default */ }

const RES = process.env.PRAMAAN_RES ?? (app.isPackaged ? process.resourcesPath : path.join(__dirname, ".."));
const BACKEND = path.join(RES, "backend");
const ENGINE_DIR = path.join(RES, "backend", "engine");
const ENGINE_EXE = path.join(ENGINE_DIR, "pramaan-engine.exe");
const FRONTEND_DIR = path.join(RES, "frontend");
const SEED_DB = path.join(RES, "seed", "app.db");

// Where the pointer to the data folder lives. Beside the install when that is writable (the user
// chose it), otherwise the per-user app data folder.
function configPath() {
  const beside = path.join(path.dirname(app.getPath("exe")), "pramaan-config.json");
  try {
    fs.accessSync(path.dirname(beside), fs.constants.W_OK);
    return beside;
  } catch {
    return path.join(app.getPath("userData"), "pramaan-config.json");
  }
}

const readConfig = () => { try { return JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch { return {}; } };
const writeConfig = (c) => fs.writeFileSync(configPath(), JSON.stringify(c, null, 2));

// Where the install lives. A user who chose D: for the app gets D: offered for the data, never the profile on C:.
const installDir = () => path.dirname(app.getPath("exe"));
const writable = (dir) => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };

// Uninstalling deletes the whole install folder, so case data must never live inside it. (Tested: a file
// placed inside the install folder is removed by the uninstaller; one beside it is left alone.)
const isInside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// Next to the install folder, on the same drive, when that is writable; the profile folder only as a last resort.
const safeDefault = () => {
  const parent = path.dirname(installDir());
  return path.join(writable(parent) ? parent : app.getPath("documents"), "Pramaan Data");
};

async function chooseDataDir(previous) {
  for (;;) {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Choose where Pramaan stores case data",
      message: "Cases, evidence images, recovered video and the database are kept here. Pick a drive with enough free space. To reuse data from an earlier install, pick the same folder again.",
      defaultPath: previous || path.dirname(installDir()),
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Use this folder",
    });
    if (canceled || !filePaths[0]) return null;
    const picked = filePaths[0];
    // The folder is already a Pramaan data folder (it holds the database): use it as it is.
    const chosen = fs.existsSync(path.join(picked, "app.db")) ? picked : path.join(picked, "Pramaan Data");
    if (!isInside(chosen, installDir())) return chosen;
    await dialog.showMessageBox({
      type: "warning", buttons: ["Choose another folder"], title: "Choose another folder",
      message: "That folder is inside the Pramaan program folder.",
      detail: "Uninstalling Pramaan deletes its program folder, and your cases would go with it. Pick a folder outside it, for example on another drive.",
    });
  }
}

async function resolveDataDir() {
  // Silent installs and automated tests can pre-set the data folder instead of answering the dialog.
  if (process.env.PRAMAAN_DATA_DIR) return process.env.PRAMAAN_DATA_DIR;
  const config = readConfig();
  if (config.dataDir && fs.existsSync(config.dataDir)) return config.dataDir;
  const chosen = await chooseDataDir(config.dataDir);
  if (!chosen) {
    // No choice made: fall back rather than refusing to start, but never inside the program folder.
    const fallback = safeDefault();
    writeConfig({ ...config, dataDir: fallback });
    return fallback;
  }
  writeConfig({ ...config, dataDir: chosen });
  return chosen;
}

let mainWindow = null;
let logStream = null;

function note(message) {
  try { logStream?.write(`${new Date().toISOString()} ${message}\n`); } catch { /* logging must never break the app */ }
}

// A log in the data folder, so a problem on someone else's computer leaves evidence instead of a silent exit.
// It records what the backend prints, any error that would otherwise end the app, windows or helper processes
// that die, and memory use once a minute.
function startLogging(dataDir) {
  const dir = path.join(dataDir, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "pramaan.log");
  try { if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.old`); } catch { /* no log yet */ }
  logStream = fs.createWriteStream(file, { flags: "a" });
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => { note(`[${level}] ${util.format(...args)}`); original(...args); };
  }
  process.on("uncaughtException", (e) => note(`uncaughtException: ${(e && e.stack) || e}`));
  process.on("unhandledRejection", (e) => note(`unhandledRejection: ${(e && e.stack) || e}`));
  app.on("child-process-gone", (_e, d) => note(`${d.type} process gone: ${d.reason} (code ${d.exitCode})`));
  app.on("render-process-gone", (_e, _contents, d) => {
    note(`window process gone: ${d.reason} (code ${d.exitCode})`);
    // Bring the window back rather than leaving a blank one; the data is all on disk.
    if (d.reason !== "clean-exit" && mainWindow && !mainWindow.isDestroyed()) setTimeout(() => mainWindow?.webContents.reload(), 800);
  });
  app.on("before-quit", () => note("app quitting"));
  setInterval(() => note(`memory: app ${Math.round(process.memoryUsage().rss / 1048576)} MB, computer free ${Math.round(os.freemem() / 1048576)} of ${Math.round(os.totalmem() / 1048576)} MB`), 60000).unref();
  note(`started: Pramaan ${app.getVersion()}, Electron ${process.versions.electron}, Windows ${os.release()}, data folder ${dataDir}`);
  return dir;
}

// The page asks for a folder through the bridge in preload.js. Only our own local page may ask.
ipcMain.handle("pramaan:select-directory", async (event, start) => {
  if (!String(event.senderFrame?.url ?? "").startsWith("http://127.0.0.1:")) return null;
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: "Choose the output folder",
    defaultPath: typeof start === "string" && start ? start : undefined,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Use this folder",
  });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
});

function prepare(dataDir) {
  for (const sub of ["", "uploads", "outputs"]) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  const db = path.join(dataDir, "app.db");
  // The schema is created at build time; copying it avoids shipping the Prisma CLI to migrate.
  if (!fs.existsSync(db) && fs.existsSync(SEED_DB)) fs.copyFileSync(SEED_DB, db);
  return db;
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

const waitForBackend = async (port) => {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

async function start() {
  const dataDir = await resolveDataDir();
  startLogging(dataDir);
  const db = prepare(dataDir);
  const port = await freePort();

  // Sessions are signed with a secret generated once per install and kept in the data folder, so no two
  // copies of the app share one (the backend's built-in default is for development only).
  const secretFile = path.join(dataDir, "session.secret");
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  process.env.JWT_SECRET = fs.readFileSync(secretFile, "utf8").trim();

  Object.assign(process.env, {
    PORT: String(port),
    STORAGE_DIR: dataDir,
    DATABASE_URL: `file:${db}`,
    FRONTEND_DIR,
    PYTHON_EXE: ENGINE_EXE,
    PRAMAAN_FFMPEG: path.join(ENGINE_DIR, "ffmpeg.exe"),
  });
  // Keep every library's scratch and cache files inside the chosen data folder, not the user profile.
  const cache = path.join(dataDir, "cache");
  fs.mkdirSync(cache, { recursive: true });
  Object.assign(process.env, {
    TEMP: cache, TMP: cache, TMPDIR: cache,
    TORCH_HOME: path.join(cache, "torch"), XDG_CACHE_HOME: cache, HF_HOME: path.join(cache, "hf"),
    PADDLE_PDX_CACHE_HOME: path.join(cache, "paddlex"), PADDLE_HOME: path.join(cache, "paddle"),
    MPLCONFIGDIR: path.join(cache, "mpl"), PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
    // The engine's logging (platformdirs) writes under %LOCALAPPDATA%; keep it in the data folder, not on C:.
    // It follows USERPROFILE (tested), so all four are pointed at one profile folder inside the data folder.
    USERPROFILE: path.join(cache, "home"), HOME: path.join(cache, "home"),
    LOCALAPPDATA: path.join(cache, "home", "AppData", "Local"), APPDATA: path.join(cache, "home", "AppData", "Roaming"),
  });
  fs.mkdirSync(path.join(cache, "home", "AppData", "Local"), { recursive: true });
  fs.mkdirSync(path.join(cache, "home", "AppData", "Roaming"), { recursive: true });

  try {
    require(path.join(BACKEND, "dist", "index.js"));
  } catch (error) {
    dialog.showErrorBox("Pramaan could not start", String(error && error.stack || error));
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1500, height: 950, show: false, backgroundColor: "#f6f7f4",
    title: "Pramaan Forensics",
    autoHideMenuBar: true, // the menu stays reachable with Alt
    icon: path.join(__dirname, "assets", "icon.png"), // the same logo the app shows
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.js") },
  });
  mainWindow = win;
  win.on("unresponsive", () => note("window is not responding"));
  win.once("ready-to-show", () => win.show());

  if (!(await waitForBackend(port))) {
    dialog.showErrorBox("Pramaan could not start", "The local service did not come up in time.");
    app.quit();
    return;
  }
  await win.loadURL(`http://127.0.0.1:${port}/`);
  buildMenu(dataDir);
}

function buildMenu(dataDir) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "File", submenu: [
      { label: "Open data folder", click: () => shell.openPath(dataDir) },
      { label: "Change data folder…", click: async () => {
        const chosen = await chooseDataDir(dataDir);
        if (chosen) { writeConfig({ ...readConfig(), dataDir: chosen }); app.relaunch(); app.exit(0); }
      } },
      { type: "separator" }, { role: "quit" },
    ] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }] },
    { label: "Help", submenu: [{ label: "Open log folder", click: () => shell.openPath(path.join(dataDir, "logs")) }, { label: "Data folder", click: () => dialog.showMessageBox({ message: `Case data is stored in:\n${dataDir}`, buttons: ["OK"] }) }] },
  ]));
}

app.whenReady().then(start);
app.on("window-all-closed", () => { note("all windows closed"); app.quit(); });
