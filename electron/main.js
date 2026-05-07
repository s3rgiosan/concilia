const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { getConfig, setConfig } = require('./config');
const { SERVER_ENV_KEYS } = require('./config-schema');

function openServerLog() {
  try {
    const logsDir = app.getPath('logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, 'server.log');
    // Cap file at ~5 MB by rotating to .1 on startup
    try {
      const st = fs.statSync(logPath);
      if (st.size > 5 * 1024 * 1024) {
        fs.renameSync(logPath, path.join(logsDir, 'server.log.1'));
      }
    } catch { /* missing — fine */ }
    return fs.openSync(logPath, 'a');
  } catch (e) {
    console.error('[log] could not open server log:', e.message);
    return 'inherit';
  }
}

let mainWindow = null;
let serverProcess = null;
let serverPort = null;

function resolvePaths() {
  if (app.isPackaged) {
    const base = process.resourcesPath;
    return {
      serverEntry: path.join(base, 'app', 'server', 'index.mjs'),
      workerDir: path.join(base, 'app', 'worker', 'bin'),
      popplerBin: path.join(base, 'poppler', 'bin'),
    };
  }
  const root = path.join(__dirname, '..');
  return {
    serverEntry: path.join(root, 'server', 'index.mjs'),
    workerDir: path.join(root, 'worker', 'bin'),
    popplerBin: path.join(root, 'build', 'poppler', 'bin'),
  };
}

function startServer() {
  return new Promise((resolve, reject) => {
    const cfg = getConfig();
    if (!cfg.receiptsRoot) {
      // Allow start without receipts root; UI will prompt for settings.
      // But server requires it — defer start until configured.
      return reject(new Error('receiptsRoot not configured'));
    }
    const { serverEntry, workerDir, popplerBin } = resolvePaths();
    const rulesPath = path.join(app.getPath('userData'), 'match-rules.json');

    // Resolve bundled poppler binaries; fall back to PATH if the bundle is
    // missing (dev installs without `npm run bundle:poppler`).
    const pdftotextPath = path.join(popplerBin, 'pdftotext');
    const pdftoppmPath = path.join(popplerBin, 'pdftoppm');

    const childEnv = {
      PORT: '0',
      HOST: '127.0.0.1',
      RECEIPTS_PATH: cfg.receiptsRoot,
      RULES_PATH: rulesPath,
      WORKER_DIR: workerDir,
      NODE_BIN: process.execPath,
      ELECTRON_RUN_AS_NODE: '1',
      AI_GEMINI_SA_KEY: cfg.saKeyPath,
      AI_GEMINI_PROJECT: cfg.geminiProject,
      AI_GEMINI_LOCATION: cfg.geminiLocation,
      AI_GEMINI_MODEL: cfg.geminiModel,
      PDFTOTEXT_BIN: fs.existsSync(pdftotextPath) ? pdftotextPath : undefined,
      PDFTOPPM_BIN: fs.existsSync(pdftoppmPath) ? pdftoppmPath : undefined,
    };
    // Strip undefined / empty-string values so Node doesn't pass them as the
    // literal string "undefined" (which downstream CLIs would forward to
    // Gemini and produce confusing 404s).
    const env = { ...process.env };
    for (const [k, v] of Object.entries(childEnv)) {
      if (v != null && v !== '') env[k] = v;
    }
    const logFd = openServerLog();
    const proc = fork(serverEntry, [], { env, stdio: ['ignore', logFd, logFd, 'ipc'] });
    proc.once('message', (msg) => {
      if (msg && msg.type === 'ready') {
        serverPort = msg.port;
        resolve(msg.port);
      }
    });
    proc.once('exit', (code) => {
      console.error(`[server] exited with code ${code}`);
      // Only clear globals if THIS proc is still the active one
      if (serverProcess === proc) {
        serverProcess = null;
        serverPort = null;
      }
    });
    proc.once('error', reject);
    serverProcess = proc;
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) return resolve();
    const proc = serverProcess;
    serverPort = null;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.once('exit', finish);
    proc.once('error', finish);
    try { proc.kill('SIGTERM'); } catch { finish(); }
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } finish(); }, 3000);
  });
}

async function restartServer() {
  await stopServer();
  try {
    const port = await startServer();
    if (mainWindow) mainWindow.loadURL(`http://127.0.0.1:${port}`);
    return { ok: true };
  } catch (e) {
    console.error('[restartServer]', e.message);
    if (mainWindow) {
      // Reload setup.html with the error in the URL hash so the page can show it.
      const setupUrl = `file://${path.join(__dirname, 'setup.html')}#error=${encodeURIComponent(e.message)}`;
      mainWindow.loadURL(setupUrl);
    }
    return { ok: false, error: e.message };
  }
}

function createWindow() {
  // Pass current language synchronously to the renderer via additionalArguments;
  // preload.js exposes it on window.concilia.bootLanguage so i18n can apply
  // it before first paint, avoiding the English flash for non-English users.
  const cfg = getConfig();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Concilia',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--concilia-language=${cfg.language || 'en'}`],
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    const isLocalServer = serverPort && url.startsWith(`http://127.0.0.1:${serverPort}`);
    const isSetupPage = url.startsWith('file://') && url.endsWith('/setup.html');
    if (!isLocalServer && !isSetupPage) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  if (serverPort) {
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'setup.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

async function isServerBusy() {
  if (!serverPort) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/busy`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const j = await res.json();
    return !!j.busy;
  } catch {
    // Network failure / timeout / server hang → don't block save.
    return false;
  }
}

ipcMain.handle('config:get', () => getConfig());
ipcMain.handle('config:set', async (_e, patch) => {
  const before = getConfig();
  const wouldChangeEnv = SERVER_ENV_KEYS.some((k) => k in patch && patch[k] !== before[k]);

  if (wouldChangeEnv && (await isServerBusy())) {
    return { error: 'busy' };
  }

  const next = setConfig(patch);
  const envChanged = SERVER_ENV_KEYS.some((k) => before[k] !== next[k]);
  if (envChanged) {
    // Async-restart so renderer can paint a toast / close modal before reload.
    setTimeout(() => { restartServer().catch((e) => console.error('[restartServer]', e.message)); }, 250);
  }
  return next;
});
ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
function sanitizeFilters(filters) {
  if (!Array.isArray(filters)) return null;
  const safe = filters
    .filter((f) => f && typeof f === 'object' && typeof f.name === 'string' && Array.isArray(f.extensions))
    .map((f) => ({
      name: f.name.slice(0, 64),
      extensions: f.extensions
        .filter((e) => typeof e === 'string' && /^[a-zA-Z0-9*]+$/.test(e))
        .slice(0, 10),
    }))
    .filter((f) => f.extensions.length > 0);
  return safe.length ? safe : null;
}

ipcMain.handle('dialog:pickFile', async (_e, filters) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: sanitizeFilters(filters) || [{ name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});
app.whenReady().then(async () => {
  try { await startServer(); } catch (e) { console.warn('[startup]', e.message); }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopServer);
