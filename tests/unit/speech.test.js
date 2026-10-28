import test from 'node:test';
import assert from 'node:assert/strict';
import { OggOpusDecoder } from 'ogg-opus-decoder';
import { swahiliNumber, englishNumber, spellNumbers } from '../../services/api/src/services/speech/numbers.js';
import { tokenize, sentences, mmsAvailable, synthesizeMms, releaseAll } from '../../services/api/src/services/speech/mms.js';
import { encodeOggOpus } from '../../services/api/src/services/speech/ogg-opus.js';

test('prices are said the way Tanzanians say them, in Swahili and in English', () => {
  assert.equal(swahiliNumber(350000), 'laki tatu na elfu hamsini');
  assert.equal(swahiliNumber(1250000), 'milioni moja na laki mbili na elfu hamsini');
  assert.equal(swahiliNumber(25000), 'elfu ishirini na tano');
  assert.equal(swahiliNumber(125), 'mia moja ishirini na tano');
  assert.equal(englishNumber(350000), 'three hundred and fifty thousand');
  assert.equal(spellNumbers('TSh 350,000, 2.5 km'), 'TSh laki tatu na elfu hamsini , mbili nukta tano kilomita');
  assert.equal(spellNumbers('12% off', 'en'), 'twelve percent off');
  assert.equal(spellNumbers('(km 3)'), '(kilomita tatu )');
});

test('the MMS tokenizer lowers case, drops what the voice cannot say, and puts a blank between characters', () => {
  const meta = { vocab: { a: 5, b: 6, ' ': 3 } };
  assert.deepEqual(tokenize('Ab!', meta), [0, 5, 0, 6, 0]);
  assert.equal(tokenize('???', meta), null);
  assert.deepEqual(sentences('Habari. Nina ofa tano!\nJibu namba'), ['Habari', 'Nina ofa tano', 'Jibu namba']);
  assert.ok(sentences('neno '.repeat(100)).every((s) => s.length <= 200));
});

test('speech is written as an Ogg Opus voice note that a standard decoder plays back at the right length', async () => {
  const pcm = new Int16Array(16000 * 2).map((_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)));
  const ogg = encodeOggOpus(pcm);
  assert.equal(ogg.subarray(0, 4).toString(), 'OggS');
  assert.equal(ogg.subarray(28, 36).toString(), 'OpusHead');
  const d = new OggOpusDecoder();
  await d.ready;
  const out = await d.decodeFile(new Uint8Array(ogg));
  d.free();
  assert.equal(out.errors.length, 0);
  assert.ok(Math.abs(out.samplesDecoded / out.sampleRate - 2) < 0.05, `decoded ${out.samplesDecoded / out.sampleRate}s`);
});

// Runs only where the exported models are present (the Docker image, or TTS_MODEL_DIR pointing at them).
test('Meta\'s Swahili MMS voice speaks a real offer reply', { skip: !mmsAvailable('sw') && 'MMS models not present' }, async () => {
  const r = await synthesizeMms({ text: 'Nimekupatia ofa tano. Sofa ya watu watatu: TSh 350,000.', language: 'sw' });
  await releaseAll();
  assert.equal(r.ok, true);
  assert.equal(r.voice, 'facebook/mms-tts-swh');
  assert.ok(r.seconds > 2 && r.seconds < 20, `${r.seconds}s`);
  assert.equal(r.audio.subarray(0, 4).toString(), 'OggS');
});
