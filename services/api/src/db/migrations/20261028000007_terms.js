// Whether a sender accepted MoranBuy's terms and privacy policy, and which version; nothing is answered before that.
export async function up(knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.string('terms_status', 12).notNullable().defaultTo('pending'); // pending | accepted | rejected
    t.string('terms_version', 20);
    t.timestamp('terms_accepted_at', { useTz: true });
    t.integer('terms_prompts').notNullable().defaultTo(0);
  });
}
export async function down(knex) {
  await knex.schema.alterTable('customers', (t) => { t.dropColumn('terms_status'); t.dropColumn('terms_version'); t.dropColumn('terms_accepted_at'); t.dropColumn('terms_prompts'); });
}
