// Persistent user settings, stored as JSON in the app's userData folder.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  clientId: '',
  overlayEnabled: true,
  overlayOnlyInGame: true,
  overlayControls: true,
  overlayMode: 'always',
  overlayShowDead: true,
  overlayShowTab: true,
  overlayShowPeek: true,
  hardwareAcceleration: false,
  overlayOpacity: 0.95,
  overlayScale: 1,
  overlayPos: null,
};

let file;
let data = { ...DEFAULTS };

function init() {
  file = path.join(app.getPath('userData'), 'settings.json');
  try {
    data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    data = { ...DEFAULTS };
  }
  if (data.overlayMode === 'peek') data.overlayMode = 'auto'; // renamed setting value
}

function get() {
  return { ...data };
}

function set(partial) {
  data = { ...data, ...partial };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write then rename, so a crash mid-write can't leave half-written settings behind.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return get();
}

module.exports = { init, get, set };
