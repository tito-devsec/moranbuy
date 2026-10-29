// Payment protection: the customer pays MoranBuy, the money is held, and it goes to the business only after the handover code proves delivery.
export async function up(knex) {
  await knex.schema.alterTable('merchants', (t) => {
    t.string('owner_name', 120); // shown on receipts as "Served by"
    t.string('payout_phone', 20); // mobile money number payments are released to; contact_phone when blank
  });

  await knex.schema.createTable('order_protection', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('order_id').notNullable().unique().references('id').inTable('orders').onDelete('CASCADE');
    // awaiting_payment | paid_held | deliverer_assigned | delivered | released | rejection_pending | refund_pending | refunded | disputed | expired
    t.string('state', 24).notNullable();
    t.uuid('payment_id').references('id').inTable('payments').onDelete('SET NULL');
    t.integer('amount').notNullable();
    t.string('currency', 3).notNullable().defaultTo('TZS');
    t.string('code_hash', 128); // HMAC of the handover code; the code itself is never stored
    t.integer('code_attempts').notNullable().defaultTo(0);
    t.boolean('code_ok').notNullable().defaultTo(false);
    t.string('deliverer_phone', 20);
    t.string('deliverer_name', 120);
    t.string('deliverer_step', 24); // null | arrived | rejecting
    t.integer('reschedules').notNullable().defaultTo(0);
    t.jsonb('rejection_json'); // { category, text, uploadId }
    t.timestamp('paid_at', { useTz: true });
    t.timestamp('assigned_at', { useTz: true });
    t.timestamp('delivered_at', { useTz: true });
    t.timestamp('release_due_at', { useTz: true });
    t.timestamp('closed_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['state']);
    t.index(['deliverer_phone', 'state']);
  });

  // Everything that happened to a protected order, in order: the evidence an admin reads in a dispute.
  await knex.schema.createTable('delivery_events', (t) => {
    t.bigIncrements('id');
    t.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE');
    t.string('actor', 12).notNullable(); // customer | merchant | deliverer | system | admin
    t.string('kind', 32).notNullable();
    t.string('phone', 20);
    t.uuid('upload_id');
    t.jsonb('data_json').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['order_id', 'created_at']);
  });

  await knex.schema.createTable('disputes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE');
    t.string('opened_by', 12).notNullable(); // customer | deliverer | system
    t.string('category', 24).notNullable();
    t.text('reason');
    t.string('status', 20).notNullable().defaultTo('open'); // open | released | refunded
    t.jsonb('muse_json'); // Muse's summary and suggestion; never the decision
    t.uuid('resolved_by');
    t.text('resolution_note');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('resolved_at', { useTz: true });
    t.index(['status']);
  });

  // Money leaving MoranBuy's account: a release to the business or a refund to the customer.
  await knex.schema.createTable('payouts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE');
    t.string('kind', 8).notNullable(); // release | refund
    t.string('provider', 16).notNullable();
    t.string('reference', 120).unique();
    t.integer('amount').notNullable();
    t.integer('fee');
    t.string('currency', 3).notNullable().defaultTo('TZS');
    t.string('phone', 20).notNullable();
    t.string('recipient_name', 160);
    t.string('status', 12).notNullable().defaultTo('pending'); // pending | completed | failed | reversed
    t.text('error');
    t.jsonb('provider_json').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('settled_at', { useTz: true });
    t.unique(['order_id', 'kind']);
  });

  await knex.schema.createTable('receipts', (t) => {
    t.bigIncrements('number'); // MB-R-000123
    t.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.string('status_label', 40).notNullable();
    t.string('check_code', 16).notNullable();
    t.text('qr_text').notNullable();
    t.uuid('upload_id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['order_id', 'version']);
  });

  // A refused claim or a wrong delivery counts against the customer or the business; three need a person to look first.
  await knex.schema.createTable('strikes', (t) => {
    t.bigIncrements('id');
    t.string('subject_type', 10).notNullable(); // customer | merchant
    t.uuid('subject_id').notNullable();
    t.uuid('order_id').references('id').inTable('orders').onDelete('SET NULL');
    t.string('reason', 40).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['subject_type', 'subject_id']);
  });

  await knex.raw('ALTER TABLE uploads DROP CONSTRAINT uploads_purpose_check');
  await knex.raw("ALTER TABLE uploads ADD CONSTRAINT uploads_purpose_check CHECK (purpose IN ('product_image','verification_document','customer_photo','voice_note','voice_reply','delivery_photo','receipt'))");
  await knex.raw('ALTER TABLE uploads DROP CONSTRAINT uploads_owner_check');
  await knex.raw("ALTER TABLE uploads ADD CONSTRAINT uploads_owner_check CHECK (merchant_id IS NOT NULL OR customer_id IS NOT NULL OR purpose IN ('voice_reply','delivery_photo','receipt'))");
}

export async function down(knex) {
  await knex('uploads').whereIn('purpose', ['delivery_photo', 'receipt']).del();
  await knex.raw('ALTER TABLE uploads DROP CONSTRAINT uploads_owner_check');
  await knex.raw("ALTER TABLE uploads ADD CONSTRAINT uploads_owner_check CHECK (merchant_id IS NOT NULL OR customer_id IS NOT NULL OR purpose = 'voice_reply')");
  await knex.raw('ALTER TABLE uploads DROP CONSTRAINT uploads_purpose_check');
  await knex.raw("ALTER TABLE uploads ADD CONSTRAINT uploads_purpose_check CHECK (purpose IN ('product_image','verification_document','customer_photo','voice_note','voice_reply'))");
  for (const table of ['strikes', 'receipts', 'payouts', 'disputes', 'delivery_events', 'order_protection']) await knex.schema.dropTableIfExists(table);
  await knex.schema.alterTable('merchants', (t) => { t.dropColumn('owner_name'); t.dropColumn('payout_phone'); });
}
