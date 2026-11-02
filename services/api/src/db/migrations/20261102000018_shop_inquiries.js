// A customer who picked an online find or a shop on the map asks MoranBuy to contact that shop; the shop's number stays here, never in a customer message.
export async function up(knex) {
  // MoranBuy keeps its own copy of a product photo so WhatsApp can always fetch it.
  await knex.raw('ALTER TABLE uploads DROP CONSTRAINT uploads_purpose_check');
  await knex.raw("ALTER TABLE uploads ADD CONSTRAINT uploads_purpose_check CHECK (purpose IN ('product_image','verification_document','customer_photo','voice_note','voice_reply','delivery_photo','receipt','offer_image'))");
  await knex.raw('ALTER TABLE uploads DROP CONSTRAINT uploads_owner_check');
  await knex.raw("ALTER TABLE uploads ADD CONSTRAINT uploads_owner_check CHECK (merchant_id IS NOT NULL OR customer_id IS NOT NULL OR purpose IN ('voice_reply','delivery_photo','receipt','offer_image'))");
  await knex.schema.alterTable('web_products', (t) => { t.string('contact_phone', 20); });
  await knex.schema.createTable('shop_inquiries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('ref', 12).notNullable().unique();
    t.uuid('session_id').references('id').inTable('shopping_sessions').onDelete('SET NULL');
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('source', 12).notNullable(); // web | nearby
    t.string('shop_name', 200).notNullable();
    t.string('shop_phone', 20);
    t.string('shop_area', 200);
    t.text('product_name');
    t.bigInteger('price');
    t.string('currency', 3).notNullable().defaultTo('TZS');
    t.text('image_url');
    t.jsonb('request_json').notNullable().defaultTo('{}');
    t.string('status', 16).notNullable().defaultTo('new'); // new | available | unavailable | closed
    t.text('note');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('answered_at', { useTz: true });
    t.index(['status', 'created_at']);
  });
}

export async function down(knex) {
  await knex('uploads').where({ purpose: 'offer_image' }).del();
  await knex.raw('ALTER TABLE uploads DROP CONSTRAINT uploads_owner_check');
  await knex.raw("ALTER TABLE uploads ADD CONSTRAINT uploads_owner_check CHECK (merchant_id IS NOT NULL OR customer_id IS NOT NULL OR purpose IN ('voice_reply','delivery_photo','receipt'))");
  await knex.raw('ALTER TABLE uploads DROP CONSTRAINT uploads_purpose_check');
  await knex.raw("ALTER TABLE uploads ADD CONSTRAINT uploads_purpose_check CHECK (purpose IN ('product_image','verification_document','customer_photo','voice_note','voice_reply','delivery_photo','receipt'))");
  await knex.schema.dropTable('shop_inquiries');
  await knex.schema.alterTable('web_products', (t) => { t.dropColumn('contact_phone'); });
}
