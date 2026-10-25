// Pure decision rules, kept free of Electron so plain Node can test them (see test/).

// Whether the overlay window should be on screen. `peeking` means a brief pop-up is active.
function shouldShowOverlay({ authed, settings: s, locked, inGame, hover, peeking, dead, tabHeld }) {
  if (!authed || !s.overlayEnabled) return false;
  if (!locked) return true; // unlocked for positioning
  if (s.overlayOnlyInGame && !inGame) return false;
  // "Only when…" mode keeps it hidden (any window over the game costs FPS) except at
  // the moments the user picked; hovering its controls keeps it up while clicking.
  if (s.overlayMode !== 'auto' || hover) return true;
  return (s.overlayShowPeek && peeking) || (s.overlayShowDead && dead) || (s.overlayShowTab && tabHeld);
}

// Where a clicked queue song is now: at the clicked index if it's still there (this tells
// duplicates apart), otherwise its first position, or -1 if it has left the queue.
function queuePosition(queue, uri, index) {
  return queue[index]?.uri === uri ? index : queue.findIndex(t => t?.uri === uri);
}

module.exports = { shouldShowOverlay, queuePosition };
