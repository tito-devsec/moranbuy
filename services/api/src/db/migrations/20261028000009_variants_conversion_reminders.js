// The chosen product variant on an order, the order that converted a follow-up lead, and the reminder state of customer schedules.
export async function up(knex) {
  await knex.schema.alterTable('orders', (t) => {
    t.string('variant', 80);
  });
  await knex.schema.alterTable('followup_leads', (t) => {
    t.uuid('converted_order_id').references('id').inTable('orders').onDelete('SET NULL');
    t.timestamp('converted_at', { useTz: true });
  });
  await knex.schema.alterTable('customer_schedules', (t) => {
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('reminded_at', { useTz: true });
    t.string('reminder_kind', 12); // text | template | dry_run
    t.string('reminder_status', 16); // sent | skipped | failed
    t.string('skip_reason', 64);
    t.text('reminder_message');
    t.string('provider_message_id', 160);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('customer_schedules', (t) => { for (const c of ['attempts', 'reminded_at', 'reminder_kind', 'reminder_status', 'skip_reason', 'reminder_message', 'provider_message_id']) t.dropColumn(c); });
  await knex.schema.alterTable('followup_leads', (t) => { t.dropColumn('converted_order_id'); t.dropColumn('converted_at'); });
  await knex.schema.alterTable('orders', (t) => { t.dropColumn('variant'); });
}
