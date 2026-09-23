// Генерирует PNG-иконки без внешних зависимостей: фон + три «полосы тумана».
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function encode(size, px) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Геометрия в координатах 512×512; всё лежит в «безопасной зоне» maskable-иконки.
const TOP = [0x3d, 0x4e, 0x5b];
const BOTTOM = [0x1f, 0x2a, 0x33];
const MIST = [0xe6, 0xed, 0xf1];
const BANDS = [
  { y: 200, x0: 150, x1: 370, r: 22, a: 0.95 },
  { y: 262, x0: 112, x1: 330, r: 22, a: 0.72 },
  { y: 324, x0: 182, x1: 400, r: 22, a: 0.48 },
];

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 512;
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    for (let x = 0; x < size; x++) {
      let col = TOP.map((v, i) => v + (BOTTOM[i] - v) * t);
      const X = (x + 0.5) / s;
      const Y = (y + 0.5) / s;
      for (const b of BANDS) {
        const dx = Math.max(b.x0 - X, 0, X - b.x1);
        const dy = Y - b.y;
        const d = Math.hypot(dx, dy) - b.r;
        const core = Math.min(Math.max(0.5 - d * s, 0), 1);
        const glow = Math.exp(-Math.max(d, 0) / 16) * 0.22;
        const al = Math.min(1, Math.max(core, glow)) * b.a;
        col = col.map((v, i) => v * (1 - al) + MIST[i] * al);
      }
      const o = (y * size + x) * 4;
      px[o] = Math.round(col[0]);
      px[o + 1] = Math.round(col[1]);
      px[o + 2] = Math.round(col[2]);
      px[o + 3] = 255;
    }
  }
  return encode(size, px);
}

const out = new URL('../public/icons/', import.meta.url);
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(new URL(name, out), draw(size));
  console.log('wrote', name);
}

const svgBands = BANDS.map(
  (b) => `<rect x="${b.x0 - b.r}" y="${b.y - b.r}" width="${b.x1 - b.x0 + 2 * b.r}" height="${2 * b.r}" rx="${b.r}" fill="#e6edf1" fill-opacity="${b.a}"/>`,
).join('');
writeFileSync(
  new URL('icon.svg', out),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d4e5b"/><stop offset="1" stop-color="#1f2a33"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/>${svgBands}</svg>\n`,
);
console.log('wrote icon.svg');
