import { audit } from '@moranbuy/observability';

// Starts a payment and records it pending; nothing is marked paid here.
export async function startPayment(db, provider, { merchantId, purpose, targetId, amount, currency = 'TZS', phone = null, breakdown = {}, actorId = null }) {
  const started = await provider.createPayment({ amount, currency, phone, metadata: { merchantId, purpose, targetId } });
  const [row] = await db('payments').insert({ merchant_id: merchantId, purpose, target_id: targetId, provider: provider.name, reference: started.reference, amount: Math.round(amount), currency, phone, status: 'pending', breakdown_json: JSON.stringify(breakdown), provider_json: JSON.stringify(started.providerData || {}) }).returning('*');
  await audit(db, { actorType: actorId ? 'merchant' : 'system', actorId, merchantId, action: 'payment.started', targetType: 'payment', targetId: row.id, after: { purpose, amount, provider: provider.name } });
  return row;
}

// Settles a payment from a verified provider event; forward only, and a settled amount below the due amount never completes it.
export async function settlePayment(db, { reference, status, settledAmount = null, eventId = null, source = 'provider' }) {
  if (eventId) {
    const inserted = await db('webhook_events').insert({ source, event_id: eventId, event_type: `payment.${status}` }).onConflict(['source', 'event_id']).ignore().returning('id');
    if (!inserted.length) return { duplicate: true };
  }
  const row = await db('payments').where({ reference }).first();
  if (!row) return { unknown: true };
  if (row.status === 'completed') return { payment: row, unchanged: true };
  const covers = settledAmount === null || Number(settledAmount) >= Number(row.amount);
  const next = status === 'completed' && covers ? 'completed' : status === 'completed' ? 'failed' : status;
  const [updated] = await db('payments').where({ id: row.id }).update({ status: next, settled_at: db.fn.now(), provider_json: db.raw(`provider_json || ?::jsonb`, [JSON.stringify({ lastEvent: { status, settledAmount, eventId } })]) }).returning('*');
  await audit(db, { actorType: 'system', merchantId: row.merchant_id, action: 'payment.settled', targetType: 'payment', targetId: row.id, before: { status: row.status }, after: { status: next, covers } });
  return { payment: updated };
}

// True only when the database says this exact payment completed; never trusted from a client.
export async function paymentCompleted(db, paymentId) {
  const row = await db('payments').where({ id: paymentId }).first('status');
  return row?.status === 'completed';
}
