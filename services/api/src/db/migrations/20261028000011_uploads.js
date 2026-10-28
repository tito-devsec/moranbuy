// Files people upload: product photos (public), verification documents (private to the business and admins), customer photos (private, short-lived).
export async function up(knex) {
  await knex.schema.createTable('uploads', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('purpose', 24).notNullable(); // product_image | verification_document | customer_photo
    t.uuid('merchant_id').references('id').inTable('merchants').onDelete('CASCADE');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
    t.string('mime', 40).notNullable();
    t.string('ext', 8).notNullable();
    t.integer('size_bytes').notNullable();
    t.string('sha256', 64).notNullable();
    t.string('storage_key', 120).notNullable().unique(); // file name inside UPLOAD_DIR
    t.string('original_name', 160);
    t.string('uploaded_by', 64);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['merchant_id', 'purpose', 'created_at']);
    t.index(['customer_id', 'created_at']);
  });
  await knex.raw("ALTER TABLE uploads ADD CONSTRAINT uploads_purpose_check CHECK (purpose IN ('product_image','verification_document','customer_photo'))");
  await knex.raw('ALTER TABLE uploads ADD CONSTRAINT uploads_owner_check CHECK (merchant_id IS NOT NULL OR customer_id IS NOT NULL)');
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('uploads');
}
