// Muse hears a voice note: Muse Spark (the audio-capable version) transcribes Swahili, English or a mix; Muse Voice Transcribe is the second ear.
const SYSTEM = `You transcribe a short WhatsApp voice note from Tanzania, spoken in Swahili, English or a mix.
Write exactly what was said, in the language it was said, with numbers as the speaker said them (for example "laki tatu na nusu").
Do not translate, summarise or add anything. If nothing intelligible was said, return an empty transcript.
Answer with one JSON object: {"transcript": "...", "language": "sw" | "en" | "mixed" | "unknown"}.`;

export async function museTranscribeVoice(muse, { wav, merchantId = null, requestRef = null }) {
  const data = Buffer.from(wav).toString('base64');
  const r = await muse.complete({
    feature: 'voice_note', model: muse.audioModel, system: SYSTEM, maxTokens: 4000, merchantId, requestRef,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Transcribe this voice note.' }, { type: 'input_audio', input_audio: { data, format: 'wav' } }] }],
  });
  if (r.ok && typeof r.json?.transcript === 'string' && r.json.transcript.trim()) return { ok: true, transcript: r.json.transcript.trim().slice(0, 2000), language: r.json.language || 'unknown', source: 'muse_spark' };
  // The dedicated speech model knows 25 languages, Swahili not among them yet; it still helps for English and mixed speech.
  const asr = await muse.transcribe(wav, { merchantId, requestRef });
  if (asr.ok && asr.transcript) return { ok: true, transcript: asr.transcript.slice(0, 2000), language: 'unknown', source: 'muse_voice_transcribe' };
  return { ok: false, status: r.ok ? 'empty' : r.status, source: 'none' };
}
