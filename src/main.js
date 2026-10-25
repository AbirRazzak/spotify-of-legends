const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, screen, shell } = require('electron');
const path = require('path');
const store = require('./store');
const spotify = require('./spotify');
const league = require('./league');
const keys = require('./keys');
const { shouldShowOverlay, queuePosition } = require('./rules');

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const PRELOAD = path.join(__dirname, 'preload.js');
const OVERLAY_SIZE = { width: 380, height: 120 };

let clientWin = null;
let overlayWin = null;
let tray = null;
let quitting = false;

let playback = { hasDevice: false, ts: Date.now() };
let queue = [];
let user = null;
let lastTrackId = null;
let pollTimer = null;
let commandSeq = 0;
let commandsRunning = 0;
let overlayLocked = true;
let overlayHover = false;
let overlayPressing = false;
let peekUntil = 0;
let peekTimer = null;
let overlayControlsRect = null;
let overlayVolumeRect = null;
let volumeDrag = false;
let volumeDragTimer = null;
let volumeMouseWasDown = false;
let volumeDragValue = null;
let volumeDragSentValue = null;
let volumeDragSentAt = 0;
let overlayCssSize = null;
const hotkeyResults = [];

// Render on the CPU unless the user turned hardware acceleration on: the UI repaints
// rarely, and keeping Chromium off the GPU means the overlay doesn't compete with League.
// Chromium reads this once at startup, so changing the setting needs a restart.
store.init();
const hardwareAcceleration = store.get().hardwareAcceleration;
if (!hardwareAcceleration) app.disableHardwareAcceleration();

// exit(), not quit(): quit() still lets whenReady() run the full startup in this second copy.
if (!app.requestSingleInstanceLock()) app.exit();
app.setAppUserModelId('Spotify of Legends');

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcast(channel, payload) {
  send(clientWin, channel, payload);
  send(overlayWin, channel, payload);
}

function toast(text, kind = 'error') {
  broadcast('toast', { text, kind });
}

// ---------- windows ----------

function createClient() {
  clientWin = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    backgroundColor: '#010A13',
    icon: ICON,
    title: 'Spotify of Legends',
    show: false,
    webPreferences: { preload: PRELOAD },
  });
  clientWin.loadFile(path.join(__dirname, 'renderer', 'client.html'));
  clientWin.once('ready-to-show', () => clientWin.show());
  clientWin.on('show', () => pollSoon(0));
  clientWin.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    clientWin.hide();
  });
  clientWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function showClient() {
  if (!clientWin) return;
  if (clientWin.isMinimized()) clientWin.restore();
  clientWin.show();
  clientWin.focus();
}

function defaultOverlayPos() {
  const b = screen.getPrimaryDisplay().bounds;
  return { x: b.x + b.width - OVERLAY_SIZE.width - 24, y: b.y + 64 };
}

function overlayPos() {
  const p = store.get().overlayPos;
  const onScreen =
    p &&
    screen
      .getAllDisplays()
      .some(({ bounds: b }) => p.x >= b.x - 40 && p.x < b.x + b.width - 40 && p.y >= b.y - 10 && p.y < b.y + b.height - 40);
  return onScreen ? p : defaultOverlayPos();
}

function createOverlay() {
  overlayWin = new BrowserWindow({
    ...OVERLAY_SIZE,
    ...overlayPos(),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: !overlayLocked,
    hasShadow: false,
    show: false,
    webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  applyOverlayMouse();
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWin.webContents.on('did-finish-load', () => overlayWin.webContents.setZoomFactor(store.get().overlayScale));
  let moveTimer;
  overlayWin.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(saveOverlayPos, 300);
  });
  overlayWin.on('closed', () => (overlayWin = null));
}

function saveOverlayPos() {
  if (!overlayWin) return;
  const [x, y] = overlayWin.getPosition();
  store.set({ overlayPos: { x, y } });
}

function resizeOverlay(size) {
  overlayCssSize = size;
  if (!overlayWin || !size) return;
  const z = store.get().overlayScale;
  const [x, y] = overlayWin.getPosition();
  overlayWin.setBounds({ x, y, width: Math.ceil(size.w * z), height: Math.ceil(size.h * z) });
}

function overlayStatus() {
  return {
    enabled: store.get().overlayEnabled,
    visible: !!overlayWin?.isVisible(),
    locked: overlayLocked,
    interactive: !overlayLocked || overlayHover,
    inGame: league.inGame(),
  };
}

function updateOverlay() {
  const want = shouldShowOverlay({
    authed: spotify.isAuthed(),
    settings: store.get(),
    locked: overlayLocked,
    inGame: league.inGame(),
    hover: overlayHover,
    peeking: Date.now() < peekUntil,
    dead: league.isDead(),
    tabHeld: keys.tabHeld(),
  });
  if (want) {
    if (!overlayWin) createOverlay();
    if (!overlayWin.isVisible()) overlayWin.showInactive();
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
  } else if (overlayWin?.isVisible()) {
    overlayWin.hide();
  }
  broadcast('overlay', overlayStatus());
  rebuildTrayMenu();
}

function peek(ms = 6000) {
  const s = store.get();
  if (s.overlayMode !== 'auto' || !s.overlayShowPeek) return;
  peekUntil = Date.now() + ms;
  clearTimeout(peekTimer);
  peekTimer = setTimeout(updateOverlay, ms + 50);
  updateOverlay();
}

// Death and Tab watching only run while a mode that uses them is on.
function syncWatchers() {
  const s = store.get();
  const auto = s.overlayEnabled && s.overlayMode === 'auto';
  league.watchDeath(auto && s.overlayShowDead);
  keys.watchTab(auto && s.overlayShowTab && league.inGame());
}

function setOverlayLocked(locked) {
  if (!locked && !store.get().overlayEnabled) store.set({ overlayEnabled: true });
  overlayLocked = locked;
  overlayHover = false;
  if (overlayWin) {
    applyOverlayMouse();
    overlayWin.setFocusable(!locked);
    if (locked) saveOverlayPos();
  }
  broadcast('settings', store.get());
  updateOverlay();
}

// While locked the overlay is click-through, except when the cursor is over its controls row.
function applyOverlayMouse() {
  if (!overlayWin) return;
  overlayWin.setIgnoreMouseEvents(overlayLocked && !overlayHover);
  send(overlayWin, 'overlay', overlayStatus()); // lets the controls glow while clickable
}

// Borderless games can push themselves above other topmost windows; re-assert now and then.
// Kept rare: each z-order change makes Windows recompose the game's frame.
function keepOverlayOnTop() {
  if (overlayWin?.isVisible()) overlayWin.setAlwaysOnTop(true, 'screen-saver');
}

// Hover detection for the locked overlay's controls. Polls the cursor position instead of
// using setIgnoreMouseEvents' `forward` option, which on Windows installs a global low-level
// mouse hook that every in-game mouse movement would have to pass through.
function checkOverlayHover() {
  if (!overlayWin?.isVisible() || !overlayLocked || !overlayControlsRect || !store.get().overlayControls) {
    if (overlayHover && !overlayPressing && !volumeDrag) {
      overlayHover = false;
      applyOverlayMouse();
      watchVolumeDrag(false);
    }
    return;
  }
  const hover = isCursorIn(overlayControlsRect) || overlayPressing || volumeDrag;
  if (hover !== overlayHover) {
    overlayHover = hover;
    applyOverlayMouse();
    watchVolumeDrag(hover);
    if (!hover) {
      peek(2000); // in Peek mode, linger briefly after the cursor leaves
      updateOverlay(); // hovering kept it up; hide it now if nothing else does
    }
  }
}

// Converts a rect reported by the overlay page (CSS px) to screen coordinates.
function overlayRectOnScreen(r) {
  const b = overlayWin.getBounds();
  const z = store.get().overlayScale;
  return { x: b.x + r.x * z, y: b.y + r.y * z, w: r.w * z, h: r.h * z };
}

function isCursorIn(rect) {
  const r = overlayRectOnScreen(rect);
  const c = screen.getCursorScreenPoint();
  return c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h;
}

// Volume bar dragging on the locked overlay. While League is active, Windows drops the
// button-press half of clicks on the overlay, so the page can't see a drag start. Instead,
// while the cursor is over the controls, poll the left button: a press that starts on the
// volume bar drags it until release. Updates go to Spotify at most every 150 ms.
function watchVolumeDrag(on) {
  if (on && !volumeDragTimer) {
    volumeMouseWasDown = keys.mouseDown();
    volumeDragTimer = setInterval(trackVolumeDrag, 16);
  } else if (!on && volumeDragTimer && !volumeDrag) {
    clearInterval(volumeDragTimer);
    volumeDragTimer = null;
  }
}

function trackVolumeDrag() {
  if (!overlayWin?.isVisible() || !overlayVolumeRect) return;
  const down = keys.mouseDown();
  if (!volumeDrag && down && !volumeMouseWasDown && isCursorIn(overlayVolumeRect)) volumeDrag = true;
  volumeMouseWasDown = down;
  if (!volumeDrag) return;

  const r = overlayRectOnScreen(overlayVolumeRect);
  const pct = Math.round(Math.min(1, Math.max(0, (screen.getCursorScreenPoint().x - r.x) / r.w)) * 100);
  if (pct !== volumeDragValue) {
    volumeDragValue = pct;
    send(overlayWin, 'overlay-volume', pct);
  }
  const now = Date.now();
  if (!down || now - volumeDragSentAt > 150) {
    if (pct !== volumeDragSentValue) runCommand('volume', pct);
    volumeDragSentAt = now;
    volumeDragSentValue = pct;
  }
  if (!down) {
    volumeDrag = false;
    volumeDragValue = volumeDragSentValue = null;
    checkOverlayHover();
  }
}

// ---------- tray ----------

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Spotify of Legends');
  tray.on('click', showClient);
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const s = store.get();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Spotify of Legends', click: showClient },
      { type: 'separator' },
      { label: 'In-game overlay', type: 'checkbox', checked: s.overlayEnabled, click: m => applySettings({ overlayEnabled: m.checked }) },
      { label: 'Unlock overlay to move', type: 'checkbox', checked: !overlayLocked, click: m => setOverlayLocked(!m.checked) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

// ---------- settings ----------

const SETTINGS_SCHEMA = {
  clientId: v => String(v ?? '').trim(),
  overlayEnabled: v => !!v,
  overlayOnlyInGame: v => !!v,
  overlayControls: v => !!v,
  overlayMode: v => (v === 'auto' ? 'auto' : 'always'),
  overlayShowDead: v => !!v,
  overlayShowTab: v => !!v,
  overlayShowPeek: v => !!v,
  hardwareAcceleration: v => !!v,
  overlayOpacity: v => Math.min(1, Math.max(0.3, Number(v) || 1)),
  overlayScale: v => Math.min(1.6, Math.max(0.6, Number(v) || 1)),
};

function applySettings(partial) {
  const clean = {};
  for (const [k, fn] of Object.entries(SETTINGS_SCHEMA)) if (k in partial) clean[k] = fn(partial[k]);
  const s = store.set(clean);
  if ('overlayScale' in clean && overlayWin) {
    overlayWin.webContents.setZoomFactor(s.overlayScale);
    resizeOverlay(overlayCssSize);
  }
  if (clean.overlayEnabled === false && !overlayLocked) setOverlayLocked(true);
  if (clean.overlayControls === false) {
    overlayHover = false;
    applyOverlayMouse();
  }
  broadcast('settings', s);
  syncWatchers();
  updateOverlay();
  return s;
}

// ---------- playback polling ----------

function progressNow() {
  if (!playback.track) return 0;
  return playback.progressMs + (playback.isPlaying ? Date.now() - playback.ts : 0);
}

async function poll() {
  clearTimeout(pollTimer);
  const seq = commandSeq;
  let delay = clientWin?.isVisible() || overlayWin?.isVisible() ? 2000 : 8000;
  if (spotify.isAuthed()) {
    try {
      const next = await spotify.getPlayback();
      // Drop results that started before a command or landed while one was still running
      // (a skip-to-song is several requests), so optimistic state doesn't flicker back.
      if (seq === commandSeq && !commandsRunning) {
        playback = next;
        broadcast('playback', playback);
        const id = playback.track?.id ?? null;
        if (id !== lastTrackId) {
          lastTrackId = id;
          refreshQueue();
          if (id) peek();
        }
      }
    } catch (e) {
      if (e.retryAfter) delay = e.retryAfter * 1000;
    }
  }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, delay);
}

function pollSoon(ms = 350) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}

async function refreshQueue() {
  try {
    queue = playback.track ? await spotify.query('queue') : [];
  } catch {
    queue = [];
  }
  broadcast('queue', queue);
}

function applyOptimistic(name, args) {
  const now = Date.now();
  const p = playback;
  if (name === 'pause') playback = { ...p, isPlaying: false, progressMs: progressNow(), ts: now };
  else if (name === 'play' && !args[0]) playback = { ...p, isPlaying: true, progressMs: progressNow(), ts: now };
  else if (name === 'seek') playback = { ...p, progressMs: args[0], ts: now };
  else if (name === 'volume' && p.device) playback = { ...p, device: { ...p.device, volume: Math.max(0, Math.min(100, args[0])) } };
  else if (name === 'shuffle') playback = { ...p, shuffle: !!args[0] };
  else if (name === 'repeat') playback = { ...p, repeat: args[0] };
  else if (name === 'skipTo') {
    const [uri, index] = args;
    const at = queuePosition(queue, uri, index);
    if (at < 0) return;
    playback = { ...p, track: queue[at], isPlaying: true, progressMs: 0, ts: now };
    queue = queue.slice(at + 1);
    broadcast('queue', queue);
  } else return;
  broadcast('playback', playback);
}

async function runCommand(name, ...args) {
  commandSeq++;
  commandsRunning++;
  try {
    applyOptimistic(name, args);
    await spotify.command(name, ...args);
  } catch (e) {
    toast(e.message);
  } finally {
    commandsRunning--;
  }
  pollSoon(['next', 'previous', 'play', 'transfer', 'skipTo'].includes(name) ? 600 : 350);
}

// ---------- auth ----------

function authStatus() {
  return {
    authed: spotify.isAuthed(),
    redirectUri: spotify.REDIRECT_URI,
    user: user && { name: user.display_name || user.id, product: user.product ?? null, image: user.images?.[0]?.url ?? null },
  };
}

async function refreshUser() {
  try {
    user = spotify.isAuthed() ? await spotify.query('me') : null;
  } catch {
    user = null;
  }
  broadcast('auth', authStatus());
}

// ---------- hotkeys ----------

const HOTKEYS = [
  ['CommandOrControl+Alt+O', 'Ctrl + Alt + O', 'Show / hide overlay', () => applySettings({ overlayEnabled: !store.get().overlayEnabled })],
  ['CommandOrControl+Alt+L', 'Ctrl + Alt + L', 'Unlock / lock overlay (move it)', () => setOverlayLocked(!overlayLocked)],
  ['CommandOrControl+Alt+P', 'Ctrl + Alt + P', 'Play / pause', () => hotkeyCommand(playback.isPlaying ? 'pause' : 'play')],
  ['CommandOrControl+Alt+.', 'Ctrl + Alt + .', 'Next track', () => hotkeyCommand('next')],
  ['CommandOrControl+Alt+,', 'Ctrl + Alt + ,', 'Previous track', () => hotkeyCommand('previous')],
  ['CommandOrControl+Alt+=', 'Ctrl + Alt + =', 'Volume up', () => hotkeyCommand('volume', (playback.device?.volume ?? 50) + 10)],
  ['CommandOrControl+Alt+-', 'Ctrl + Alt + -', 'Volume down', () => hotkeyCommand('volume', (playback.device?.volume ?? 50) - 10)],
];

// Hotkey presses also pop the overlay up in Peek mode, so you can see what changed.
function hotkeyCommand(name, ...args) {
  peek();
  return runCommand(name, ...args);
}

function registerHotkeys() {
  for (const [accel, keys, label, fn] of HOTKEYS) {
    let ok = false;
    try {
      ok = globalShortcut.register(accel, fn);
    } catch {}
    hotkeyResults.push({ keys, label, ok });
  }
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('init', () => ({
    settings: store.get(),
    auth: authStatus(),
    playback,
    queue,
    overlay: overlayStatus(),
    hotkeys: hotkeyResults,
    system: { hardwareAcceleration, tabWatchAvailable: keys.available() },
  }));
  ipcMain.handle('settings:set', (_e, partial) => applySettings(partial ?? {}));
  ipcMain.handle('auth:login', async (_e, clientId) => {
    applySettings({ clientId });
    await spotify.login(store.get().clientId);
    await refreshUser();
    pollSoon(0);
    showClient();
    return authStatus();
  });
  ipcMain.handle('auth:logout', () => {
    spotify.logout();
    return authStatus();
  });
  ipcMain.handle('spotify:command', (_e, name, ...args) => runCommand(name, ...args));
  ipcMain.handle('spotify:query', (_e, name, ...args) => spotify.query(name, ...args));
  ipcMain.handle('overlay:lock', (_e, locked) => setOverlayLocked(!!locked));
  ipcMain.handle('overlay:reset', () => {
    store.set({ overlayPos: null });
    const { x, y } = defaultOverlayPos();
    overlayWin?.setPosition(x, y);
  });
  ipcMain.on('overlay:size', (_e, size) => {
    overlayControlsRect = size?.controls ?? null;
    overlayVolumeRect = size?.volume ?? null;
    resizeOverlay(size);
  });
  ipcMain.on('overlay:pressing', (_e, pressing) => {
    overlayPressing = !!pressing;
    checkOverlayHover();
  });
  ipcMain.on('window:minimize', e => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on('window:close', e => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
  });
  ipcMain.handle('open:external', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://developer.spotify.com/')) shell.openExternal(url);
  });
}

// ---------- lifecycle ----------

app.on('second-instance', showClient);
app.on('before-quit', () => (quitting = true));
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {}); // keep running in the tray

app.whenReady().then(async () => {
  await spotify.init(store.get().clientId);
  spotify.events.on('auth', () => {
    if (!spotify.isAuthed()) {
      user = null;
      playback = { hasDevice: false, ts: Date.now() };
      broadcast('playback', playback);
    }
    broadcast('auth', authStatus());
    updateOverlay();
  });
  league.events.on('change', () => {
    syncWatchers();
    updateOverlay();
  });
  league.events.on('dead', updateOverlay);
  keys.events.on('tab', updateOverlay);

  registerIpc();
  registerHotkeys();
  createClient();
  createTray();
  league.start();
  syncWatchers();
  refreshUser();
  updateOverlay();
  poll();
  setInterval(keepOverlayOnTop, 15000);
  setInterval(checkOverlayHover, 100);
});
