// Foundation tables: platform admins, merchants and their people, entitlements, audit, webhooks, Muse telemetry.
export async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  await knex.schema.createTable('admin_users', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('email', 255).notNullable().unique();
    t.string('name', 120).notNullable();
    t.string('password_hash', 255).notNullable();
    t.string('role', 24).notNullable().defaultTo('admin'); // super_admin | admin | support
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('last_login_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('merchants', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('registration_type', 16).notNullable(); // standalone | moran
    t.string('moran_tenant_id', 64).unique();
    t.string('business_name', 160).notNullable();
    t.string('slug', 80).notNullable().unique();
    t.string('industry', 80);
    t.text('description');
    t.string('country', 2).notNullable().defaultTo('TZ');
    t.string('currency', 3).notNullable().defaultTo('TZS');
    t.string('contact_phone', 32);
    t.string('contact_email', 255);
    t.string('verification_status', 24).notNullable().defaultTo('unverified'); // unverified | pending | verified | rejected
    t.jsonb('verification_json').notNullable().defaultTo('{}');
    t.string('status', 16).notNullable().defaultTo('active'); // active | suspended | closed
    t.text('status_reason');
    t.text('moran_refresh_token_encrypted');
    t.timestamp('moran_linked_at', { useTz: true });
    t.timestamp('products_synced_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['registration_type', 'status']);
  });
  await knex.raw("ALTER TABLE merchants ADD CONSTRAINT merchants_registration_type_check CHECK (registration_type IN ('standalone','moran'))");

  await knex.schema.createTable('merchant_users', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    t.string('email', 255).notNullable();
    t.string('name', 120).notNullable();
    t.string('password_hash', 255);
    t.string('role', 16).notNullable().defaultTo('owner'); // owner | staff
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('last_login_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['email']);
  });

  await knex.schema.createTable('refresh_tokens', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('subject_type', 16).notNullable(); // merchant_user | admin
    t.uuid('subject_id').notNullable();
    t.string('token_hash', 64).notNullable().unique();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('revoked_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['subject_type', 'subject_id']);
  });

  // One row per service a merchant selected; nothing is active until billing and activation say so.
  await knex.schema.createTable('merchant_entitlements', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    t.string('service', 32).notNullable(); // product_listing | campaign_engine | new_product_outreach | paid_followup | conversation_agent
    t.string('status', 16).notNullable().defaultTo('selected'); // selected | pending_payment | active | paused | cancelled
    t.string('billing_state', 16).notNullable().defaultTo('unpaid'); // unpaid | paid | overdue | free
    t.timestamp('selected_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('activated_at', { useTz: true });
    t.timestamp('paused_at', { useTz: true });
    t.timestamp('expires_at', { useTz: true });
    t.jsonb('limits_json').notNullable().defaultTo('{}');
    t.string('activated_by', 64);
    t.unique(['merchant_id', 'service']);
  });
  await knex.raw("ALTER TABLE merchant_entitlements ADD CONSTRAINT merchant_entitlements_service_check CHECK (service IN ('product_listing','campaign_engine','new_product_outreach','paid_followup','conversation_agent'))");

  await knex.schema.createTable('audit_events', (t) => {
    t.bigIncrements('id');
    t.string('actor_type', 16).notNullable(); // admin | merchant | customer | system
    t.string('actor_id', 64);
    t.uuid('merchant_id');
    t.string('action', 80).notNullable();
    t.string('target_type', 40);
    t.string('target_id', 64);
    t.jsonb('before_json');
    t.jsonb('after_json');
    t.text('reason');
    t.string('ip', 64);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['merchant_id', 'created_at']);
    t.index(['action', 'created_at']);
  });

  // Every webhook or forwarded event once, keyed by its provider id, so retries never double-process.
  await knex.schema.createTable('webhook_events', (t) => {
    t.bigIncrements('id');
    t.string('source', 32).notNullable(); // moran | snippe | whatsapp
    t.string('event_id', 160).notNullable();
    t.string('event_type', 80);
    t.string('status', 16).notNullable().defaultTo('received'); // received | processed | failed
    t.text('error');
    t.timestamp('received_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('processed_at', { useTz: true });
    t.unique(['source', 'event_id']);
  });

  // Real Muse Spark telemetry: one row per request, never invented.
  await knex.schema.createTable('muse_requests', (t) => {
    t.bigIncrements('id');
    t.string('feature', 48).notNullable(); // intent | image | recommendation | campaign_draft | outreach_draft | followup_summary | admin_summary | test_connection
    t.string('provider', 24).notNullable();
    t.string('model', 64).notNullable();
    t.string('status', 16).notNullable(); // ok | error | timeout | disabled
    t.integer('latency_ms');
    t.integer('input_tokens');
    t.integer('output_tokens');
    t.string('error_code', 64);
    t.text('error_redacted');
    t.uuid('merchant_id');
    t.string('request_ref', 64);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['created_at']);
    t.index(['feature', 'created_at']);
  });

  // Platform settings changed only through an audited admin action.
  await knex.schema.createTable('platform_settings', (t) => {
    t.string('key', 80).primary();
    t.jsonb('value').notNullable();
    t.string('updated_by', 64);
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex) {
  for (const table of ['platform_settings', 'muse_requests', 'webhook_events', 'audit_events', 'merchant_entitlements', 'refresh_tokens', 'merchant_users', 'merchants', 'admin_users']) {
    await knex.schema.dropTableIfExists(table);
  }
}
