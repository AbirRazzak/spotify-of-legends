// Watches whether a key is held by polling GetAsyncKeyState. Unlike a global shortcut
// or keyboard hook, this only reads the key's state: the key still reaches League
// (so Tab still opens the scoreboard) and no input passes through this app.
const { EventEmitter } = require('events');

const VK_TAB = 0x09;
const events = new EventEmitter();
let getKeyState = null;
let timer = null;
let held = false;

try {
  const koffi = require('koffi');
  getKeyState = koffi.load('user32.dll').func('short __stdcall GetAsyncKeyState(int vKey)');
} catch (e) {
  console.warn('Key watching unavailable:', e.message);
}

function tick() {
  const now = (getKeyState(VK_TAB) & 0x8000) !== 0;
  if (now !== held) {
    held = now;
    events.emit('tab', held);
  }
}

function watchTab(on) {
  if (on && getKeyState && !timer) {
    timer = setInterval(tick, 33);
  } else if (!on && timer) {
    clearInterval(timer);
    timer = null;
    if (held) {
      held = false;
      events.emit('tab', false);
    }
  }
}

// Physical left mouse button state, read the same way. Used to drag the overlay's volume
// bar, whose button-press events Windows drops while League is the active window.
const mouseDown = () => !!getKeyState && (getKeyState(0x01) & 0x8000) !== 0;

module.exports = { events, watchTab, mouseDown, tabHeld: () => held, available: () => !!getKeyState };
