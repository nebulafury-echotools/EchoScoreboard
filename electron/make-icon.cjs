// Generates icon.png (32x32, tray) and icon.ico (256x256 PNG-in-ICO): a cyan ring. No deps.
const zlib = require('node:zlib'), fs = require('node:fs'), path = require('node:path');
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(n) {
  const raw = Buffer.alloc((n * 4 + 1) * n), c = (n - 1) / 2;
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0;
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - c, y - c), r = n * 0.38, w = n * 0.09;
      const a = Math.max(0, Math.min(1, w - Math.abs(d - r) + 0.5));
      const o = y * (n * 4 + 1) + 1 + x * 4;
      raw[o] = 0; raw[o + 1] = 229; raw[o + 2] = 255; raw[o + 3] = Math.round(a * 255);
    }
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(n, 0); ih.writeUInt32BE(n, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
fs.writeFileSync(path.join(__dirname, 'icon.png'), png(32));
const big = png(256), hdr = Buffer.alloc(22);
hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(1, 4); hdr[6] = 0; hdr[7] = 0; hdr.writeUInt16LE(1, 10); hdr.writeUInt16LE(32, 12);
hdr.writeUInt32LE(big.length, 14); hdr.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([hdr, big]));
