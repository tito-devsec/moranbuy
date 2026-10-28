import { OggOpusDecoder } from 'ogg-opus-decoder';

const TARGET_RATE = 16000;

// What kind of audio the bytes are: a WhatsApp voice note (Ogg Opus) or a WAV a browser recorded; anything else is not read.
export function audioKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
  return null;
}

// Mixes channels to mono and resamples to 16 kHz by linear interpolation, which is plenty for speech.
function toMono16k(channels, rate) {
  const len = channels[0].length;
  const mono = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i += 1) mono[i] += ch[i] / channels.length;
  if (rate === TARGET_RATE) return mono;
  const outLen = Math.floor((len * TARGET_RATE) / rate);
  const out = new Float32Array(outLen);
  const step = rate / TARGET_RATE;
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * step;
    const j = Math.floor(pos);
    const frac = pos - j;
    out[i] = (mono[j] ?? 0) * (1 - frac) + (mono[j + 1] ?? mono[j] ?? 0) * frac;
  }
  return out;
}

// Writes 16-bit PCM mono samples as a WAV file, the format both Meta speech paths accept.
export function encodeWav(samples, rate = TARGET_RATE) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// Reads a PCM WAV (8, 16 or 32-bit integer, or 32-bit float) into channel arrays.
function readWav(buf) {
  let off = 12; let fmt = null; let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.subarray(off, off + 4).toString('ascii');
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV without format or data');
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < fmt.channels; c += 1) {
      const p = (i * fmt.channels + c) * bytes;
      let v;
      if (fmt.format === 3 && fmt.bits === 32) v = data.readFloatLE(p);
      else if (fmt.bits === 16) v = data.readInt16LE(p) / 32768;
      else if (fmt.bits === 32) v = data.readInt32LE(p) / 2147483648;
      else if (fmt.bits === 8) v = (data.readUInt8(p) - 128) / 128;
      else throw new Error(`Unsupported WAV sample size ${fmt.bits}`);
      channels[c][i] = v;
    }
  }
  return { channels, rate: fmt.rate };
}

// Any supported voice recording to 16 kHz mono WAV, inside this process; nothing is installed on or run by the server for it.
export async function toSpeechWav(buf, { maxSeconds = 600 } = {}) {
  const kind = audioKind(buf);
  if (!kind) return { ok: false, reason: 'unsupported_audio' };
  let channels; let rate;
  if (kind === 'ogg') {
    const decoder = new OggOpusDecoder();
    await decoder.ready;
    try {
      const r = await decoder.decodeFile(new Uint8Array(buf));
      channels = r.channelData; rate = r.sampleRate;
    } finally { decoder.free(); }
  } else ({ channels, rate } = readWav(buf));
  if (!channels?.length || !channels[0].length) return { ok: false, reason: 'empty_audio' };
  const seconds = channels[0].length / rate;
  if (seconds > maxSeconds) return { ok: false, reason: 'too_long', seconds };
  return { ok: true, wav: encodeWav(toMono16k(channels, rate)), seconds: Math.round(seconds * 10) / 10, from: kind };
}
