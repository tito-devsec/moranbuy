import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

// Decodes a JPEG or PNG into raw RGBA pixels; WebP and anything else are left whole.
export function decodeImage(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) { const d = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 }); return { width: d.width, height: d.height, data: d.data }; }
  if (buf.subarray(1, 4).toString('ascii') === 'PNG') { const p = PNG.sync.read(buf); return { width: p.width, height: p.height, data: p.data }; }
  return null;
}

// Cuts one product out of a photo along the box SAM found, with a little margin, as a JPEG for the product's listing.
export function cropToJpeg(image, box, { margin = 0.06, quality = 85 } = {}) {
  const sx = image.width / (box.width || image.width);
  const sy = image.height / (box.height || image.height);
  const bw = (box.x2 - box.x1 + 1) * sx; const bh = (box.y2 - box.y1 + 1) * sy;
  const x1 = Math.max(0, Math.floor(box.x1 * sx - bw * margin));
  const y1 = Math.max(0, Math.floor(box.y1 * sy - bh * margin));
  const x2 = Math.min(image.width - 1, Math.ceil(box.x2 * sx + bw * margin));
  const y2 = Math.min(image.height - 1, Math.ceil(box.y2 * sy + bh * margin));
  const w = x2 - x1 + 1; const h = y2 - y1 + 1;
  if (w < 16 || h < 16) return null;
  const out = Buffer.alloc(w * h * 4);
  const src = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  for (let y = 0; y < h; y += 1) {
    const start = ((y1 + y) * image.width + x1) * 4;
    src.copy(out, y * w * 4, start, start + w * 4);
  }
  return jpeg.encode({ width: w, height: h, data: out }, quality).data;
}

// A 64-bit difference hash of a photo: near-identical pictures (a re-sent delivery photo, the catalogue picture) differ in only a few bits.
export function fingerprint(buf) {
  const image = Buffer.isBuffer(buf) ? decodeImage(buf) : buf;
  if (!image) return null;
  const gray = (x, y) => {
    const sx = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / 9));
    const sy = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / 8));
    const i = (sy * image.width + sx) * 4;
    return image.data[i] * 0.299 + image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114;
  };
  let bits = 0n;
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) bits = (bits << 1n) | (gray(x, y) > gray(x + 1, y) ? 1n : 0n);
  return bits.toString(16).padStart(16, '0');
}

export function fingerprintDistance(a, b) {
  if (!a || !b) return 64;
  let v = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (v) { n += Number(v & 1n); v >>= 1n; }
  return n;
}
