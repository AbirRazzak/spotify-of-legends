const S = { settings: {}, auth: {}, playback: {}, overlay: { locked: true } };
let currentTrackUri;
let lastVolume = null;
let pipTimer;
let volumeHeldUntil = 0;
let wasVisible = false;

const hud = $('#hud');
const root = $('#root');

function render() {
  const p = S.playback;
  const t = p.track;
  hud.classList.toggle('empty', !t);
  hud.classList.toggle('paused', !!t && !p.isPlaying);
  root.classList.toggle('unlocked', S.overlay.locked === false);
  root.classList.toggle('controls-on', S.settings.overlayControls !== false);
  root.classList.toggle('clickable', S.overlay.locked !== false && !!S.overlay.interactive);
  hud.style.opacity = S.settings.overlayOpacity ?? 1;

  setMarqueeText($('#title'), t?.name ?? 'Spotify');
  // Start a long title from its beginning each time the overlay pops up.
  if (S.overlay.visible && !wasVisible) restartMarquee($('#title'));
  wasVisible = !!S.overlay.visible;
  $('#artist').textContent = t?.artists ?? (p.hasDevice ? 'Nothing playing' : 'No active device');
  $('#device').textContent = p.device?.name ?? '';
  $('#badge').innerHTML = ICONS[p.isPlaying ? 'note' : 'pause'];
  $('#btnPlay').innerHTML = ICONS[p.isPlaying ? 'pause' : 'play'];

  if (t?.uri !== currentTrackUri) {
    const first = currentTrackUri === undefined;
    currentTrackUri = t?.uri;
    $('#art').src = t?.image ? (t.imageLarge ?? t.image) : '';
    if (t && !first) {
      hud.classList.remove('flash');
      void hud.offsetWidth; // restart the animation
      hud.classList.add('flash');
    }
  }

  tick();

  const vol = p.device?.volume;
  if (vol != null) {
    if (lastVolume != null && vol !== lastVolume) showVolumePip(vol);
    lastVolume = vol;
    const input = $('#volume');
    if (Date.now() > volumeHeldUntil) {
      input.value = vol;
      setRangeFill(input);
    }
  }
}

function showVolumePip(vol) {
  $('#pipFill').style.width = `${vol}%`;
  $('#pipVal').textContent = vol;
  $('#volPip').classList.add('show');
  clearTimeout(pipTimer);
  pipTimer = setTimeout(() => $('#volPip').classList.remove('show'), 1500);
}

// The overlay sits on top of the game, and every repaint costs the game frames,
// so progress updates once per second (on the second boundary) and not at all while paused.
let tickTimer;
function tick() {
  clearTimeout(tickTimer);
  const p = S.playback;
  const dur = p.track?.durationMs || 0;
  const ms = progressAt(p);
  $('#ringFill').style.strokeDashoffset = (100 - (dur ? (ms / dur) * 100 : 0)).toFixed(1);
  $('#time').textContent = `${fmtTime(ms)} / ${fmtTime(dur)}`;
  if (p.isPlaying && dur) tickTimer = setTimeout(tick, 1005 - (ms % 1000));
}

// Tell the main process how big the widget is so the window hugs it, and where the
// controls row is so it knows when the cursor is over them.
const rectOf = sel => {
  const r = $(sel).getBoundingClientRect();
  return r.width ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
};
const reportSize = () => {
  const r = root.getBoundingClientRect();
  sol.reportOverlaySize({ w: Math.ceil(r.width), h: Math.ceil(r.height), controls: rectOf('.controls'), volume: rectOf('#volume') });
};
new ResizeObserver(reportSize).observe(root);

const actions = {
  btnPlay: () => sol.command(S.playback.isPlaying ? 'pause' : 'play'),
  btnNext: () => sol.command('next'),
  btnPrev: () => sol.command('previous'),
  btnLock: () => sol.lockOverlay(true),
};
for (const [id, fn] of Object.entries(actions)) $(`#${id}`).onclick = fn;

const sendVolume = debounce(v => sol.command('volume', v), 200);
function setVolume(input) {
  volumeHeldUntil = Date.now() + 2500;
  setRangeFill(input);
  lastVolume = Number(input.value);
  sendVolume(lastVolume);
}
$('#volume').addEventListener('input', e => setVolume(e.target));

// While locked, the main process makes the window clickable only while the cursor is
// over the controls. Keep it clickable until a volume drag that left the row is released.
const controls = $('.controls');
let sawPress = false;
controls.addEventListener('pointerdown', () => {
  sawPress = true;
  sol.setOverlayPressing(true);
});
window.addEventListener('pointerup', e => {
  // The overlay never takes focus. While another app (League) is active, Windows drops
  // the press half of a click on it and only the release arrives, so a release with no
  // press counts as a button click. (The volume bar is dragged by the main process.)
  if (!sawPress) {
    const button = document.elementFromPoint(e.clientX, e.clientY)?.closest('.ctl');
    if (button && actions[button.id]) actions[button.id]();
  }
  sawPress = false;
  sol.setOverlayPressing(false);
});

sol.on('overlay-volume', v => {
  const input = $('#volume');
  input.value = v;
  lastVolume = v;
  volumeHeldUntil = Date.now() + 2500;
  setRangeFill(input);
});

for (const ch of ['playback', 'settings', 'auth', 'overlay']) {
  sol.on(ch, v => {
    S[ch] = v;
    render();
  });
}

(async function init() {
  fillIcons();
  Object.assign(S, await sol.init());
  render();
})();
