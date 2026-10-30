// Products found online are kept as an index, so a later request is answered from it without paying for a new search; nearby-shop lookups are cached; searches are counted per day against the limits set in Super Admin.
export async function up(knex) {
  await knex.schema.createTable('web_products', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.text('url').notNullable().unique();
    t.string('domain', 200).notNullable();
    t.string('name', 300).notNullable();
    t.string('product_type', 80);
    t.string('category', 40);
    t.bigInteger('price');
    t.string('currency', 3).notNullable().defaultTo('TZS');
    t.text('description');
    t.text('image_url');
    t.jsonb('attributes').notNullable().defaultTo('{}');
    t.string('shop_name', 200);
    t.string('area', 200);
    t.string('condition', 20);
    t.string('source', 40).notNullable().defaultTo('meta_web_search');
    t.string('search_query', 300);
    t.integer('hits').notNullable().defaultTo(0);
    t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['product_type']);
    t.index(['last_seen_at']);
  });
  await knex.schema.createTable('nearby_shop_cache', (t) => {
    t.string('key', 300).primary();
    t.jsonb('results').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  // Moran businesses not on MoranBuy asked, per customer request, whether to offer their matching products.
  await knex.schema.createTable('business_leads', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('ref', 12).notNullable().unique();
    t.uuid('session_id').references('id').inTable('shopping_sessions').onDelete('CASCADE');
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('tenant_id', 64).notNullable();
    t.string('business_name', 200);
    t.string('owner_phone', 20).notNullable();
    t.string('product_type', 80);
    t.integer('matches').notNullable().defaultTo(0);
    t.jsonb('product_ids').notNullable().defaultTo('[]');
    t.jsonb('request_json').notNullable().defaultTo('{}');
    t.string('status', 16).notNullable().defaultTo('asked'); // asked | accepted | listed | declined | expired | failed
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('answered_at', { useTz: true });
    t.index(['owner_phone', 'status']);
    t.index(['tenant_id', 'created_at']);
  });
  await knex.schema.createTable('discovery_usage', (t) => {
    t.date('day').notNullable();
    t.string('kind', 20).notNullable();
    t.integer('count').notNullable().defaultTo(0);
    t.primary(['day', 'kind']);
  });
}

export async function down(knex) {
  await knex.schema.dropTable('discovery_usage');
  await knex.schema.dropTable('business_leads');
  await knex.schema.dropTable('nearby_shop_cache');
  await knex.schema.dropTable('web_products');
}
