// Spotify Web API client: PKCE login via a loopback redirect, encrypted token
// storage, and the playback/library calls the app needs. Controls whichever
// Spotify device is active (desktop app, phone, etc.), which requires Premium.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { app, shell, safeStorage } = require('electron');
const { queuePosition } = require('./rules');

const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
].join(' ');

const events = new EventEmitter();
let clientId = '';
let tokens = null; // { access_token, refresh_token, expires_at }
let refreshing = null;
let cancelLogin = null;

// ---------- token storage ----------

const tokenFile = () => path.join(app.getPath('userData'), 'tokens.bin');

// Logins saved by the older synchronous safeStorage API decrypt fine with the async one.
async function loadTokens() {
  try {
    const buf = await fs.promises.readFile(tokenFile());
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      tokens = JSON.parse(buf.toString('utf8'));
      return;
    }
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(buf);
    tokens = JSON.parse(result);
    if (shouldReEncrypt) await saveTokens(); // the key was rotated; store under the current one
  } catch {
    tokens = null;
  }
}

// Saves run one after another, each writing the latest tokens, so a slow encrypt can't
// let an older token set overwrite a newer one.
let saving = Promise.resolve();

function saveTokens() {
  saving = saving.then(writeTokens).catch(e => console.warn('Saving Spotify login failed:', e.message));
  return saving;
}

async function writeTokens() {
  if (!tokens) {
    await fs.promises.rm(tokenFile(), { force: true });
    return;
  }
  const json = JSON.stringify(tokens);
  const buf = (await safeStorage.isAsyncEncryptionAvailable())
    ? await safeStorage.encryptStringAsync(json)
    : Buffer.from(json, 'utf8');
  // Write then rename, so a crash mid-write can't leave a half-written login behind.
  await fs.promises.writeFile(`${tokenFile()}.tmp`, buf);
  await fs.promises.rename(`${tokenFile()}.tmp`, tokenFile());
}

async function init(id) {
  clientId = id;
  await loadTokens();
}

const isAuthed = () => !!tokens?.refresh_token;

function logout() {
  tokens = null;
  saveTokens();
  events.emit('auth');
}

// ---------- OAuth (Authorization Code + PKCE) ----------

const callbackPage = error => `<!doctype html><meta charset="utf-8"><title>Spotify of Legends</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#010A13;color:#F0E6D2;font:16px 'Segoe UI',sans-serif">
<div style="text-align:center;border:2px solid #C8AA6E;padding:40px 56px;background:#0A1428">
<h1 style="margin:0 0 12px;font:700 24px Georgia,serif;letter-spacing:.08em;text-transform:uppercase;color:${error ? '#E84057' : '#C8AA6E'}">
${error ? 'Link failed' : 'Spotify linked'}</h1>
<p style="margin:0;color:#A09B8C">${error ? String(error).replace(/[<>&]/g, '') : 'You can close this tab and return to Spotify of Legends.'}</p></div>`;

function login(id) {
  if (!id) return Promise.reject(new Error('Enter your Spotify Client ID first.'));
  clientId = id;
  cancelLogin?.(new Error('Login restarted'));

  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');

  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error') || (url.searchParams.get('state') !== state && 'State mismatch');
      if (error || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackPage(error || 'No code'));
        finish(new Error(`Spotify authorization failed: ${error || 'no code returned'}`));
        return;
      }
      try {
        await exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackPage(null));
        finish(null);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackPage(e.message));
        finish(e);
      }
    });

    const timeout = setTimeout(() => finish(new Error('Spotify login timed out.')), 5 * 60 * 1000);
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cancelLogin = null;
      server.close();
      if (err) reject(err);
      else {
        events.emit('auth');
        resolve();
      }
    }
    cancelLogin = finish;

    server.on('error', e =>
      finish(e.code === 'EADDRINUSE' ? new Error(`Port ${PORT} is busy; close whatever is using it and retry.`) : e),
    );
    server.listen(PORT, '127.0.0.1', () => {
      const q = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        scope: SCOPES,
        state,
      });
      shell.openExternal(`https://accounts.spotify.com/authorize?${q}`);
    });
  });
}

async function exchange(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error_description || data.error || `Token request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens?.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await saveTokens();
}

async function accessToken() {
  if (!isAuthed()) throw Object.assign(new Error('Spotify is not connected.'), { status: 401 });
  if (Date.now() > tokens.expires_at - 60_000) {
    refreshing ??= exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
      .catch(e => {
        if (e.status === 400) logout(); // refresh token revoked or expired
        throw e;
      })
      .finally(() => (refreshing = null));
    await refreshing;
  }
  return tokens.access_token;
}

// ---------- Web API ----------

async function api(method, endpoint, { query, body, retry = true } = {}) {
  const url = new URL(`https://api.spotify.com/v1${endpoint}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body ? JSON.stringify(body) : method === 'GET' ? undefined : '',
  });
  if (res.status === 401 && retry) {
    tokens.expires_at = 0;
    return api(method, endpoint, { query, body, retry: false });
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const e = new Error(data?.error?.message || `Spotify returned ${res.status}`);
    e.status = res.status;
    e.reason = data?.error?.reason;
    if (res.status === 429) e.retryAfter = Number(res.headers.get('retry-after')) || 5;
    if (e.reason === 'PREMIUM_REQUIRED') e.message = 'Spotify Premium is required to control playback.';
    throw e;
  }
  return data;
}

function pickImage(images, min) {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find(i => (i.width ?? 0) >= min) ?? sorted[sorted.length - 1]).url;
}

function normalizeItem(item) {
  if (!item) return null;
  const images = item.album?.images ?? item.images ?? item.show?.images ?? [];
  return {
    id: item.id,
    uri: item.uri,
    name: item.name,
    artists: item.artists ? item.artists.map(a => a.name).join(', ') : (item.show?.name ?? ''),
    album: item.album?.name ?? item.show?.name ?? '',
    albumUri: item.album?.uri ?? null,
    image: pickImage(images, 64),
    imageLarge: pickImage(images, 600),
    durationMs: item.duration_ms ?? 0,
  };
}

function normalizePlaylist(p) {
  return {
    id: p.id,
    uri: p.uri,
    name: p.name,
    owner: p.owner?.display_name ?? '',
    total: p.tracks?.total ?? p.items?.total ?? null,
    image: pickImage(p.images, 300),
  };
}

async function getPlayback() {
  const p = await api('GET', '/me/player', { query: { additional_types: 'episode' } });
  if (!p) return { hasDevice: false, ts: Date.now() };
  return {
    hasDevice: true,
    ts: Date.now(),
    isPlaying: p.is_playing,
    progressMs: p.progress_ms ?? 0,
    shuffle: p.shuffle_state,
    repeat: p.repeat_state,
    device: p.device && {
      id: p.device.id,
      name: p.device.name,
      type: p.device.type,
      volume: p.device.volume_percent,
      supportsVolume: p.device.supports_volume !== false,
    },
    track: normalizeItem(p.item),
  };
}

async function listDevices() {
  return (await api('GET', '/me/player/devices'))?.devices ?? [];
}

// Retries a playback call against an available device when Spotify reports none active.
async function withDevice(fn) {
  try {
    return await fn(undefined);
  } catch (e) {
    if (e.status !== 404) throw e;
    const devices = await listDevices();
    const target = devices.find(d => d.is_active) ?? devices.find(d => d.type === 'Computer') ?? devices[0];
    if (!target) throw new Error('No Spotify device found. Open Spotify on your PC or phone first.');
    return fn(target.id);
  }
}

let skipping = false;
const clampVolume = v => Math.max(0, Math.min(100, Math.round(v)));

const commands = {
  play: (opts = {}) =>
    withDevice(device_id =>
      api('PUT', '/me/player/play', {
        query: { device_id },
        body: opts.contextUri
          ? { context_uri: opts.contextUri, ...(opts.offsetUri && { offset: { uri: opts.offsetUri } }) }
          : opts.uris
            ? { uris: opts.uris }
            : undefined,
      }),
    ),
  playLiked: async () => {
    const liked = await api('GET', '/me/tracks', { query: { limit: 50 } });
    const uris = (liked?.items ?? []).map(i => i.track?.uri).filter(Boolean);
    if (!uris.length) throw new Error('No liked songs found.');
    return commands.play({ uris });
  },
  pause: () => api('PUT', '/me/player/pause'),
  next: () => withDevice(device_id => api('POST', '/me/player/next', { query: { device_id } })),
  previous: () => withDevice(device_id => api('POST', '/me/player/previous', { query: { device_id } })),
  // The API can't jump to a queue item, so skip forward until it's playing, like clicking a
  // song in Spotify's own queue. The queue is re-read first in case the UI's copy is stale;
  // `index` picks between duplicates of the same song.
  skipTo: async (uri, index) => {
    if (skipping) return; // a second click mid-skip would overshoot
    skipping = true;
    try {
      const queue = (await api('GET', '/me/player/queue'))?.queue ?? [];
      const pos = queuePosition(queue, uri, index);
      if (pos < 0) throw new Error('That song is no longer in the queue.');
      for (let i = 0; i <= pos; i++) await commands.next();
    } finally {
      skipping = false;
    }
  },
  seek: ms => api('PUT', '/me/player/seek', { query: { position_ms: Math.max(0, Math.round(ms)) } }),
  volume: pct => api('PUT', '/me/player/volume', { query: { volume_percent: clampVolume(pct) } }),
  shuffle: on => api('PUT', '/me/player/shuffle', { query: { state: !!on } }),
  repeat: mode => api('PUT', '/me/player/repeat', { query: { state: ['off', 'context', 'track'].includes(mode) ? mode : 'off' } }),
  transfer: id => api('PUT', '/me/player', { body: { device_ids: [id], play: true } }),
};

const queries = {
  me: () => api('GET', '/me'),
  devices: async () =>
    (await listDevices()).map(d => ({ id: d.id, name: d.name, type: d.type, active: d.is_active, volume: d.volume_percent })),
  queue: async () => {
    const q = await api('GET', '/me/player/queue');
    return (q?.queue ?? []).slice(0, 8).map(normalizeItem);
  },
  playlists: async () => {
    const out = [];
    for (let offset = 0; ; offset += 50) {
      const page = await api('GET', '/me/playlists', { query: { limit: 50, offset } });
      out.push(...(page?.items ?? []).filter(Boolean).map(normalizePlaylist));
      if (!page?.next) return out;
    }
  },
  search: async q => {
    if (!q?.trim()) return { tracks: [], playlists: [] };
    const r = await api('GET', '/search', { query: { q, type: 'track,playlist', limit: 10 } });
    return {
      tracks: (r?.tracks?.items ?? []).filter(Boolean).map(normalizeItem),
      playlists: (r?.playlists?.items ?? []).filter(Boolean).map(normalizePlaylist),
    };
  },
};

function command(name, ...args) {
  if (!Object.hasOwn(commands, name)) throw new Error(`Unknown command: ${name}`);
  return commands[name](...args);
}

function query(name, ...args) {
  if (!Object.hasOwn(queries, name)) throw new Error(`Unknown query: ${name}`);
  return queries[name](...args);
}

module.exports = { REDIRECT_URI, events, init, isAuthed, login, logout, getPlayback, command, query };
