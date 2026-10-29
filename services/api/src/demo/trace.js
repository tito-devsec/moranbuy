import { db } from '../db/connection.js';

// The demo terminal: every line is read back from what the real code just wrote (database rows and outgoing messages), never scripted.
const mask = (p) => { const s = String(p || ''); return s.length > 7 ? `${s.slice(0, 4)}••••${s.slice(-3)}` : s; };
const money = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US'));
const line = (at, level, svc, msg) => ({ at: new Date(at).toISOString(), level, svc, msg });

const MUSE_ENDPOINT = { sam_segment: 'POST api.meta.ai/v1/responses', voice_transcribe: 'POST api.meta.ai/v1/asr/transcribe' };

export async function traceSince({ dbImpl = db, session, since, moranLog, request = [] }) {
  const out = [...request];
  const t0 = new Date(since);

  for (const r of await dbImpl('muse_requests').where('created_at', '>=', t0).orderBy('id')) {
    if (r.status === 'disabled' || r.status === 'budget_exceeded') { out.push(line(r.created_at, 'WARN', 'muse', `feature=${r.feature} model=${r.model} status=${r.status} -> fallback=rules`)); continue; }
    const ep = MUSE_ENDPOINT[r.feature] || 'POST api.meta.ai/v1/chat/completions';
    out.push(line(r.created_at, r.status === 'ok' ? 'INFO' : 'WARN', 'muse', `${ep} model=${r.model} feature=${r.feature} ${r.status === 'ok' ? 200 : r.error_code || r.status} ${r.latency_ms ?? '-'}ms${r.input_tokens ? ` tokens=${r.input_tokens}/${r.output_tokens ?? 0}` : ''}`));
  }

  if (session.customerId) {
    const c = await dbImpl('customers').where({ id: session.customerId }).first();
    if (c?.terms_accepted_at && new Date(c.terms_accepted_at) >= t0) out.push(line(c.terms_accepted_at, 'INFO', 'terms', `accepted version=${c.terms_version} customer=${mask(c.channel_ref)}`));
    const runs = await dbImpl('matching_runs as r').join('shopping_sessions as s', 's.id', 'r.session_id').where('s.customer_id', session.customerId).where('r.created_at', '>=', t0).orderBy('r.created_at').select('r.*');
    for (const r of runs) {
      const q = r.request_json || {};
      out.push(line(r.created_at, 'INFO', 'parse', `source=${r.muse_status === 'ok' ? 'muse_spark' : 'rules'} product=${q.productType || '-'} budget=${money(q.maxBudget)} place="${q.location?.label || q.locationText || '-'}" fulfilment=${q.fulfilment || '-'}`));
      out.push(line(r.created_at, 'INFO', 'rank', `run=${r.id.slice(0, 8)} candidates=${r.candidates} within_budget=${r.ranked} over_budget=${r.over_budget} excluded=${r.excluded} order=budget,total,distance ${r.duration_ms ?? '-'}ms`));
      const offers = await dbImpl('matching_offers as o').leftJoin('listings as l', 'l.id', 'o.listing_id').leftJoin('merchants as m', 'm.id', 'o.merchant_id').where('o.run_id', r.id).orderBy([{ column: 'o.group', order: 'desc' }, { column: 'o.rank' }]).limit(6).select('o.*', 'l.name', 'm.business_name');
      for (const o of offers) out.push(line(r.created_at, 'DEBUG', 'rank', `${o.group === 'ranked' ? `#${o.rank}` : 'over'} ${String(o.name || '').padEnd(26).slice(0, 26)} ${String(o.business_name || '').padEnd(27).slice(0, 27)} total=${money(o.known_total)}${o.total_confirmed ? '' : '+?'} dist=${o.distance_km ?? '-'}km ${o.budget_status}`));
    }
    const orders = await dbImpl('orders').where({ customer_id: session.customerId });
    const ids = orders.map((o) => o.id);
    for (const o of orders) {
      if (new Date(o.created_at) >= t0) out.push(line(o.created_at, 'INFO', 'order', `created ${o.order_ref} qty=${o.quantity} unit=${money(o.unit_price)} total=${money(o.known_total)} confirmed=${o.total_confirmed} status=${o.status}`));
      else if (new Date(o.updated_at) >= t0) out.push(line(o.updated_at, 'INFO', 'order', `${o.order_ref} status=${o.status} total=${money(o.known_total)}`));
    }
    if (ids.length) {
      for (const p of await dbImpl('payments').where({ purpose: 'order' }).whereIn('target_id', ids).where((q) => q.where('created_at', '>=', t0).orWhere('settled_at', '>=', t0)).orderBy('created_at')) {
        if (new Date(p.created_at) >= t0) out.push(line(p.created_at, 'INFO', 'payment', `create provider=${p.provider} ref=${p.reference} amount=${money(p.amount)} ${p.currency} phone=${mask(p.phone)} status=pending`));
        if (p.settled_at && new Date(p.settled_at) >= t0) out.push(line(p.settled_at, 'INFO', 'webhook', `payment.${p.status === 'completed' ? 'completed' : 'failed'} ref=${p.reference} signature=verified -> status=${p.status}`));
      }
      const events = await dbImpl('delivery_events').whereIn('order_id', ids).where('id', '>', session.lastEventId || 0).orderBy('id');
      for (const e of events) {
        session.lastEventId = Math.max(session.lastEventId || 0, Number(e.id));
        const d = e.data_json || {};
        const extra = Object.entries(d).filter(([k, v]) => v !== null && v !== undefined && typeof v !== 'object' && !['fp', 'reusedPhoto', 'cataloguePhoto'].includes(k)).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(' ');
        const muse = d.muse?.matches ? ` muse.matches=${d.muse.matches} staged=${d.muse.looksStaged}` : d.muse?.status ? ` muse=${d.muse.status}` : '';
        const sam = d.sam ? ` sam.found=${d.sam.found}` : '';
        const fp = d.fp ? ` fp=${d.fp.slice(0, 8)} reused=${!!d.reusedPhoto} catalogue=${!!d.cataloguePhoto}` : '';
        out.push(line(e.created_at, ['code_bad', 'payment_failed', 'claim_refused'].includes(e.kind) ? 'WARN' : 'INFO', 'protect', `${e.kind} actor=${e.actor}${e.phone ? ` from=${mask(e.phone)}` : ''}${extra ? ` ${extra}` : ''}${fp}${muse}${sam}`));
        if (e.kind === 'payment_held') out.push(line(e.created_at, 'INFO', 'protect', 'handover code issued; stored as hmac-sha256, value not logged'));
      }
      for (const r of await dbImpl('receipts').whereIn('order_id', ids).where('created_at', '>=', t0).orderBy('created_at')) {
        const first = await dbImpl('receipts').where({ order_id: r.order_id }).orderBy('version').first('number');
        out.push(line(r.created_at, 'INFO', 'receipt', `MB-R-${String(first.number).padStart(6, '0')} v${r.version} status="${r.status_label}" check=${r.check_code} pdf=${r.upload_id ? 'stored' : 'missing'}`));
      }
      for (const p of await dbImpl('payouts').whereIn('order_id', ids).where((q) => q.where('created_at', '>=', t0).orWhere('settled_at', '>=', t0)).orderBy('created_at')) {
        out.push(line(p.settled_at || p.created_at, p.status === 'failed' ? 'WARN' : 'INFO', 'payout', `${p.kind} provider=${p.provider} ref=${p.reference || '-'} amount=${money(p.amount)} to=${mask(p.phone)} status=${p.status}`));
      }
    }
  }

  // What MoranBuy sent through the WhatsApp stand-in, to this session's numbers.
  for (const m of moranLog) {
    const kind = m.type === 'buttons' ? `buttons(${m.buttons?.length || 0})` : m.type === 'list' ? `list(${m.sections?.[0]?.rows?.length || 0})` : m.type === 'document' ? `document ${m.filename}` : m.type === 'template' ? `template ${m.templateName}` : m.type;
    const size = m.body ? ` ${Buffer.byteLength(m.body)}B` : m.audioBase64 ? ` ${Math.round((m.audioBase64.length * 3) / 4 / 1024)}KB ogg/opus` : m.documentBase64 ? ` ${Math.round((m.documentBase64.length * 3) / 4 / 1024)}KB pdf` : '';
    out.push(line(m.at, 'INFO', 'outbound', `${kind} -> ${mask(m.to)}${size} gate=ok key=${String(m.idempotencyKey || '').slice(0, 34)}`));
  }

  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export { mask };
