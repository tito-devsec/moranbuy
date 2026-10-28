// When a confirmed campaign should start sending; null sends at once.
export async function up(knex) {
  await knex.schema.alterTable('campaigns', (t) => {
    t.timestamp('scheduled_at', { useTz: true });
    t.text('status_reason');
    t.index(['status', 'scheduled_at']);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('campaigns', (t) => { t.dropIndex(['status', 'scheduled_at']); t.dropColumn('scheduled_at'); t.dropColumn('status_reason'); });
}
