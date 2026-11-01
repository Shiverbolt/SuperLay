'use strict';
const { nativeImage } = require('electron');

// Procedural app icon: rounded violet tile with three rising bars. Avoids shipping binary assets.
// Returns premultiplied BGRA (what nativeImage.createFromBitmap expects).
function drawIcon(size = 32) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.24;
  const bars = [[0.22, 0.42, 0.62], [0.42, 0.62, 0.42], [0.62, 0.82, 0.22]]; // [x0, x1, top] in unit space
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      // signed distance to the rounded square, for anti-aliased edges
      const qx = Math.abs(x + 0.5 - size / 2) - (size / 2 - r);
      const qy = Math.abs(y + 0.5 - size / 2) - (size / 2 - r);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const a = Math.min(1, Math.max(0, 0.5 - d));
      if (a <= 0) continue;
      let R = 120 + 60 * u, G = 92 + 30 * v, B = 255 - 40 * v;
      for (const [x0, x1, top] of bars) {
        if (u >= x0 && u < x1 - 0.04 && v >= top && v <= 0.8) { R = 255; G = 255; B = 255; }
      }
      const o = (y * size + x) * 4;
      buf[o] = B * a; buf[o + 1] = G * a; buf[o + 2] = R * a; buf[o + 3] = 255 * a;
    }
  }
  return buf;
}

function makeIcon(size = 32) {
  return nativeImage.createFromBitmap(drawIcon(size), { width: size, height: size });
}

module.exports = { makeIcon, drawIcon };
