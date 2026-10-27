import { config } from '@moranbuy/core';
import { redact } from '@moranbuy/observability';
import { recordMuseRequest } from './telemetry.js';

// Muse Spark on the Meta Model API, called through its OpenAI-compatible chat completions endpoint.
export class MuseClient {
  constructor({ cfg = null, fetchImpl = globalThis.fetch, db = null } = {}) {
    const c = cfg || config();
    this.provider = c.MUSE_PROVIDER;
    this.baseUrl = String(c.MUSE_API_BASE_URL).replace(/\/+$/, '');
    this.apiKey = c.MUSE_API_KEY || null;
    this.model = c.MUSE_MODEL_ID;
    this.timeoutMs = c.MUSE_TIMEOUT_MS;
    this.reasoningEffort = c.MUSE_REASONING_EFFORT;
    this.fetchImpl = fetchImpl;
    this.db = db;
  }

  // True when a provider and a key are configured; the engines use deterministic fallbacks otherwise.
  get enabled() { return this.provider !== 'disabled' && !!this.apiKey; }

  // Key-free status for logs and the admin page.
  status() {
    return { provider: this.provider, model: this.model, baseUrl: this.baseUrl, configured: !!this.apiKey, enabled: this.enabled, reasoningEffort: this.reasoningEffort };
  }

  // One chat completion; returns parsed JSON when asked for it, and always records telemetry from the real outcome.
  async complete({ feature, system, messages, json = true, maxTokens = 1200, merchantId = null, requestRef = null }) {
    if (!this.enabled) {
      await recordMuseRequest(this.db, { feature, provider: this.provider, model: this.model, status: 'disabled', merchantId, requestRef });
      return { ok: false, status: 'disabled' };
    }
    const body = {
      model: this.model,
      messages: [{ role: 'developer', content: system }, ...messages],
      max_tokens: maxTokens,
      temperature: 0.2,
      reasoning_effort: this.reasoningEffort,
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
        await recordMuseRequest(this.db, { feature, provider: this.provider, model: this.model, status: 'error', latencyMs, errorCode: code, errorRedacted: JSON.stringify(redact(data)).slice(0, 400), merchantId, requestRef });
        return { ok: false, status: 'error', code, latencyMs };
      }
      const text = data.choices?.[0]?.message?.content ?? '';
      const usage = data.usage || {};
      let parsed = null;
      if (json) {
        try { parsed = JSON.parse(stripFences(text)); } catch { parsed = null; }
        if (parsed === null) {
          await recordMuseRequest(this.db, { feature, provider: this.provider, model: this.model, status: 'error', latencyMs, errorCode: 'BAD_JSON', merchantId, requestRef, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens });
          return { ok: false, status: 'error', code: 'BAD_JSON', latencyMs };
        }
      }
      await recordMuseRequest(this.db, { feature, provider: this.provider, model: data.model || this.model, status: 'ok', latencyMs, inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null, merchantId, requestRef });
      return { ok: true, status: 'ok', text, json: parsed, latencyMs, model: data.model || this.model, usage };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      await recordMuseRequest(this.db, { feature, provider: this.provider, model: this.model, status: timeout ? 'timeout' : 'error', latencyMs, errorCode: timeout ? 'TIMEOUT' : (err.code || err.name || 'NETWORK'), errorRedacted: err.message, merchantId, requestRef });
      return { ok: false, status: timeout ? 'timeout' : 'error', code: timeout ? 'TIMEOUT' : (err.code || 'NETWORK'), latencyMs };
    }
  }

  // A tiny real request so the admin page can prove the connection works right now.
  async testConnection() {
    const r = await this.complete({ feature: 'test_connection', system: 'Reply with the JSON object {"ok": true}.', messages: [{ role: 'user', content: 'ping' }], maxTokens: 20 });
    return { ...this.status(), result: r.ok ? 'ok' : r.status, code: r.code || null, latencyMs: r.latencyMs ?? null, model: r.model || this.model };
  }
}

// Removes ```json fences a model may wrap around its answer.
function stripFences(text) {
  return String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
}
