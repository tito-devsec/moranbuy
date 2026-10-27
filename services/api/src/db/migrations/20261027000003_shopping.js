// Shopping tables: customers, sessions, structured requests, matching runs with their evidence, orders and enquiries.
export async function up(knex) {
  await knex.schema.createTable('customers', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('channel', 16).notNullable(); // whatsapp | web
    t.string('channel_ref', 160).notNullable(); // phone in E.164 for WhatsApp, a web token otherwise
    t.string('name', 120);
    t.string('language', 5).notNullable().defaultTo('sw');
    t.timestamp('last_seen_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['channel', 'channel_ref']);
  });

  await knex.schema.createTable('shopping_sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('state', 24).notNullable().defaultTo('collecting'); // collecting | clarifying | presented | selected | confirmed | closed
    t.jsonb('request_json').notNullable().defaultTo('{}');
    t.jsonb('context_json').notNullable().defaultTo('{}');
    t.uuid('current_run_id');
    t.uuid('selected_offer_id');
    t.timestamp('expires_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['customer_id', 'state']);
  });

  await knex.schema.createTable('session_messages', (t) => {
    t.bigIncrements('id');
    t.uuid('session_id').notNullable().references('id').inTable('shopping_sessions').onDelete('CASCADE');
    t.string('direction', 8).notNullable(); // in | out
    t.text('content').notNullable();
    t.string('content_type', 16).notNullable().defaultTo('text'); // text | image | location
    t.string('provider_message_id', 160);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['session_id', 'created_at']);
  });

  // One run per ranking: the request, every offer considered with its evidence, and the exclusions, for admin inspection.
  await knex.schema.createTable('matching_runs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('session_id').references('id').inTable('shopping_sessions').onDelete('SET NULL');
    t.jsonb('request_json').notNullable();
    t.jsonb('policy_json').notNullable();
    t.integer('candidates').notNullable().defaultTo(0);
    t.integer('ranked').notNullable().defaultTo(0);
    t.integer('over_budget').notNullable().defaultTo(0);
    t.integer('excluded').notNullable().defaultTo(0);
    t.boolean('none_within_budget').notNullable().defaultTo(false);
    t.jsonb('excluded_json').notNullable().defaultTo('[]');
    t.string('muse_status', 16); // ok | fallback | disabled | error
    t.integer('duration_ms');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['created_at']);
  });

  await knex.schema.createTable('matching_offers', (t) => {
    t.bigIncrements('id');
    t.uuid('run_id').notNullable().references('id').inTable('matching_runs').onDelete('CASCADE');
    t.uuid('listing_id').references('id').inTable('listings').onDelete('SET NULL');
    t.uuid('merchant_id');
    t.string('group', 12).notNullable(); // ranked | over_budget
    t.integer('rank').notNullable();
    t.integer('known_total').notNullable();
    t.boolean('total_confirmed').notNullable();
    t.string('budget_status', 16).notNullable();
    t.decimal('distance_km', 8, 1);
    t.jsonb('evidence_json').notNullable();
    t.index(['run_id', 'group', 'rank']);
  });

  await knex.schema.createTable('orders', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('order_ref', 16).notNullable().unique();
    t.uuid('customer_id').notNullable().references('id').inTable('customers');
    t.uuid('session_id').references('id').inTable('shopping_sessions').onDelete('SET NULL');
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants');
    t.uuid('listing_id').references('id').inTable('listings').onDelete('SET NULL');
    t.integer('quantity').notNullable().defaultTo(1);
    t.integer('unit_price').notNullable();
    t.integer('delivery_fee'); // null when not confirmed
    t.integer('known_total').notNullable();
    t.boolean('total_confirmed').notNullable();
    t.string('currency', 3).notNullable().defaultTo('TZS');
    t.string('fulfilment', 12).notNullable(); // delivery | pickup
    t.jsonb('customer_location_json');
    t.string('status', 24).notNullable().defaultTo('pending_merchant'); // pending_merchant | accepted | rejected | paid | fulfilled | cancelled
    t.string('external_ref', 80); // a Moran order ref when the merchant's order system took it
    t.text('notes');
    t.timestamp('confirmed_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['merchant_id', 'status']);
  });

  await knex.schema.createTable('enquiries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers');
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants');
    t.uuid('listing_id').references('id').inTable('listings').onDelete('SET NULL');
    t.uuid('session_id');
    t.text('question').notNullable();
    t.text('answer');
    t.string('status', 16).notNullable().defaultTo('open'); // open | answered | closed
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('answered_at', { useTz: true });
    t.index(['merchant_id', 'status']);
  });
}

export async function down(knex) {
  for (const t of ['enquiries', 'orders', 'matching_offers', 'matching_runs', 'session_messages', 'shopping_sessions', 'customers']) await knex.schema.dropTableIfExists(t);
}
