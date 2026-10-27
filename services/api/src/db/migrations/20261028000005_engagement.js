// Contacts and consent, templates, campaigns with their recipient ledger, payments, and follow-up leads and tasks.
export async function up(knex) {
  await knex.schema.createTable('contacts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    t.string('phone', 20).notNullable(); // E.164 digits only
    t.string('name', 120);
    t.string('source', 24).notNullable(); // enquiry | order | session | import | web_form
    t.jsonb('tags').notNullable().defaultTo('[]');
    t.timestamp('last_interaction_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['merchant_id', 'phone']);
  });

  // Append-only consent history; the current state is the latest event per merchant, phone, purpose and channel.
  await knex.schema.createTable('consent_events', (t) => {
    t.bigIncrements('id');
    t.uuid('merchant_id'); // null means every merchant (a STOP to the MoranBuy number)
    t.string('phone', 20).notNullable();
    t.string('purpose', 16).notNullable(); // marketing | followup | service | all
    t.string('channel', 16).notNullable().defaultTo('whatsapp');
    t.string('status', 12).notNullable(); // granted | revoked
    t.string('source', 32).notNullable(); // inbound_keyword | web_form | order_confirmation | merchant_attestation | admin | followup_offer
    t.string('evidence_ref', 200);
    t.string('recorded_by', 64);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['phone', 'purpose', 'created_at']);
    t.index(['merchant_id', 'phone']);
  });

  await knex.schema.createTable('message_templates', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    t.string('name', 120).notNullable();
    t.string('language', 8).notNullable().defaultTo('sw');
    t.string('category', 16).notNullable().defaultTo('MARKETING');
    t.string('header_format', 12).notNullable().defaultTo('NONE'); // NONE | TEXT | IMAGE | VIDEO
    t.string('header_text', 60);
    t.string('header_media_url', 600);
    t.text('body').notNullable();
    t.string('footer', 60);
    t.jsonb('buttons_json').notNullable().defaultTo('[]');
    t.string('status', 16).notNullable().defaultTo('draft'); // draft | pending | approved | rejected | paused | unavailable
    t.string('provider', 16); // moran
    t.string('provider_template_id', 64);
    t.text('status_reason');
    t.timestamp('submitted_at', { useTz: true });
    t.timestamp('reviewed_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['merchant_id', 'status']);
  });

  await knex.schema.createTable('payments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    t.string('purpose', 24).notNullable(); // campaign | entitlement
    t.string('target_id', 64);
    t.string('provider', 16).notNullable(); // sandbox | snippe
    t.string('reference', 120).notNullable().unique();
    t.integer('amount').notNullable();
    t.string('currency', 3).notNullable().defaultTo('TZS');
    t.string('phone', 20);
    t.string('status', 16).notNullable().defaultTo('pending'); // pending | completed | failed | refunded
    t.jsonb('breakdown_json').notNullable().defaultTo('{}');
    t.jsonb('provider_json').notNullable().defaultTo('{}');
    t.timestamp('settled_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['merchant_id', 'status']);
  });

  await knex.schema.createTable('campaigns', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    t.string('kind', 24).notNullable().defaultTo('campaign'); // campaign | new_product_outreach
    t.string('name', 160).notNullable();
    t.text('objective');
    t.uuid('listing_id').references('id').inTable('listings').onDelete('SET NULL');
    t.uuid('template_id').references('id').inTable('message_templates').onDelete('SET NULL');
    t.jsonb('audience_json').notNullable().defaultTo('{"segment":"consented_contacts"}');
    t.string('language', 8).notNullable().defaultTo('sw');
    t.text('draft_body');
    t.jsonb('draft_history_json').notNullable().defaultTo('[]');
    t.string('media_url', 600);
    t.string('status', 20).notNullable().defaultTo('draft'); // offered | declined | draft | approved | priced | awaiting_payment | paid | ready | dispatching | completed | paused | cancelled | failed
    t.jsonb('audience_preview_json').notNullable().defaultTo('{}');
    t.jsonb('pricing_json').notNullable().defaultTo('{}');
    t.uuid('payment_id').references('id').inTable('payments').onDelete('SET NULL');
    t.jsonb('sender_json').notNullable().defaultTo('{}');
    t.jsonb('gate_results_json').notNullable().defaultTo('{}');
    t.boolean('dry_run').notNullable().defaultTo(true);
    t.timestamp('approved_at', { useTz: true });
    t.timestamp('confirmed_at', { useTz: true });
    t.string('confirmed_by', 64);
    t.timestamp('dispatched_at', { useTz: true });
    t.timestamp('completed_at', { useTz: true });
    t.integer('count_queued').notNullable().defaultTo(0);
    t.integer('count_sent').notNullable().defaultTo(0);
    t.integer('count_delivered').notNullable().defaultTo(0);
    t.integer('count_failed').notNullable().defaultTo(0);
    t.integer('count_skipped').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['merchant_id', 'status']);
  });

  // The durable ledger: one row per recipient, claimed with a conditional update so no one is messaged twice.
  await knex.schema.createTable('campaign_recipients', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('campaign_id').notNullable().references('id').inTable('campaigns').onDelete('CASCADE');
    t.uuid('merchant_id').notNullable();
    t.string('phone', 20).notNullable();
    t.string('status', 12).notNullable().defaultTo('queued'); // queued | sending | sent | delivered | read | failed | skipped
    t.string('skip_reason', 64);
    t.string('idempotency_key', 120).notNullable().unique();
    t.string('provider_message_id', 160);
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('last_error');
    t.boolean('dry_run').notNullable().defaultTo(true);
    t.timestamp('sent_at', { useTz: true });
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['campaign_id', 'phone']);
    t.index(['campaign_id', 'status']);
  });

  await knex.schema.createTable('followup_leads', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    t.string('phone', 20).notNullable();
    t.string('customer_ref', 64);
    t.uuid('listing_id').references('id').inTable('listings').onDelete('SET NULL');
    t.string('source', 24).notNullable(); // enquiry | order | session | manual
    t.text('stated_intention');
    t.timestamp('requested_contact_at', { useTz: true });
    t.string('consent_basis', 32); // followup_granted | service_relationship | none
    t.string('state', 16).notNullable().defaultTo('new'); // new | scheduled | contacted | converted | stopped
    t.timestamp('next_action_at', { useTz: true });
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(2);
    t.timestamp('last_contact_at', { useTz: true });
    t.string('outcome', 24);
    t.string('stop_reason', 32);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['merchant_id', 'state', 'next_action_at']);
  });

  await knex.schema.createTable('followup_tasks', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('lead_id').notNullable().references('id').inTable('followup_leads').onDelete('CASCADE');
    t.uuid('merchant_id').notNullable();
    t.integer('attempt').notNullable();
    t.timestamp('due_at', { useTz: true }).notNullable();
    t.string('status', 12).notNullable().defaultTo('pending'); // pending | sending | sent | skipped | failed | cancelled
    t.string('skip_reason', 64);
    t.string('idempotency_key', 120).notNullable().unique();
    t.text('message');
    t.boolean('dry_run').notNullable().defaultTo(true);
    t.jsonb('result_json').notNullable().defaultTo('{}');
    t.timestamp('sent_at', { useTz: true });
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['status', 'due_at']);
  });
}

export async function down(knex) {
  for (const t of ['followup_tasks', 'followup_leads', 'campaign_recipients', 'campaigns', 'payments', 'message_templates', 'consent_events', 'contacts']) await knex.schema.dropTableIfExists(t);
}
