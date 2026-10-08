// Turns the macOS window screenshots in shots/ (⇧⌘4, space: the window on a
// transparent drop shadow) into the website's screenshots in public/shots/:
// finds the opaque window inside the shadow and crops to it, keeping the
// rounded corners' transparency and the colour profile. Plain Node, no
// dependencies, so deploy.sh runs it on CI. usage: node website/shots.mjs
// Prints each one's size; the <img> tags in index.php expect 1500×900.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const dir = dirname(fileURLToPath(import.meta.url));
const src = join(dir, "shots");
const out = join(dir, "public/shots");
const OPAQUE = 250; // alpha at or above this is the window; the shadow never gets there
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const KEEP = ["iCCP", "sRGB", "gAMA", "cHRM", "pHYs"]; // colour and scale chunks carried over

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// 8-bit RGB/RGBA non-interlaced PNG (what macOS writes) → RGBA pixels.
function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let ihdr, pos = 8;
  const idat = [], keep = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === "IDAT") idat.push(data);
    else if (KEEP.includes(type)) keep.push({ type, data });
    pos += 12 + len;
  }
  if (!ihdr || ihdr.depth !== 8 || ![2, 6].includes(ihdr.color) || ihdr.interlace) throw new Error("expected an 8-bit RGB or RGBA non-interlaced PNG");
  const { width, height } = ihdr;
  const bpp = ihdr.color === 6 ? 4 : 3, stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      row[i] += filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * bpp;
      px[o] = row[s]; px[o + 1] = row[s + 1]; px[o + 2] = row[s + 2]; px[o + 3] = bpp === 4 ? row[s + 3] : 255;
    }
    prev = row;
  }
  return { width, height, px, keep };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(4), tail = Buffer.alloc(4), t = Buffer.from(type, "latin1");
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([head, t, data, tail]);
};

// RGBA pixels → PNG, each row with whichever filter leaves the least to compress.
function encode({ width, height, px, keep }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride);
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0;
        const v = (row[i] - (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0)) & 255;
        candidate[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        raw[y * (stride + 1)] = f;
        candidate.copy(raw, y * (stride + 1) + 1);
      }
    }
    prev = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    ...keep.map((k) => chunk(k.type, k.data)),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Bounding box of the opaque pixels: the window's straight edges reach it,
// its rounded corners and the shadow don't.
function windowBox({ width, height, px }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (px[(y * width + x) * 4 + 3] >= OPAQUE) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function crop(img, box) {
  const px = Buffer.alloc(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    const from = ((box.y + y) * img.width + box.x) * 4;
    img.px.copy(px, y * box.width * 4, from, from + box.width * 4);
  }
  return { ...img, ...box, px };
}

mkdirSync(out, { recursive: true });
const files = readdirSync(src).filter((f) => f.endsWith(".png")).sort();
if (files.length === 0) {
  console.error(`no screenshots in ${src}`);
  process.exit(1);
}
for (const file of files) {
  const img = decode(readFileSync(join(src, file)));
  const box = windowBox(img);
  if (!box) {
    console.error(`${file}: no opaque pixels, nothing to crop to`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(join(out, file), encode(crop(img, box)));
  console.log(`${file} ${box.width}×${box.height} (from ${img.width}×${img.height}, offset ${box.x},${box.y})`);
}
