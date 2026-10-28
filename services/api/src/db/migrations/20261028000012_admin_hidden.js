// A product an administrator hid from customer search, kept apart from the business's own visibility switch so neither a business nor a Moran sync can undo it.
export async function up(knex) {
  await knex.schema.alterTable('listings', (t) => {
    t.timestamp('admin_hidden_at', { useTz: true });
    t.text('admin_hidden_reason');
    t.string('admin_hidden_by', 120);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('listings', (t) => { t.dropColumn('admin_hidden_at'); t.dropColumn('admin_hidden_reason'); t.dropColumn('admin_hidden_by'); });
}
