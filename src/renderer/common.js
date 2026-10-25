const $ = (sel, root = document) => root.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Interpolates playback position between polls so progress moves smoothly.
function progressAt(p, now = Date.now()) {
  if (!p?.track) return 0;
  const ms = p.progressMs + (p.isPlaying ? now - p.ts : 0);
  return Math.min(Math.max(ms, 0), p.track.durationMs || 0);
}

function cleanError(e) {
  return String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Text that doesn't fit scrolls back and forth: rest, glide to the end, pause, glide back,
// then a longer rest before repeating. Stepped by a ~30 fps timer rather than a CSS
// animation, which would repaint at the monitor's full refresh rate (costly over the game).
const MARQUEE_SPEED = 30; // px per second
const MARQUEE_FRAME = 33; // ms
const marquees = new Map();

function setMarqueeText(el, text) {
  let m = marquees.get(el);
  if (!m) {
    el.classList.add('marquee');
    el.textContent = '';
    m = { el, span: el.appendChild(document.createElement('span')), text: null, timer: null };
    marquees.set(el, m);
    // Restart when the box or text width changes (window resize, web font finishing loading).
    const ro = new ResizeObserver(() => restartMarquee(el));
    ro.observe(el);
    ro.observe(m.span);
  }
  if (m.text === text) return;
  m.text = text;
  m.span.textContent = text;
  restartMarquee(el);
}

function restartMarquee(el) {
  const m = marquees.get(el);
  if (!m) return;
  clearTimeout(m.timer);
  m.span.style.transform = '';
  const dist = m.span.scrollWidth - el.clientWidth;
  el.classList.toggle('scrolling', dist > 2);
  if (dist <= 2) return;

  const glide = (dist / MARQUEE_SPEED) * 1000;
  const legs = [
    [0, 0, 2000],
    [0, dist, glide],
    [dist, dist, 1500],
    [dist, 0, glide],
    [0, 0, 4000],
  ]; // [from px, to px, duration ms]
  let leg = 0;
  let start = performance.now();
  const step = () => {
    const [from, to, ms] = legs[leg];
    const p = Math.min(1, (performance.now() - start) / ms);
    const pos = from + (to - from) * p;
    m.span.style.transform = `translateX(${-pos.toFixed(1)}px)`;
    // Fade an edge only where text is hidden past it, so the first and last
    // letters are fully visible when scrolled to either end.
    el.style.setProperty('--fade-l', `${Math.min(pos, 8).toFixed(1)}px`);
    el.style.setProperty('--fade-r', `${Math.min(dist - pos, 16).toFixed(1)}px`);
    if (p >= 1) {
      leg = (leg + 1) % legs.length;
      start = performance.now();
      m.timer = setTimeout(step, 0);
    } else {
      // Rests need no frames; only the glides tick.
      m.timer = setTimeout(step, from === to ? ms * (1 - p) : MARQUEE_FRAME);
    }
  };
  step();
}

function setRangeFill(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--pct', `${pct}%`);
}
