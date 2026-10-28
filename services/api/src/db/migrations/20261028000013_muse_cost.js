// What each Muse request cost, priced with the rates an administrator entered at the time; null while no rate is set.
export async function up(knex) {
  await knex.schema.alterTable('muse_requests', (t) => {
    t.decimal('cost_usd', 14, 8);
    t.string('pricing_ref', 40); // which rate card priced it, e.g. "2026-10-28T10:00:00Z" or "recomputed"
  });
}

export async function down(knex) {
  await knex.schema.alterTable('muse_requests', (t) => { t.dropColumn('cost_usd'); t.dropColumn('pricing_ref'); });
}
