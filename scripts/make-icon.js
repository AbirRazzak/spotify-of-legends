// Renders assets/icon.png (gold hexagon with teal equalizer bars) without external deps.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const S = 256, SS = 4; // supersampling
const hex = r => Array.from({ length: 6 }, (_, i) => {
  const a = Math.PI / 180 * (60 * i - 90);
  return [128 + r * Math.cos(a), 128 + r * Math.sin(a)];
});
const inPoly = (x, y, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const outer = hex(122), goldIn = hex(108), ring = hex(100), ringIn = hex(97);
const bars = [60, 110, 80, 40].map((h, i) => ({ x: 128 - 61 + i * 32, w: 22, h: h + 20 }));

function sample(x, y) {
  const t = y / S;
  if (!inPoly(x, y, outer)) return null;
  if (!inPoly(x, y, goldIn)) return lerp([240, 230, 210], [120, 90, 40], t);
  if (inPoly(x, y, ring) && !inPoly(x, y, ringIn)) return [120, 90, 40];
  for (const b of bars) {
    if (x >= b.x && x < b.x + b.w && y >= 128 - b.h / 2 && y < 128 + b.h / 2) return lerp([205, 250, 250], [3, 151, 171], (y - 60) / 140);
  }
  return lerp([10, 50, 60], [1, 10, 19], t);
}

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const o = y * (S * 4 + 1) + 1 + x * 4;
    if (a) { raw[o] = r / a; raw[o + 1] = g / a; raw[o + 2] = b / a; }
    raw[o + 3] = Math.round(255 * a / (SS * SS));
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), png);
