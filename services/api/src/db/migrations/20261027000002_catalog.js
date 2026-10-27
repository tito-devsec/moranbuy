// Catalogue tables: listings with their provenance, images, merchant locations and which locations stock what.
export async function up(knex) {
  await knex.schema.createTable('merchant_locations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    t.string('name', 120).notNullable();
    t.string('country', 2).notNullable().defaultTo('TZ');
    t.string('region', 100);
    t.string('district', 100);
    t.string('ward', 100);
    t.string('street', 200);
    t.string('address', 300);
    t.string('formatted_address', 400);
    t.decimal('latitude', 9, 6);
    t.decimal('longitude', 9, 6);
    t.string('location_source', 16); // USER_PIN | USER_ADDRESS | GEOCODED | IMPORTED | ADMIN
    t.boolean('pickup_available').notNullable().defaultTo(true);
    t.boolean('delivery_available'); // null means the merchant has not said
    t.integer('delivery_radius_km');
    t.integer('delivery_fee'); // null means not stated; never assumed zero
    t.text('delivery_notes');
    t.boolean('is_default').notNullable().defaultTo(false);
    t.string('source', 16).notNullable().defaultTo('moranbuy'); // moranbuy | moran
    t.string('source_location_id', 64);
    t.timestamp('deleted_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['merchant_id']);
    t.unique(['merchant_id', 'source', 'source_location_id']);
  });
  await knex.raw('ALTER TABLE merchant_locations ADD CONSTRAINT merchant_locations_lat_check CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90)');
  await knex.raw('ALTER TABLE merchant_locations ADD CONSTRAINT merchant_locations_lng_check CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)');
  await knex.raw('ALTER TABLE merchant_locations ADD CONSTRAINT merchant_locations_coords_pair_check CHECK ((latitude IS NULL) = (longitude IS NULL))');
  await knex.raw('CREATE UNIQUE INDEX merchant_locations_one_default ON merchant_locations (merchant_id) WHERE is_default AND deleted_at IS NULL');

  await knex.schema.createTable('listings', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    t.string('name', 200).notNullable();
    t.text('description');
    t.string('category', 80);
    t.string('product_type', 80);
    t.jsonb('attributes').notNullable().defaultTo('{}');
    t.jsonb('variants').notNullable().defaultTo('[]');
    t.integer('price').notNullable();
    t.string('currency', 3).notNullable().defaultTo('TZS');
    t.string('price_status', 16).notNullable().defaultTo('listed'); // listed | verified
    t.integer('stock'); // null means unknown
    t.string('condition', 16).notNullable().defaultTo('new');
    t.string('status', 16).notNullable().defaultTo('active'); // active | inactive | out_of_stock | archived
    t.boolean('moranbuy_visible').notNullable().defaultTo(true);
    t.string('image_url', 600);
    t.string('source', 16).notNullable().defaultTo('moranbuy'); // moranbuy | moran | web
    t.string('source_merchant_ref', 64); // Moran tenant id or web domain
    t.string('source_product_id', 64); // Moran product id or web URL hash
    t.string('source_sku', 80);
    t.string('source_retailer_id', 80);
    t.timestamp('source_updated_at', { useTz: true });
    t.timestamp('synced_at', { useTz: true });
    t.jsonb('sync_json').notNullable().defaultTo('{}');
    t.timestamp('deleted_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['merchant_id', 'status']);
    t.index(['category']);
    t.index(['product_type']);
    t.unique(['source', 'source_merchant_ref', 'source_product_id']);
  });
  await knex.raw("ALTER TABLE listings ADD CONSTRAINT listings_price_check CHECK (price >= 0)");
  await knex.raw("ALTER TABLE listings ADD CONSTRAINT listings_source_check CHECK (source IN ('moranbuy','moran','web'))");
  await knex.raw("CREATE INDEX listings_search_idx ON listings USING gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(category,'') || ' ' || coalesce(product_type,'') || ' ' || coalesce(description,'')))");

  await knex.schema.createTable('listing_images', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('listing_id').notNullable().references('id').inTable('listings').onDelete('CASCADE');
    t.string('url', 600).notNullable();
    t.integer('position').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('listing_locations', (t) => {
    t.uuid('listing_id').notNullable().references('id').inTable('listings').onDelete('CASCADE');
    t.uuid('location_id').notNullable().references('id').inTable('merchant_locations').onDelete('CASCADE');
    t.primary(['listing_id', 'location_id']);
  });
}

export async function down(knex) {
  for (const t of ['listing_locations', 'listing_images', 'listings', 'merchant_locations']) await knex.schema.dropTableIfExists(t);
}
