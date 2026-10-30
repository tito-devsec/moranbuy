import { config } from '@moranbuy/core';
import { redact } from '@moranbuy/observability';
import { recordMuseRequest, museBudgetState } from './telemetry.js';

// Muse Spark on the Meta Model API, called through its OpenAI-compatible chat completions endpoint.
export class MuseClient {
  constructor({ cfg = null, fetchImpl = globalThis.fetch, db = null, resolve = null } = {}) {
    const c = cfg || config();
    this.resolve = resolve;
    this.provider = c.MUSE_PROVIDER;
    this.baseUrl = String(c.MUSE_API_BASE_URL).replace(/\/+$/, '');
    this.apiKey = c.MUSE_API_KEY || null;
    this.model = c.MUSE_MODEL_ID;
    this.timeoutMs = c.MUSE_TIMEOUT_MS;
    this.reasoningEffort = c.MUSE_REASONING_EFFORT;
    this.audioModel = c.MUSE_AUDIO_MODEL_ID || 'muse-spark-1.2';
    this.asrModel = c.MUSE_ASR_MODEL_ID || 'muse-voice-transcribe-1.0';
    this.samModel = c.MUSE_SAM_MODEL_ID || 'sam-3.1';
    this.fetchImpl = fetchImpl;
    this.db = db;
  }

  // Refreshes provider, URL, key and model from the admin-entered credentials when a resolver is set.
  async refresh() {
    if (!this.resolve) return;
    const r = await this.resolve().catch(() => null);
    if (!r) return;
    this.provider = r.provider; this.baseUrl = String(r.baseUrl).replace(/\/+$/, ''); this.apiKey = r.apiKey || null; this.model = r.model; this.reasoningEffort = r.reasoningEffort || this.reasoningEffort; this.timeoutMs = r.timeoutMs || this.timeoutMs;
  }

  // True when a provider and a key are configured; the engines use deterministic fallbacks otherwise.
  get enabled() { return this.provider !== 'disabled' && !!this.apiKey; }

  // Key-free status for logs and the admin page.
  status() {
    return { provider: this.provider, model: this.model, baseUrl: this.baseUrl, configured: !!this.apiKey, enabled: this.enabled, reasoningEffort: this.reasoningEffort };
  }

  // One chat completion; returns parsed JSON when asked for it, and always records telemetry from the real outcome.
  async complete({ feature, system, messages, json = true, maxTokens = 1200, merchantId = null, requestRef = null, model = null, reasoningEffort = null }) {
    await this.refresh();
    if (!this.enabled) {
      await recordMuseRequest(this.db, { feature, provider: this.provider, model: this.model, status: 'disabled', merchantId, requestRef });
      return { ok: false, status: 'disabled' };
    }
    // With a hard cap on, a month that reached its budget makes no more Muse calls; every caller falls back to its plain path.
    if (feature !== 'test_connection' && (await museBudgetState(this.db).catch(() => ({ blocked: false }))).blocked) {
      await recordMuseRequest(this.db, { feature, provider: this.provider, model: this.model, status: 'budget_exceeded', merchantId, requestRef });
      return { ok: false, status: 'budget_exceeded' };
    }
    const useModel = model || this.model;
    const body = {
      model: useModel,
      messages: [{ role: 'developer', content: system }, ...messages],
      // Muse Spark reasons before it answers and the reasoning counts against max_tokens; a small cap cuts the answer off (BAD_JSON). Only used tokens are billed.
      max_tokens: Math.max(maxTokens, 2500),
      temperature: 0.2,
      reasoning_effort: reasoningEffort || this.reasoningEffort,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    };
    const started = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const latencyMs = Date.now() - started;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = `HTTP_${res.status}`;
        await recordMuseRequest(this.db, { feature, provider: this.provider, model: useModel, status: 'error', latencyMs, errorCode: code, errorRedacted: JSON.stringify(redact(data)).slice(0, 400), merchantId, requestRef });
        return { ok: false, status: 'error', code, latencyMs };
      }
      const text = data.choices?.[0]?.message?.content ?? '';
      const usage = data.usage || {};
      let parsed = null;
      if (json) {
        try { parsed = JSON.parse(stripFences(text)); } catch { parsed = firstJsonObject(text); }
        if (parsed === null) {
          // What came back is kept (redacted, first 200 characters) so a failure can be read in Super Admin; a reply cut off by the token limit says so.
          const why = data.choices?.[0]?.finish_reason === 'length' ? 'cut off at the token limit' : 'not JSON';
          await recordMuseRequest(this.db, { feature, provider: this.provider, model: useModel, status: 'error', latencyMs, errorCode: 'BAD_JSON', errorRedacted: `${why}: ${JSON.stringify(redact(String(text).slice(0, 200)))}`, merchantId, requestRef, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens });
          return { ok: false, status: 'error', code: 'BAD_JSON', latencyMs };
        }
      }
      await recordMuseRequest(this.db, { feature, provider: this.provider, model: data.model || useModel, status: 'ok', latencyMs, inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null, merchantId, requestRef });
      return { ok: true, status: 'ok', text, json: parsed, latencyMs, model: data.model || useModel, usage };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      await recordMuseRequest(this.db, { feature, provider: this.provider, model: useModel, status: timeout ? 'timeout' : 'error', latencyMs, errorCode: timeout ? 'TIMEOUT' : (err.code || err.name || 'NETWORK'), errorRedacted: err.message, merchantId, requestRef });
      return { ok: false, status: timeout ? 'timeout' : 'error', code: timeout ? 'TIMEOUT' : (err.code || 'NETWORK'), latencyMs };
    }
  }

  // Shared guard for the non-chat Meta calls: configured, within budget, and recorded whatever happens.
  async preflight(feature, model, { merchantId = null, requestRef = null } = {}) {
    await this.refresh();
    if (!this.enabled) { await recordMuseRequest(this.db, { feature, provider: this.provider, model, status: 'disabled', merchantId, requestRef }); return { ok: false, status: 'disabled' }; }
    if ((await museBudgetState(this.db).catch(() => ({ blocked: false }))).blocked) { await recordMuseRequest(this.db, { feature, provider: this.provider, model, status: 'budget_exceeded', merchantId, requestRef }); return { ok: false, status: 'budget_exceeded' }; }
    return null;
  }

  // Muse Voice Transcribe: a 16 kHz mono WAV in, the transcript out (POST /v1/asr/transcribe, multipart "request" and "audio").
  async transcribe(wav, { languageBias = null, merchantId = null, requestRef = null } = {}) {
    const blocked = await this.preflight('voice_transcribe', this.asrModel, { merchantId, requestRef });
    if (blocked) return blocked;
    const form = new FormData();
    form.append('request', new Blob([JSON.stringify({ model: this.asrModel, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK', ...(languageBias ? { languageBias } : {}) })], { type: 'application/json' }));
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'voice.wav');
    const started = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/asr/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' }, body: form, signal: AbortSignal.timeout(this.timeoutMs) });
      const latencyMs = Date.now() - started;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        await recordMuseRequest(this.db, { feature: 'voice_transcribe', provider: this.provider, model: this.asrModel, status: 'error', latencyMs, errorCode: `HTTP_${res.status}`, errorRedacted: JSON.stringify(redact(data)).slice(0, 400), merchantId, requestRef });
        return { ok: false, status: 'error', code: `HTTP_${res.status}`, latencyMs };
      }
      await recordMuseRequest(this.db, { feature: 'voice_transcribe', provider: this.provider, model: this.asrModel, status: 'ok', latencyMs, audioMs: Number(data.audioDurationMs || 0), merchantId, requestRef });
      return { ok: true, status: 'ok', transcript: String(data.transcript || '').trim(), audioDurationMs: Number(data.audioDurationMs || 0), latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      await recordMuseRequest(this.db, { feature: 'voice_transcribe', provider: this.provider, model: this.asrModel, status: timeout ? 'timeout' : 'error', latencyMs, errorCode: timeout ? 'TIMEOUT' : (err.code || err.name || 'NETWORK'), merchantId, requestRef });
      return { ok: false, status: timeout ? 'timeout' : 'error', latencyMs };
    }
  }

  // Segment Anything 3.1: one short noun phrase and an image in, a box per match out (POST /v1/responses).
  async segment(imageUrl, concept, { merchantId = null, requestRef = null } = {}) {
    const blocked = await this.preflight('sam_segment', this.samModel, { merchantId, requestRef });
    if (blocked) return blocked;
    const body = { model: this.samModel, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: String(concept).slice(0, 60) }, { type: 'input_image', image_url: imageUrl }] }], metadata: { include_confidence: 'true', mask_encoding: 'one_bit' } };
    const started = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
      const latencyMs = Date.now() - started;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        await recordMuseRequest(this.db, { feature: 'sam_segment', provider: this.provider, model: this.samModel, status: 'error', latencyMs, errorCode: `HTTP_${res.status}`, errorRedacted: JSON.stringify(redact(data)).slice(0, 400), merchantId, requestRef });
        return { ok: false, status: 'error', code: `HTTP_${res.status}`, latencyMs };
      }
      const text = data.output_text ?? (data.output || []).flatMap((o) => o.content || []).map((c) => c.text || '').join('');
      const usage = data.usage || {};
      await recordMuseRequest(this.db, { feature: 'sam_segment', provider: this.provider, model: this.samModel, status: 'ok', latencyMs, inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, merchantId, requestRef });
      return { ok: true, status: 'ok', boxes: parseSamBoxes(text), latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      await recordMuseRequest(this.db, { feature: 'sam_segment', provider: this.provider, model: this.samModel, status: timeout ? 'timeout' : 'error', latencyMs, errorCode: timeout ? 'TIMEOUT' : (err.code || err.name || 'NETWORK'), merchantId, requestRef });
      return { ok: false, status: timeout ? 'timeout' : 'error', latencyMs };
    }
  }

  // A tiny real request so the admin page can prove the connection works right now.
  async testConnection() {
    await this.refresh();
    const r = await this.complete({ feature: 'test_connection', system: 'Reply with the JSON object {"ok": true}.', messages: [{ role: 'user', content: 'ping' }], maxTokens: 20, reasoningEffort: 'minimal' });
    return { ...this.status(), result: r.ok ? 'ok' : r.status, code: r.code || null, latencyMs: r.latencyMs ?? null, model: r.model || this.model };
  }
}

// Removes ```json fences a model may wrap around its answer.
function stripFences(text) {
  return String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
}

// Reads SAM's box records: "<0f>0<|box;x1=181;y1=365;x2=556;y2=486;w=1516;h=1600;c=0.91|><|mask;...|>", one per match; masks are not needed here.
export function parseSamBoxes(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/<\|box;([^|]*)\|>/g)) {
    const f = Object.fromEntries(m[1].split(';').map((kv) => kv.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), Number(v)]));
    if ([f.x1, f.y1, f.x2, f.y2].every(Number.isFinite)) out.push({ x1: f.x1, y1: f.y1, x2: f.x2, y2: f.y2, width: f.w ?? null, height: f.h ?? null, confidence: Number.isFinite(f.c) ? f.c : null });
  }
  return out;
}

// The first complete {...} object in a reply that has words around it, or null.
export function firstJsonObject(text) {
  const t = String(text || '');
  for (let start = t.indexOf('{'); start !== -1; start = t.indexOf('{', start + 1)) {
    let depth = 0; let inStr = false; let esc = false;
    for (let i = start; i < t.length; i += 1) {
      const ch = t[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { break; } } }
    }
  }
  return null;
}
