// Records one real Muse request outcome; nothing here is ever written without an actual call having been made.
export async function recordMuseRequest(db, { feature, provider, model, status, latencyMs = null, inputTokens = null, outputTokens = null, errorCode = null, errorRedacted = null, merchantId = null, requestRef = null }) {
  if (!db) return;
  await db('muse_requests').insert({
    feature, provider, model, status, latency_ms: latencyMs, input_tokens: inputTokens, output_tokens: outputTokens,
    error_code: errorCode, error_redacted: errorRedacted ? String(errorRedacted).slice(0, 500) : null, merchant_id: merchantId, request_ref: requestRef,
  });
}

// Summarises the telemetry table for the admin page: counts, failures, latency and last success, all from stored rows.
export async function museTelemetry(db, { sinceHours = 24 } = {}) {
  const since = new Date(Date.now() - sinceHours * 3600000);
  const rows = await db('muse_requests').where('created_at', '>=', since).select('feature', 'status', 'latency_ms', 'input_tokens', 'output_tokens', 'model', 'provider', 'created_at');
  const byFeature = {};
  let ok = 0; let failed = 0; let latencySum = 0; let latencyCount = 0; let inTok = 0; let outTok = 0;
  for (const r of rows) {
    byFeature[r.feature] ||= { requests: 0, ok: 0, failed: 0 };
    byFeature[r.feature].requests += 1;
    if (r.status === 'ok') { ok += 1; byFeature[r.feature].ok += 1; } else { failed += 1; byFeature[r.feature].failed += 1; }
    if (r.latency_ms !== null) { latencySum += r.latency_ms; latencyCount += 1; }
    inTok += r.input_tokens || 0; outTok += r.output_tokens || 0;
  }
  const lastOk = await db('muse_requests').where({ status: 'ok' }).orderBy('created_at', 'desc').first('created_at', 'model', 'provider');
  const lastErr = await db('muse_requests').whereNot({ status: 'ok' }).orderBy('created_at', 'desc').first('created_at', 'error_code', 'error_redacted');
  return {
    sinceHours, requests: rows.length, ok, failed, avgLatencyMs: latencyCount ? Math.round(latencySum / latencyCount) : null,
    inputTokens: inTok, outputTokens: outTok, byFeature, lastSuccess: lastOk || null, lastFailure: lastErr || null,
  };
}
