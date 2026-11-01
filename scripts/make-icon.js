'use strict';
// Writes build/icon.png (256×256) from the procedural app icon; electron-builder turns it into the .ico.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { drawIcon } = require('../src/main/icon');

const SIZE = 256;
const bgra = drawIcon(SIZE);

// PNG wants straight (non-premultiplied) RGBA rows, each prefixed with a filter byte.
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4, o = y * (SIZE * 4 + 1) + 1 + x * 4;
    const a = bgra[i + 3], un = a ? 255 / a : 0;
    raw[o] = Math.min(255, Math.round(bgra[i + 2] * un));
    raw[o + 1] = Math.min(255, Math.round(bgra[i + 1] * un));
    raw[o + 2] = Math.min(255, Math.round(bgra[i] * un));
    raw[o + 3] = a;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out}`);
