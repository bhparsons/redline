// extension/icons/generate.mjs — render the Redline extension icons (#97).
//
// The mark: the three-line redline (short / bold strike / short) knocked out of
// a solid red tile. Picked from six candidates in design/mock-icon-variants.html
// — a solid tile is the only one of the six that renders identically on a light
// and a dark Chrome toolbar; every line-drawing variant leans on at least one
// stroke whose contrast flips with the toolbar color.
//
// Shapes are signed-distance functions in normalized 0..1 space, rendered with
// 4x4 supersampling. The earlier version snapped hard rectangles to the pixel
// grid with no antialiasing, which is most of why the 16px icon read as mush: a
// 1px line at 16px is either fully present or fully gone, and rounded corners
// stair-step. Coverage sampling fixes both, and normalized geometry means 16 and
// 128 are the same drawing rather than two hand-tuned ones.
//
// stdlib-only PNG writer (zlib deflate + CRC32 chunks). No dependencies.
// Run: `node extension/icons/generate.mjs`

import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- shapes: signed distance in normalized 0..1 space --------------------------
// Negative inside, positive outside, same units as x/y.

// Rounded rect.
function rrect(x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r; const hy = (y1 - y0) / 2 - r;
  return (x, y) => {
    const qx = Math.abs(x - cx) - hx;
    const qy = Math.abs(y - cy) - hy;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
}

// Capsule: a stroke of width w from (x0,y0) to (x1,y1), round caps.
function seg(x0, y0, x1, y1, w) {
  const dx = x1 - x0; const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  return (x, y) => {
    let t = ((x - x0) * dx + (y - y0) * dy) / len2;
    t = Math.min(Math.max(t, 0), 1);
    return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)) - w / 2;
  };
}

const RED   = [224,  67,  58];
const WHITE = [255, 255, 255];

// The mark, painted back to front. Three horizontals and nothing else — an
// added diagonal turns the knockout into a legible "Z", and at 16px the eye
// resolves letterforms before it resolves intent.
const SHAPES = [
  [rrect(0.08, 0.08, 0.92, 0.92, 0.24), RED],
  [seg(0.26, 0.32, 0.62, 0.32, 0.085), WHITE],
  [seg(0.22, 0.50, 0.78, 0.50, 0.135), WHITE],
  [seg(0.26, 0.68, 0.56, 0.68, 0.085), WHITE],
];

const SS = 4; // supersample factor per axis

function icon(s) {
  const buf = Buffer.alloc(s * s * 4); // transparent
  for (let py = 0; py < s; py += 1) {
    for (let px = 0; px < s; px += 1) {
      let ar = 0; let ag = 0; let ab = 0; let aa = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / s;
          const y = (py + (sy + 0.5) / SS) / s;
          let hit = null;
          for (const [sdf, color] of SHAPES) if (sdf(x, y) <= 0) hit = color;
          if (!hit) continue;
          ar += hit[0]; ag += hit[1]; ab += hit[2]; aa += 1;
        }
      }
      if (!aa) continue;
      const i = (py * s + px) * 4;
      buf[i] = Math.round(ar / aa);
      buf[i + 1] = Math.round(ag / aa);
      buf[i + 2] = Math.round(ab / aa);
      buf[i + 3] = Math.round((aa / (SS * SS)) * 255);
    }
  }
  return encodePng(s, s, buf);
}

for (const s of [16, 32, 48, 128]) {
  writeFileSync(path.join(HERE, `icon-${s}.png`), icon(s));
}
console.log('wrote icon-16.png icon-32.png icon-48.png icon-128.png');
