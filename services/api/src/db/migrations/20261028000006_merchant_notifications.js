// Messages MoranBuy sends to business owners (an order confirmed, later other events), one row each, with the real outcome.
export async function up(knex) {
  await knex.schema.createTable('merchant_notifications', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    t.string('event', 32).notNullable(); // order_confirmed
    t.string('target_type', 16).notNullable(); // order
    t.string('target_id', 64).notNullable();
    t.string('channel', 16).notNullable(); // whatsapp
    t.string('to_phone', 20);
    t.string('kind', 12).notNullable(); // template | text
    t.string('template_name', 120);
    t.text('body');
    t.string('status', 16).notNullable(); // sent | failed | skipped | dry_run
    t.string('skip_reason', 64);
    t.string('provider_message_id', 160);
    t.text('error');
    t.string('idempotency_key', 120).notNullable().unique();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['merchant_id', 'created_at']);
  });
}
export async function down(knex) { await knex.schema.dropTableIfExists('merchant_notifications'); }
