const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs   = require('fs');

let mainWindow;
let serverProcess;
let startedBackend = false;

/* ── Data directory: writable even inside Program Files / ASAR ── */
// userData = %APPDATA%\panels-beacon  (Windows)
//          = ~/Library/Application Support/panels-beacon  (Mac)
//          = ~/.config/panels-beacon  (Linux)
const DATA_DIR      = path.join(app.getPath('userData'), 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const SERVERS_PATH  = path.join(DATA_DIR, 'servers.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}


function rmDirSafe(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/* ── Migrate old data/settings.json next to the exe if it exists ─ */
function migrateDataIfNeeded() {
  const oldSettings = path.join(__dirname, 'data', 'settings.json');
  const oldServers  = path.join(__dirname, 'data', 'servers.json');
  try {
    if (fs.existsSync(oldSettings) && !fs.existsSync(SETTINGS_PATH)) {
      ensureDataDir();
      fs.copyFileSync(oldSettings, SETTINGS_PATH);
    }
    if (fs.existsSync(oldServers) && !fs.existsSync(SERVERS_PATH)) {
      ensureDataDir();
      fs.copyFileSync(oldServers, SERVERS_PATH);
    }
  } catch { /* ignore migration errors */ }
}

/* ── Spawn the Express server as a child process ─────────────── */
function startExpressServer() {
  // Pass the userData path so server.js can write tmp_uploads there
  const env = {
    ...process.env,
    PANELS_DATA_DIR: DATA_DIR,
    PANELS_TMP_DIR:  path.join(app.getPath('userData'), 'tmp_uploads'),
  };

  // When packaged, server.js is inside the asar — we need the unpacked path
  let serverPath;
  if (app.isPackaged) {
    // electron-builder unpacks server.js + node_modules to resources/app.asar.unpacked
    serverPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'server.js');
  } else {
    serverPath = path.join(__dirname, 'server.js');
  }

  const { fork } = require('child_process');
  serverProcess = fork(serverPath, [], { env, silent: false });
  serverProcess.on('error', err => console.error('[main] server error:', err));
  serverProcess.on('exit',  code => console.log('[main] server exited:', code));
}


async function waitForBackendReady(port, timeoutMs = 7000) {
  const started = Date.now();
  const url = `http://127.0.0.1:${port}/health`;
  while (Date.now() - started < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = require('http').get(url, res => {
          res.resume();
          return (res.statusCode === 200) ? resolve() : reject(new Error(`status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(800, () => { req.destroy(new Error('timeout')); });
      });
      return;
    } catch (_) {
      await new Promise(r => setTimeout(r, 180));
    }
  }
  throw new Error(`Backend not ready on ${url}`);
}

/* ── Create window ───────────────────────────────────────────── */
function createWindow() {
  mainWindow = new BrowserWindow({
    width:    1400,
    height:   900,
    minWidth: 1100,
    minHeight:700,
    frame:    false,
    backgroundColor: '#0d0d0f',
    icon:     path.join(__dirname, 'public', 'icon.png'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ── App lifecycle ───────────────────────────────────────────── */

async function isBackendUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

app.whenReady().then(async () => {
  ensureDataDir();
  migrateDataIfNeeded();

  const port = Number(process.env.PORT || 3847);
  const alreadyUp = await isBackendUp(port);

  if (!alreadyUp) {
    startExpressServer();
    startedBackend = true;
    await waitForBackendReady(port).catch(err => console.warn('[main] backend not ready:', err.message));
  } else {
    console.log('[main] backend already running on', port);
  }

  createWindow();
});

app.on('window-all-closed', () => {
  if (startedBackend) serverProcess?.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => { if (!mainWindow) createWindow(); });

app.on('before-quit', () => { serverProcess?.kill(); });

/* ── IPC ─────────────────────────────────────────────────────── */
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());


ipcMain.handle('wipe-everything', async () => {
  const userData = app.getPath('userData');

  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData();
  } catch (e) {
    console.warn('[main] clear session failed:', e.message);
  }

  try {
    // Remove everything inside userData, then recreate.
    for (const entry of fs.readdirSync(userData)) {
      const p = path.join(userData, entry);
      fs.rmSync(p, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn('[main] wipe userData failed:', e.message);
  }

  app.relaunch();
  app.exit(0);
  return { ok: true };
});

ipcMain.handle('settings-get', () => {
  const s = readJson(SETTINGS_PATH, { theme: 'sakura' });
  // Never return raw token to renderer — it reads from file on demand
  return s;
});
ipcMain.handle('settings-save', (_, d) => { writeJson(SETTINGS_PATH, d); return true; });
ipcMain.handle('servers-get',   ()     => readJson(SERVERS_PATH, []));
ipcMain.handle('servers-save',  (_, d) => { writeJson(SERVERS_PATH, d); return true; });

ipcMain.handle('dialog-open-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog-open-bg', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Background (image or video)',
    properties: ['openFile'],
    filters: [
      { name: 'Images & Videos', extensions: ['jpg','jpeg','png','gif','webp','mp4','webm','mov'] },
      { name: 'Images',          extensions: ['jpg','jpeg','png','gif','webp'] },
      { name: 'Videos',          extensions: ['mp4','webm','mov'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.on('open-external', (_, url) => shell.openExternal(url));


/* ── Internal browser window (LuckPerms editor etc.) ─────────── */
function openInternalWindow(url) {
  const win = new BrowserWindow({
    width:  1200,
    height: 800,
    minWidth:  900,
    minHeight: 600,
    backgroundColor: '#0d0d0f',
    icon: path.join(__dirname, 'public', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(url);
  return win;
}

ipcMain.on('open-internal', (_e, url) => {
  if (!url || typeof url !== 'string') return;
  openInternalWindow(url);
});

/* ── Panel maintenance ───────────────────────────────────────── */
ipcMain.handle('panel-reset-settings', () => {
  writeJson(SETTINGS_PATH, { theme: 'sakura' });
  return true;
});

ipcMain.handle('panel-wipe-data-cache', () => {
  // Wipes: settings.json, servers.json, plus backend logs/audit/tmp.
  rmDirSafe(DATA_DIR);
  ensureDataDir();
  writeJson(SETTINGS_PATH, { theme: 'sakura' });
  writeJson(SERVERS_PATH,  []);
  return true;
});
