const { app, BrowserWindow, ipcMain, dialog, nativeImage, Tray, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Pitaya Core: dane w ~/.config/Pitayas/Convert, ustawienia, logi, aktualizacje
const core = require('./core').create({
  id: 'convert',
  folder: 'Convert',
  name: 'Pitaya Convert',
  repo: 'MangoLabz/Pitayas-Convert',
  appDir: __dirname,
  defaults: { quality: 'balanced', encoder: 'auto' },
});
const { createEngine } = require('./engine');

// ffmpeg dołączony do aplikacji (w paczce leży poza app.asar)
let bundledFfmpeg = null;
try { bundledFfmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked'); } catch {}
const engine = createEngine({ bundledFfmpeg, log: (...a) => core.log.info(...a) });

let mainWindow = null;
let tray = null;
let isQuitting = false;
let hasShownTrayNotification = false;
let current = null;          // { controller, output } trwającej konwersji
let lastOutputPath = null;

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quit() {
  isQuitting = true;
  if (current) current.controller.abort();
  app.quit();
}

function hideToTray() {
  if (!mainWindow) return;
  mainWindow.hide();
  if (process.platform === 'win32' && tray && !hasShownTrayNotification) {
    tray.displayBalloon({ title: 'Pitaya Convert', content: 'Aplikacja nadal działa w zasobniku systemowym.', iconType: 'info' });
    hasShownTrayNotification = true;
  }
}

function appIcon() {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const p = path.join(__dirname, file);
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : null;
}

function createWindow() {
  const icon = appIcon();
  mainWindow = new BrowserWindow({
    width: 620,
    height: 720,
    minWidth: 560,
    minHeight: 640,
    frame: false,
    title: 'Pitaya Convert',
    backgroundColor: '#121116',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload wczytuje core/bridge.js
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideToTray();
    }
  });

  if (!tray && icon) {
    tray = new Tray(icon.resize({ width: 22, height: 22 }));
    tray.setToolTip('Pitaya Convert');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Otwórz Pitaya Convert', click: showWindow },
      { type: 'separator' },
      { label: 'Zamknij aplikację całkowicie', click: quit },
    ]));
    tray.on('click', () => (mainWindow.isVisible() ? mainWindow.hide() : showWindow()));
    tray.on('balloon-click', showWindow);
  }
}

if (core.singleInstance(showWindow)) {
  core.registerIpc({ beforeRestart: () => { isQuitting = true; if (current) current.controller.abort(); } });

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.pitayas.convert');
    createWindow();
    // Wykrywanie koderów trwa kilka sekund — robimy je od razu w tle
    engine.detect().catch((err) => core.log.error('Wykrywanie koderów:', err));
  });

  app.on('before-quit', () => { isQuitting = true; });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

// ───── Okno ─────
ipcMain.on('pitaya:win-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('pitaya:win-close', hideToTray);
ipcMain.on('app-quit', quit);

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], title: 'Wybierz plik do konwersji' });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

ipcMain.handle('show-output', () => {
  if (lastOutputPath && fs.existsSync(lastOutputPath)) {
    shell.showItemInFolder(lastOutputPath);
    return true;
  }
  return false;
});

// ───── Konwersja ─────
ipcMain.handle('convert:detect', async (event, force) => {
  const det = await engine.detect({ force: Boolean(force) });
  return {
    encoders: det.encoders.map(({ id, label, kind, codec }) => ({ id, label, kind, codec })),
    best: det.best ? det.best.id : null,
    ffmpeg: det.binaries,
  };
});

ipcMain.handle('convert:probe', async (event, file) => {
  try {
    const category = engine.categoryOf(file);
    if (!category) return { ok: false, error: 'Ten format pliku nie jest obsługiwany.' };
    const info = await engine.probe(file);
    const targets = engine.targetsFor(file, info);
    const copyable = {};
    if (targets.category === 'video') {
      for (const ext of ['mp4', 'mkv', 'mov', 'webm', 'avi']) copyable[ext] = engine.canCopy(info, ext).video;
    }
    return { ok: true, info, targets, copyable };
  } catch (err) {
    core.log.warn('Analiza pliku:', file, err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('convert:start', async (event, job) => {
  if (current) return { ok: false, error: 'Konwersja już trwa.' };
  const controller = new AbortController();
  current = { controller };
  core.settings.set({ quality: job.quality, encoder: job.encoder || 'auto' });
  core.log.info('Konwersja:', job.input, '→', job.ext, `(${job.quality}, ${job.encoder || 'auto'})`);
  const send = (channel, data) => { if (!event.sender.isDestroyed()) event.sender.send(channel, data); };
  try {
    const res = await engine.convert(job, {
      signal: controller.signal,
      onProgress: (p) => send('convert:progress', p),
      onNotice: (text) => send('convert:notice', text),
    });
    lastOutputPath = res.output;
    core.log.info('Gotowe:', res.output, res.encoder);
    return { ok: true, ...res };
  } catch (err) {
    const cancelled = controller.signal.aborted;
    if (!cancelled) core.log.error('Konwersja nie powiodła się:', job.input, err.message);
    return { ok: false, cancelled, error: cancelled ? 'Przerwano' : err.message };
  } finally {
    current = null;
  }
});

ipcMain.handle('convert:estimate', async (event, info, job) => {
  try { return await engine.estimate(info, job); } catch { return null; }
});

ipcMain.handle('convert:cancel', () => {
  if (current) current.controller.abort();
  return true;
});
