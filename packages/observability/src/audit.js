import { redact } from './redact.js';

// Writes one audit row describing who did what to which record; details are redacted first.
export async function audit(db, { actorType, actorId = null, merchantId = null, action, targetType = null, targetId = null, before = null, after = null, reason = null, ip = null }) {
  await db('audit_events').insert({
    actor_type: actorType,
    actor_id: actorId,
    merchant_id: merchantId,
    action,
    target_type: targetType,
    target_id: targetId ? String(targetId) : null,
    before_json: before ? JSON.stringify(redact(before)) : null,
    after_json: after ? JSON.stringify(redact(after)) : null,
    reason,
    ip,
  });
}
