const test = require('node:test');
const assert = require('node:assert');
const { shouldShowOverlay, queuePosition } = require('../src/rules');

const settings = {
  overlayEnabled: true,
  overlayOnlyInGame: true,
  overlayMode: 'auto',
  overlayShowPeek: true,
  overlayShowDead: true,
  overlayShowTab: true,
};
// In a match, locked, "Only when…" mode, and nothing currently asking for it.
const base = { authed: true, settings, locked: true, inGame: true, hover: false, peeking: false, dead: false, tabHeld: false };
const show = (over = {}, s = {}) => shouldShowOverlay({ ...base, ...over, settings: { ...settings, ...s } });

test('overlay: hidden or shown by the basics', () => {
  assert.equal(show({ authed: false, tabHeld: true }), false, 'not linked to Spotify');
  assert.equal(show({ tabHeld: true }, { overlayEnabled: false }), false, 'overlay turned off');
  assert.equal(show({ inGame: false }, { overlayMode: 'always' }), false, 'only-in-game, no match');
  assert.equal(show({ inGame: false }, { overlayMode: 'always', overlayOnlyInGame: false }), true, 'always, outside a match');
  assert.equal(show({ locked: false, inGame: false }), true, 'unlocked for positioning');
});

test('overlay: "Only when…" mode shows only for a chosen reason', () => {
  assert.equal(show(), false, 'nothing going on');
  assert.equal(show({ tabHeld: true }), true, 'holding Tab');
  assert.equal(show({ dead: true }), true, 'dead');
  assert.equal(show({ peeking: true }), true, 'song-change pop-up');
  assert.equal(show({ tabHeld: true }, { overlayShowTab: false }), false, 'Tab option off');
  assert.equal(show({ dead: true }, { overlayShowDead: false }), false, 'death option off');
  assert.equal(show({ peeking: true }, { overlayShowPeek: false }), false, 'pop-up option off');
});

test('overlay: hovering keeps it up, and leaving lets it hide', () => {
  assert.equal(show({ hover: true }, { overlayShowPeek: false }), true, 'cursor on the controls after Tab released');
  // The audit's stuck-overlay case: cursor left, Tab released, pop-ups off.
  assert.equal(show({ hover: false }, { overlayShowPeek: false }), false, 'cursor left the controls');
});

test('queuePosition: finds the clicked song', () => {
  const q = ['A', 'B', 'C', 'B'].map(uri => ({ uri }));
  assert.equal(queuePosition(q, 'B', 1), 1, 'still at the clicked spot');
  assert.equal(queuePosition(q, 'B', 3), 3, 'the clicked duplicate, not the first');
  assert.equal(queuePosition(q, 'C', 5), 2, 'list on screen was stale');
  assert.equal(queuePosition(q, 'Z', 0), -1, 'song left the queue');
  assert.equal(queuePosition([], 'A', 0), -1, 'empty queue');
});
