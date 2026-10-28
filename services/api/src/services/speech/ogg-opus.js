import OpusScript from 'opusscript';

// Ogg Opus written in-process (libopus compiled to WebAssembly): the only audio format WhatsApp plays as a voice note.
const CRC_TABLE = new Uint32Array(256).map((_, i) => {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});

function crc32(buf) {
  let crc = 0;
  for (const b of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}

// One Ogg page; every packet here is far below 255 * 255 bytes, so lacing is simple.
function page({ packets, granule, serial, sequence, flags }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const head = Buffer.alloc(27 + lacing.length);
  head.write('OggS', 0, 'ascii');
  head[4] = 0;
  head[5] = flags;
  head.writeBigInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(serial, 14);
  head.writeUInt32LE(sequence, 18);
  head[26] = lacing.length;
  Buffer.from(lacing).copy(head, 27);
  const out = Buffer.concat([head, ...packets]);
  out.writeUInt32LE(crc32(out), 22);
  return out;
}

const PRE_SKIP = 312; // libopus encoder delay, in 48 kHz samples

// 16-bit mono PCM at 16 kHz in, an Ogg Opus voice note out.
export function encodeOggOpus(pcm16, { sampleRate = 16000, bitrate = 24000, serial = (Math.random() * 0xffffffff) >>> 0 } = {}) {
  const encoder = new OpusScript(sampleRate, 1, OpusScript.Application.VOIP);
  try {
    encoder.setBitrate(bitrate);
    const frame = sampleRate / 50; // 20 ms
    const scale = 48000 / sampleRate;
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'ascii');
    head[8] = 1; head[9] = 1;
    head.writeUInt16LE(PRE_SKIP, 10);
    head.writeUInt32LE(sampleRate, 12);
    head.writeInt16LE(0, 16);
    head[18] = 0;
    const vendor = Buffer.from('MoranBuy');
    const tags = Buffer.concat([Buffer.from('OpusTags'), Buffer.from(Uint32Array.of(vendor.length).buffer), vendor, Buffer.alloc(4)]);
    const pages = [page({ packets: [head], granule: 0, serial, sequence: 0, flags: 0x02 }), page({ packets: [tags], granule: 0, serial, sequence: 1, flags: 0 })];
    const total = pcm16.length;
    let sequence = 2, batch = [], frames = 0;
    for (let at = 0; at < total; at += frame) {
      const chunk = new Int16Array(frame);
      chunk.set(pcm16.subarray(at, Math.min(at + frame, total)));
      batch.push(Buffer.from(encoder.encode(Buffer.from(chunk.buffer), frame)));
      frames++;
      const last = at + frame >= total;
      if (batch.length === 50 || last) {
        const granule = last ? PRE_SKIP + Math.round(total * scale) : PRE_SKIP + frames * frame * scale;
        pages.push(page({ packets: batch, granule, serial, sequence: sequence++, flags: last ? 0x04 : 0 }));
        batch = [];
      }
    }
    return Buffer.concat(pages);
  } finally {
    encoder.delete();
  }
}
