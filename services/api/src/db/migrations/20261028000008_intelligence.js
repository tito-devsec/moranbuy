// Demand signals, customer schedules and chat catalogue uploads: what Muse records so statistics, fit and search have real data.
export async function up(knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.string('region', 80);
    t.string('district', 80);
    t.string('last_intent', 24);
    t.string('purchase_timing', 16); // now | later | browsing
    t.timestamp('last_location_at', { useTz: true });
  });
  await knex.schema.alterTable('session_messages', (t) => {
    t.string('kind', 16); // text | image | voice | location | button
  });
  // A product a business sends by chat is its own source, so its origin stays visible beside dashboard and Moran listings.
  await knex.raw("ALTER TABLE listings DROP CONSTRAINT listings_source_check");
  await knex.raw("ALTER TABLE listings ADD CONSTRAINT listings_source_check CHECK (source IN ('moranbuy','moran','web','whatsapp_chat'))");
  // One row per customer message that said what they want; the basis of every "what people ask for" statistic.
  await knex.schema.createTable('demand_signals', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('session_id').references('id').inTable('shopping_sessions').onDelete('SET NULL');
    t.uuid('merchant_id').references('id').inTable('merchants').onDelete('SET NULL'); // the merchant chosen or ordered from, when known
    t.uuid('listing_id').references('id').inTable('listings').onDelete('SET NULL');
    t.string('product_type', 80);
    t.string('category', 40);
    t.jsonb('attributes_json').notNullable().defaultTo('{}');
    t.integer('max_budget');
    t.string('currency', 3).notNullable().defaultTo('TZS');
    t.string('location_label', 200);
    t.string('region', 80);
    t.string('district', 80);
    t.decimal('lat', 9, 6);
    t.decimal('lng', 9, 6);
    t.string('intent', 24).notNullable(); // shop | clarify | select | confirm | cancel | other
    t.string('purchase_timing', 16); // now | later | browsing
    t.string('source_kind', 16).notNullable().defaultTo('text'); // text | image | voice | location | button
    t.string('outcome', 24); // asked | presented | no_match | selected | ordered | cancelled
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['created_at']);
    t.index(['product_type', 'created_at']);
    t.index(['region', 'district']);
    t.index(['customer_id', 'created_at']);
  });
  // Something a customer asked to happen later: a call back, a reminder, a planned purchase.
  await knex.schema.createTable('customer_schedules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('session_id').references('id').inTable('shopping_sessions').onDelete('SET NULL');
    t.uuid('merchant_id').references('id').inTable('merchants').onDelete('SET NULL');
    t.uuid('listing_id').references('id').inTable('listings').onDelete('SET NULL');
    t.string('kind', 24).notNullable(); // callback | reminder | purchase_plan
    t.timestamp('due_at', { useTz: true });
    t.string('when_text', 160);
    t.text('note');
    t.string('status', 16).notNullable().defaultTo('scheduled'); // scheduled | done | cancelled
    t.string('source', 24).notNullable().defaultTo('customer_message');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['status', 'due_at']);
    t.index(['customer_id']);
  });
  // A product a registered business sent to the MoranBuy number by chat (text or photo), with what Muse read from it.
  await knex.schema.createTable('catalog_uploads', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    t.uuid('listing_id').references('id').inTable('listings').onDelete('SET NULL');
    t.string('from_phone', 20).notNullable();
    t.string('message_id', 160);
    t.text('raw_text');
    t.string('image_url', 600);
    t.string('kind', 16).notNullable().defaultTo('text'); // text | image | voice
    t.jsonb('extraction_json').notNullable().defaultTo('{}');
    t.string('muse_status', 16).notNullable(); // ok | fallback | disabled
    t.string('status', 16).notNullable(); // created | updated | rejected
    t.text('reason');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['merchant_id', 'created_at']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('catalog_uploads');
  await knex.raw("ALTER TABLE listings DROP CONSTRAINT listings_source_check");
  await knex.raw("ALTER TABLE listings ADD CONSTRAINT listings_source_check CHECK (source IN ('moranbuy','moran','web'))");
  await knex.schema.dropTableIfExists('customer_schedules');
  await knex.schema.dropTableIfExists('demand_signals');
  await knex.schema.alterTable('session_messages', (t) => { t.dropColumn('kind'); });
  await knex.schema.alterTable('customers', (t) => { for (const c of ['region', 'district', 'last_intent', 'purchase_timing', 'last_location_at']) t.dropColumn(c); });
}
