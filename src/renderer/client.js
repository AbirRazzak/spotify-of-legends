const S = { settings: {}, auth: {}, playback: {}, queue: [], overlay: {}, hotkeys: [], system: {} };
let currentArt = null;
let playlistsLoaded = false;
let volumeHeldUntil = 0;
let mutedFrom = null;

// ---------- helpers ----------

function toast(text, kind = 'error') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(cleanError(e));
  }
}

function showView(name) {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
  if (name === 'library' && !playlistsLoaded) loadPlaylists();
  if (name === 'search') $('#searchInput').focus();
}

// ---------- rendering ----------

function renderPlayback() {
  const p = S.playback;
  const t = p.track;
  $('#player').classList.toggle('playing', !!p.isPlaying);
  $('#btnPlay').innerHTML = ICONS[p.isPlaying ? 'pause' : 'play'];

  setMarqueeText($('#pTitle'), t?.name ?? (S.auth.authed ? (p.hasDevice ? 'Nothing playing' : 'No active device') : '—'));
  $('#pArtist').textContent = t?.artists ?? (S.auth.authed && !p.hasDevice ? 'Start Spotify on any device' : '');
  $('#npTitle').textContent = t?.name ?? (p.hasDevice ? 'Nothing playing' : 'No active device');
  $('#npArtist').textContent = t?.artists ?? '';
  $('#npAlbum').textContent = t?.album ?? (p.hasDevice ? '' : 'Open Spotify on your PC or phone, then pick it from the device menu below.');
  $('#npEyebrow').textContent = p.isPlaying ? 'Now playing' : t ? 'Paused' : 'Idle';
  $('#tDur').textContent = fmtTime(t?.durationMs);

  const art = t?.imageLarge ?? null;
  if (art !== currentArt) {
    currentArt = art;
    $('#pArt').src = t?.image ?? '';
    $('#npArt').src = art ?? '';
    $('#np').classList.toggle('has-art', !!art);
    const splash = $('#splash');
    splash.classList.remove('show');
    if (art) {
      setTimeout(() => {
        splash.style.backgroundImage = `url("${art}")`;
        splash.classList.add('show');
      }, 250);
    }
  }

  const shuffle = $('#btnShuffle');
  shuffle.classList.toggle('on', !!p.shuffle);
  const repeat = $('#btnRepeat');
  repeat.classList.toggle('on', p.repeat && p.repeat !== 'off');
  repeat.innerHTML = ICONS[p.repeat === 'track' ? 'repeatOne' : 'repeat'];

  const dev = p.device;
  $('#deviceName').textContent = dev?.name ?? '';
  const vol = $('#volume');
  vol.disabled = !dev?.supportsVolume;
  if (dev && Date.now() > volumeHeldUntil) {
    vol.value = dev.volume ?? 0;
    setRangeFill(vol);
  }
  $('#btnMute').innerHTML = ICONS[dev && dev.volume === 0 ? 'mute' : 'volume'];
}

function renderQueue() {
  const list = $('#queue');
  if (!S.queue.length) {
    list.innerHTML = `<li class="empty-note" style="display:block;border:0">Nothing queued.</li>`;
    return;
  }
  list.innerHTML = S.queue
    .slice(0, 6)
    .map(
      (t, i) => `<li data-uri="${esc(t.uri)}" data-index="${i}" title="Play this song">
        <span class="q-num"><b>${i + 1}</b>${ICONS.play}</span>
        <img src="${esc(t.image ?? '')}" alt="">
        <div style="min-width:0"><div class="q-title">${esc(t.name)}</div><div class="q-artist">${esc(t.artists)}</div></div>
        <span class="q-dur">${fmtTime(t.durationMs)}</span>
      </li>`,
    )
    .join('');
}

function renderAuth() {
  const a = S.auth;
  document.body.classList.toggle('unauthed', !a.authed);
  $('#redirectUri').textContent = a.redirectUri ?? '';
  $('#redirectUri2').textContent = a.redirectUri ?? '';
  $('#btnDisconnect').disabled = !a.authed;
  const status = $('#acctStatus');
  if (!a.authed) status.innerHTML = `<span class="off">Not connected</span>`;
  else if (!a.user) status.innerHTML = `<span>Connected</span>`;
  else {
    const premium = a.user.product === 'premium';
    status.innerHTML = `${a.user.image ? `<img src="${esc(a.user.image)}" alt="">` : ''}
      <span>${esc(a.user.name)}</span>
      <span class="tag ${premium || !a.user.product ? '' : 'warn'}">${premium ? 'Premium' : esc(a.user.product ?? '')}</span>`;
    if (a.user.product && !premium) toast('Spotify Premium is required to control playback.', 'info');
  }
  if (a.authed && !playlistsLoaded && $('.view.active').dataset.view === 'library') loadPlaylists();
}

function renderSettings() {
  const s = S.settings;
  for (const id of ['#clientId', '#clientId2']) if (document.activeElement !== $(id)) $(id).value = s.clientId ?? '';
  $('#optOverlay').checked = !!s.overlayEnabled;
  $('#optInGame').checked = !!s.overlayOnlyInGame;
  $('#optControls').checked = s.overlayControls !== false;
  const mode = s.overlayMode === 'auto' ? 'auto' : 'always';
  document.querySelectorAll('#optMode button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('#autoOpts').classList.toggle('off', mode !== 'auto');
  $('#optShowDead').checked = !!s.overlayShowDead;
  $('#optShowTab').checked = !!s.overlayShowTab && S.system?.tabWatchAvailable !== false;
  $('#optShowTab').closest('.lol-check').classList.toggle('disabled', S.system?.tabWatchAvailable === false);
  $('#optShowPeek').checked = !!s.overlayShowPeek;
  $('#modeHint').textContent =
    mode === 'auto'
      ? 'Hidden the rest of the time, so League runs at full FPS. The overlay costs some FPS while it is on screen.'
      : 'Stays on screen. Any window over a borderless game costs some FPS; pick "Only when…" if you notice a drop.';
  $('#optHwAccel').checked = !!s.hardwareAcceleration;
  $('#restartRow').style.display = !!s.hardwareAcceleration !== !!S.system?.hardwareAcceleration ? '' : 'none';
  const op = $('#optOpacity');
  op.value = Math.round((s.overlayOpacity ?? 1) * 100);
  setRangeFill(op);
  $('#optOpacityVal').textContent = `${op.value}%`;
  const sc = $('#optScale');
  sc.value = Math.round((s.overlayScale ?? 1) * 100);
  setRangeFill(sc);
  $('#optScaleVal').textContent = `${sc.value}%`;
}

function renderOverlayState() {
  const o = S.overlay;
  const toggle = $('#overlayToggle');
  toggle.classList.toggle('on', !!o.enabled);
  toggle.querySelector('b').textContent = o.enabled ? 'On' : 'Off';
  const chip = $('#gameChip');
  chip.classList.toggle('live', !!o.inGame);
  chip.querySelector('span').textContent = o.inGame ? 'In game' : 'Not in game';
  $('#btnPosition').textContent = o.locked === false ? 'Lock overlay' : 'Position overlay';
}

function renderHotkeys() {
  $('#hotkeys').innerHTML = S.hotkeys
    .map(
      h => `<div><kbd>${esc(h.keys)}</kbd></div>
            <div>${esc(h.label)}${h.ok ? '' : '<span class="fail">(in use by another app)</span>'}</div>`,
    )
    .join('');
}

// Smooth progress between polls. Per-frame only while this window has focus; otherwise
// once a second, so a client left open on another monitor doesn't eat into game frames.
let lastSecond = -1;
function tick() {
  if (document.hasFocus()) requestAnimationFrame(tick);
  else setTimeout(tick, 1000);
  const p = S.playback;
  const dur = p.track?.durationMs || 0;
  const ms = progressAt(p);
  const pct = dur ? (ms / dur) * 100 : 0;
  $('#barFill').style.width = `${pct}%`;
  $('#barGem').style.left = `${pct}%`;
  const sec = Math.floor(ms / 1000);
  if (sec !== lastSecond) {
    lastSecond = sec;
    $('#tCur').textContent = fmtTime(ms);
  }
}

// ---------- library & search ----------

function cardHtml({ kind, uri, name, sub, image }) {
  const art =
    kind === 'liked'
      ? `<div class="card-art liked">${ICONS.heart}</div>`
      : `<div class="card-art">${ICONS.note}${image ? `<img src="${esc(image)}" alt="" loading="lazy">` : ''}</div>`;
  return `<button class="card" data-kind="${kind}" data-uri="${esc(uri ?? '')}">
    ${art}
    <span class="orb">${ICONS.play}</span>
    <div class="card-name">${esc(name)}</div>
    <div class="card-sub">${esc(sub)}</div>
  </button>`;
}

const playlistCard = p =>
  cardHtml({ kind: 'playlist', uri: p.uri, name: p.name, image: p.image, sub: [p.owner, p.total != null && `${p.total} songs`].filter(Boolean).join(' · ') });

async function loadPlaylists() {
  if (!S.auth.authed) return;
  playlistsLoaded = true;
  const grid = $('#playlists');
  grid.innerHTML = `<div class="empty-note">Loading…</div>`;
  try {
    const lists = await sol.query('playlists');
    grid.innerHTML = cardHtml({ kind: 'liked', name: 'Liked Songs', sub: 'Your saved tracks' }) + lists.map(playlistCard).join('');
  } catch (e) {
    playlistsLoaded = false;
    grid.innerHTML = `<div class="empty-note">${esc(cleanError(e))}</div>`;
  }
}

function onCardClick(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  if (card.dataset.kind === 'liked') sol.command('playLiked');
  else sol.command('play', { contextUri: card.dataset.uri });
}

const runSearch = debounce(async q => {
  const out = $('#searchResults');
  if (!q.trim()) {
    out.innerHTML = '';
    return;
  }
  try {
    const r = await sol.query('search', q);
    if ($('#searchInput').value !== q) return;
    out.innerHTML = `
      ${r.tracks.length ? `<h3 class="section-title">Songs</h3><div class="track-list">${r.tracks
        .map(
          t => `<button class="track-row" data-uri="${esc(t.uri)}" data-album="${esc(t.albumUri ?? '')}">
            <img src="${esc(t.image ?? '')}" alt="">
            <div style="min-width:0"><div class="row-title">${esc(t.name)}</div><div class="row-sub">${esc(t.artists)}</div></div>
            <div class="row-sub">${esc(t.album)}</div>
            <span class="row-dur">${fmtTime(t.durationMs)}</span>
          </button>`,
        )
        .join('')}</div>` : ''}
      ${r.playlists.length ? `<h3 class="section-title">Playlists</h3><div class="grid">${r.playlists.map(playlistCard).join('')}</div>` : ''}
      ${!r.tracks.length && !r.playlists.length ? `<div class="empty-note">No results.</div>` : ''}`;
  } catch (e) {
    out.innerHTML = `<div class="empty-note">${esc(cleanError(e))}</div>`;
  }
}, 350);

// ---------- devices ----------

async function toggleDeviceMenu() {
  const menu = $('#deviceMenu');
  if (menu.classList.contains('open')) {
    menu.classList.remove('open');
    return;
  }
  menu.innerHTML = `<div class="dd-title">Connect to a device</div><div class="empty-note" style="padding:8px 10px">Looking…</div>`;
  menu.classList.add('open');
  try {
    const devices = await sol.query('devices');
    menu.innerHTML =
      `<div class="dd-title">Connect to a device</div>` +
      (devices.length
        ? devices
            .map(d => `<button data-id="${esc(d.id)}" class="${d.active ? 'active' : ''}">${esc(d.name)}<small>${esc(d.type)}${d.active ? ' · listening' : ''}</small></button>`)
            .join('')
        : `<div class="empty-note" style="padding:8px 10px">No devices. Open Spotify on your PC or phone.</div>`);
  } catch (e) {
    menu.innerHTML = `<div class="empty-note" style="padding:8px 10px">${esc(cleanError(e))}</div>`;
  }
}

// ---------- wiring ----------

function connect(inputId, button) {
  const id = $(inputId).value.trim();
  if (!id) {
    toast('Paste your Spotify Client ID first.');
    return;
  }
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Waiting for browser…';
  toast('Finish signing in to Spotify in your browser.', 'info');
  sol
    .login(id)
    .then(() => toast('Spotify linked.', 'info'))
    .catch(e => toast(cleanError(e)))
    .finally(() => {
      button.disabled = false;
      button.textContent = label;
    });
}

function wire() {
  $('#nav').addEventListener('click', e => {
    const b = e.target.closest('button[data-view]');
    if (b) showView(b.dataset.view);
  });
  $('#btnMin').onclick = () => sol.minimize();
  $('#btnClose').onclick = () => sol.close();
  $('#overlayToggle').onclick = () => sol.setSettings({ overlayEnabled: !S.settings.overlayEnabled });

  $('#btnPlay').onclick = () => sol.command(S.playback.isPlaying ? 'pause' : 'play');
  $('#btnNext').onclick = () => sol.command('next');
  $('#btnPrev').onclick = () => sol.command('previous');
  $('#btnShuffle').onclick = () => sol.command('shuffle', !S.playback.shuffle);
  $('#btnRepeat').onclick = () => {
    const order = ['off', 'context', 'track'];
    sol.command('repeat', order[(order.indexOf(S.playback.repeat ?? 'off') + 1) % 3]);
  };
  $('#bar').onclick = e => {
    const dur = S.playback.track?.durationMs;
    if (!dur) return;
    const r = e.currentTarget.getBoundingClientRect();
    sol.command('seek', ((e.clientX - r.left) / r.width) * dur);
  };

  const vol = $('#volume');
  const sendVolume = debounce(v => sol.command('volume', v), 200);
  vol.addEventListener('input', () => {
    volumeHeldUntil = Date.now() + 2500;
    setRangeFill(vol);
    sendVolume(Number(vol.value));
  });
  $('#btnMute').onclick = () => {
    const cur = S.playback.device?.volume ?? 0;
    if (cur > 0) {
      mutedFrom = cur;
      sol.command('volume', 0);
    } else sol.command('volume', mutedFrom || 50);
  };

  $('#btnDevice').onclick = e => {
    e.stopPropagation();
    toggleDeviceMenu();
  };
  $('#deviceMenu').onclick = e => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    sol.command('transfer', b.dataset.id);
    $('#deviceMenu').classList.remove('open');
  };
  document.addEventListener('click', e => {
    if (!e.target.closest('.device-wrap')) $('#deviceMenu').classList.remove('open');
  });

  $('#playlists').addEventListener('click', onCardClick);
  $('#refreshLibrary').onclick = loadPlaylists;
  $('#queue').addEventListener('click', e => {
    const row = e.target.closest('li[data-uri]');
    if (row) sol.command('skipTo', row.dataset.uri, Number(row.dataset.index));
  });
  $('#searchInput').addEventListener('input', e => runSearch(e.target.value));
  $('#searchResults').addEventListener('click', e => {
    const row = e.target.closest('.track-row');
    if (row) sol.command('play', row.dataset.album ? { contextUri: row.dataset.album, offsetUri: row.dataset.uri } : { uris: [row.dataset.uri] });
    else onCardClick(e);
  });

  // settings
  $('#clientId').addEventListener('change', e => sol.setSettings({ clientId: e.target.value }));
  $('#btnConnect').onclick = e => connect('#clientId', e.currentTarget);
  $('#btnConnect2').onclick = e => connect('#clientId2', e.currentTarget);
  $('#clientId2').addEventListener('keydown', e => e.key === 'Enter' && $('#btnConnect2').click());
  $('#btnDisconnect').onclick = () => attempt(() => sol.logout());
  const copyRedirect = () => navigator.clipboard.writeText(S.auth.redirectUri).then(() => toast('Redirect URI copied.', 'info'));
  $('#copyRedirect').onclick = copyRedirect;
  $('#redirectUri2').onclick = copyRedirect;
  $('#redirectUri2').title = 'Click to copy';
  $('#openDashboard').onclick = e => {
    e.preventDefault();
    sol.openExternal('https://developer.spotify.com/dashboard');
  };
  $('#optOverlay').onchange = e => sol.setSettings({ overlayEnabled: e.target.checked });
  $('#optInGame').onchange = e => sol.setSettings({ overlayOnlyInGame: e.target.checked });
  $('#optControls').onchange = e => sol.setSettings({ overlayControls: e.target.checked });
  $('#optMode').onclick = e => {
    const b = e.target.closest('button[data-mode]');
    if (b) sol.setSettings({ overlayMode: b.dataset.mode });
  };
  $('#optShowDead').onchange = e => sol.setSettings({ overlayShowDead: e.target.checked });
  $('#optShowTab').onchange = e => sol.setSettings({ overlayShowTab: e.target.checked });
  $('#optShowPeek').onchange = e => sol.setSettings({ overlayShowPeek: e.target.checked });
  $('#optHwAccel').onchange = e => sol.setSettings({ hardwareAcceleration: e.target.checked });
  $('#btnRestart').onclick = () => sol.relaunch();
  const saveOpacity = debounce(v => sol.setSettings({ overlayOpacity: v / 100 }), 80);
  $('#optOpacity').addEventListener('input', e => {
    setRangeFill(e.target);
    $('#optOpacityVal').textContent = `${e.target.value}%`;
    saveOpacity(Number(e.target.value));
  });
  const saveScale = debounce(v => sol.setSettings({ overlayScale: v / 100 }), 120);
  $('#optScale').addEventListener('input', e => {
    setRangeFill(e.target);
    $('#optScaleVal').textContent = `${e.target.value}%`;
    saveScale(Number(e.target.value));
  });
  $('#btnPosition').onclick = () => sol.lockOverlay(S.overlay.locked === false);
  $('#btnResetPos').onclick = () => sol.resetOverlay();

  sol.on('playback', p => {
    S.playback = p;
    renderPlayback();
  });
  sol.on('queue', q => {
    S.queue = q;
    renderQueue();
  });
  sol.on('settings', s => {
    S.settings = s;
    renderSettings();
  });
  sol.on('auth', a => {
    const wasAuthed = S.auth.authed;
    S.auth = a;
    if (!a.authed) playlistsLoaded = false;
    renderAuth();
    if (!wasAuthed && a.authed) showView('home');
  });
  sol.on('overlay', o => {
    S.overlay = o;
    renderOverlayState();
  });
  sol.on('toast', t => toast(t.text, t.kind));
}

(async function init() {
  fillIcons();
  wire();
  Object.assign(S, await sol.init());
  renderAuth();
  renderSettings();
  renderOverlayState();
  renderHotkeys();
  renderPlayback();
  renderQueue();
  requestAnimationFrame(tick);
})();
