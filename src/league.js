// Detects whether a League of Legends game is running, and whether your champion is
// dead, by polling Riot's official Live Client Data API. The game serves it on
// https://127.0.0.1:2999 only while a match is in progress. Read-only and local;
// no game memory is touched.
const https = require('https');
const { EventEmitter } = require('events');

// The game uses a self-signed Riot certificate; this agent is only used for localhost.
const agent = new https.Agent({ rejectUnauthorized: false });
const events = new EventEmitter();
let inGame = false;
let dead = false;
let watchingDeath = false;
let activePlayer = null;
let timer = null;
let deathTimer = null;

function get(path) {
  return new Promise(resolve => {
    const req = https.get({ host: '127.0.0.1', port: 2999, path, agent, timeout: 1500 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function setDead(now) {
  if (now !== dead) {
    dead = now;
    events.emit('dead', dead);
  }
}

async function tick() {
  const now = (await get('/liveclientdata/gamestats')) !== null;
  if (now !== inGame) {
    inGame = now;
    activePlayer = null;
    if (!inGame) setDead(false);
    events.emit('change', inGame);
    syncDeathWatch();
  }
  timer = setTimeout(tick, inGame ? 5000 : 3000);
}

const matches = (p, name) =>
  p.riotId === name || p.summonerName === name || `${p.riotIdGameName}#${p.riotIdTagLine}` === name;

// Each start of the death watch gets a new run number; a check still waiting on League
// from an earlier run stops when it sees the number changed, so loops can't pile up.
let deathRun = 0;

async function deathTick(run) {
  activePlayer ??= await get('/liveclientdata/activeplayername');
  const players = activePlayer ? await get('/liveclientdata/playerlist') : null;
  if (run !== deathRun) return;
  const me = Array.isArray(players) ? players.find(p => matches(p, activePlayer)) : null;
  setDead(!!me?.isDead);
  deathTimer = setTimeout(() => deathTick(run), 1000);
}

function syncDeathWatch() {
  const on = watchingDeath && inGame;
  if (on && !deathTimer) {
    const run = ++deathRun;
    deathTimer = setTimeout(() => deathTick(run), 0);
  } else if (!on && deathTimer) {
    deathRun++;
    clearTimeout(deathTimer);
    deathTimer = null;
    setDead(false);
  }
}

function watchDeath(on) {
  watchingDeath = on;
  syncDeathWatch();
}

function start() {
  if (!timer) tick();
}

module.exports = { start, events, watchDeath, inGame: () => inGame, isDead: () => dead };
