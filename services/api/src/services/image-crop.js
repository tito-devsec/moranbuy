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
