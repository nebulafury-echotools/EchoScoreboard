// Echo Scoreboard - Electron shell: runs server.mjs in-process, shows the dashboard in a
// window, a click-through overlay on top of Echo VR's client area, and lives in the tray.
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const PORT = Number(process.env.PORT) || 6730;
const BASE = `http://127.0.0.1:${PORT}`;
const GAME_PROC = 'echovr';
const TRAY_ONLY = process.argv.includes('--tray');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

/* ---------- logging ---------- */
let logFile = null;
function log(...a) {
  const line = `${new Date().toISOString()} ${a.map(x => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  try { if (!logFile) logFile = path.join(app.getPath('userData'), 'main.log'); fs.appendFileSync(logFile, line); } catch {}
}
process.on('uncaughtException', e => log('uncaughtException', e));
process.on('unhandledRejection', e => log('unhandledRejection', e instanceof Error ? e : String(e)));

/* ---------- settings ---------- */
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { overlay: true };
function loadSettings() { try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch {} }
function saveSettings() { try { fs.writeFileSync(settingsPath(), JSON.stringify(settings)); } catch {} }

/* ---------- server ---------- */
function getJson(p, timeout = 800) {
  return new Promise(ok => {
    const req = http.get(BASE + p, { timeout }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { ok(res.statusCode === 200 ? JSON.parse(b) : null); } catch { ok(null); } });
    });
    req.on('timeout', () => { req.destroy(); ok(null); });
    req.on('error', () => ok(null));
  });
}
function status(p) {
  return new Promise(ok => {
    const req = http.get(BASE + p, { timeout: 800 }, res => { res.resume(); ok(res.statusCode); });
    req.on('timeout', () => { req.destroy(); ok(0); });
    req.on('error', () => ok(0));
  });
}
async function startServer() {
  if (await getJson('/api/autoclip')) { log(`port ${PORT} already served by an Echo Scoreboard - reusing it`); return; }
  process.env.ECHO_SCOREBOARD_DATA = app.getPath('userData');
  process.env.PORT = String(PORT);
  const file = path.join(__dirname, '..', 'server.mjs');
  log('starting server', file, 'port', PORT, 'data', process.env.ECHO_SCOREBOARD_DATA);
  try { await import(pathToFileURL(file).href); log('server imported'); } catch (e) { log('server failed to start', e); }
}

/* ---------- main dashboard window ---------- */
let mainWin = null;
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, show: false,
    title: 'Echo Scoreboard', backgroundColor: '#060a12', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
  });
  mainWin.once('ready-to-show', () => { if (!TRAY_ONLY && mainWin) mainWin.show(); });
  mainWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url).catch(() => {}); return { action: 'deny' }; });
  mainWin.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(BASE)) { e.preventDefault(); shell.openExternal(url).catch(() => {}); }
  });
  mainWin.on('closed', () => { mainWin = null; app.quit(); });
  loadMain();
}
async function loadMain() {
  for (let i = 0; i < 120 && mainWin; i++) {
    if (await status('/')) break; // any answer means the server is up
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!mainWin) return;
  try { await mainWin.loadURL(`${BASE}/`); log('dashboard loaded'); } catch (e) { log('dashboard load failed', e); }
}
function showMain() {
  if (!mainWin) { createMainWindow(); mainWin.once('ready-to-show', () => { mainWin?.show(); mainWin?.focus(); }); return; }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show(); mainWin.focus();
}

/* ---------- overlay window ---------- */
let overlay = null, lastShown = null, lastBounds = null;
function createOverlay() {
  overlay = new BrowserWindow({
    width: 800, height: 600, show: false,
    transparent: true, frame: false, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, thickFrame: false,
    webPreferences: { backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true);
  overlay.on('closed', () => { overlay = null; });
  loadOverlay();
}
async function loadOverlay() {
  for (let i = 0; i < 120 && overlay; i++) {
    if (await status('/overlay.html')) break; // any answer (even 404) means the server is up
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!overlay) return;
  try { await overlay.loadURL(`${BASE}/overlay.html`); log('overlay loaded'); } catch (e) { log('overlay load failed', e); }
}
function applyOverlay(info) {
  if (!overlay) return;
  const want = settings.overlay && info.fg && String(info.proc).toLowerCase() === GAME_PROC && !info.min && info.rect && info.rect[2] > 0 && info.rect[3] > 0;
  if (!want) {
    if (lastShown !== false) { overlay.hide(); lastShown = false; log('overlay hidden'); }
    return;
  }
  const [x, y, w, h] = info.rect;
  const key = `${x},${y},${w},${h}`;
  if (key !== lastBounds) {
    const dip = screen.screenToDipRect(null, { x, y, width: w, height: h });
    overlay.setBounds(dip); overlay.setBounds(dip); // twice: first call can resolve against the old monitor's DPI
    lastBounds = key; log('overlay bounds', { phys: info.rect, dip });
  }
  if (lastShown !== true) {
    overlay.showInactive(); overlay.setAlwaysOnTop(true, 'screen-saver'); lastShown = true; log('overlay shown');
  }
}

/* ---------- foreground follower ---------- */
let helper = null, helperBuf = '', quitting = false, lastFgLog = 0, lastFgName = null;
function startHelper() {
  if (quitting) return;
  const script = path.join(__dirname, 'follow.ps1');
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  log('foreground helper started pid', helper.pid);
  helperBuf = '';
  helper.stdout.on('data', d => {
    helperBuf += d;
    let i;
    while ((i = helperBuf.indexOf('\n')) >= 0) {
      const line = helperBuf.slice(0, i).trim(); helperBuf = helperBuf.slice(i + 1);
      if (!line) continue;
      let info; try { info = JSON.parse(line); } catch { continue; }
      const name = info.proc || '';
      if (name !== lastFgName || Date.now() - lastFgLog > 30000) {
        log('foreground', { proc: name, pid: info.pid, min: info.min, rect: info.rect }); lastFgName = name; lastFgLog = Date.now();
      }
      applyOverlay(info);
    }
  });
  helper.stderr.on('data', d => log('helper stderr', String(d).trim()));
  helper.on('exit', code => {
    log('foreground helper exited', code); helper = null;
    if (!quitting) setTimeout(startHelper, 1000);
  });
}
function stopHelper() { quitting = true; try { helper?.kill(); } catch {} }

/* ---------- tray ---------- */
let tray = null;
function createTray() {
  let img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('Echo Scoreboard');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open dashboard', click: showMain },
    { label: 'Overlay', type: 'checkbox', checked: settings.overlay, click: m => { settings.overlay = m.checked; saveSettings(); if (!m.checked && overlay) { overlay.hide(); lastShown = false; } log('overlay enabled =', m.checked); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('double-click', showMain);
}

if (gotLock) {
  app.on('second-instance', () => { log('second instance launched'); if (app.isReady()) showMain(); });
  app.on('window-all-closed', () => {}); // main window 'closed' quits; overlay-only/tray mode stays alive
  app.on('before-quit', () => { log('quitting'); stopHelper(); });
  app.whenReady().then(async () => {
    loadSettings();
    log('app ready', app.getVersion(), 'packaged', app.isPackaged, TRAY_ONLY ? 'mode tray (no main window)' : 'mode window');
    createTray();
    await startServer();
    createMainWindow();
    createOverlay();
    startHelper();
  });
}
