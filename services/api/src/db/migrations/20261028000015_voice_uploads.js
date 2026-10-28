// Voice notes people send and the spoken replies MoranBuy makes are stored as uploads too, so retention removes them on time.
export async function up(knex) {
  await knex.raw('ALTER TABLE uploads DROP CONSTRAINT uploads_purpose_check');
  await knex.raw("ALTER TABLE uploads ADD CONSTRAINT uploads_purpose_check CHECK (purpose IN ('product_image','verification_document','customer_photo','voice_note','voice_reply'))");
  // A spoken reply belongs to the conversation, not always to a known customer or business.
  await knex.raw('ALTER TABLE uploads DROP CONSTRAINT uploads_owner_check');
  await knex.raw("ALTER TABLE uploads ADD CONSTRAINT uploads_owner_check CHECK (merchant_id IS NOT NULL OR customer_id IS NOT NULL OR purpose = 'voice_reply')");
  await knex.schema.alterTable('uploads', (t) => { t.integer('duration_ms'); t.text('transcript'); });
}

export async function down(knex) {
  await knex('uploads').whereIn('purpose', ['voice_note', 'voice_reply']).del();
  await knex.schema.alterTable('uploads', (t) => { t.dropColumn('duration_ms'); t.dropColumn('transcript'); });
  await knex.raw('ALTER TABLE uploads DROP CONSTRAINT uploads_owner_check');
  await knex.raw('ALTER TABLE uploads ADD CONSTRAINT uploads_owner_check CHECK (merchant_id IS NOT NULL OR customer_id IS NOT NULL)');
  await knex.raw('ALTER TABLE uploads DROP CONSTRAINT uploads_purpose_check');
  await knex.raw("ALTER TABLE uploads ADD CONSTRAINT uploads_purpose_check CHECK (purpose IN ('product_image','verification_document','customer_photo'))");
}
