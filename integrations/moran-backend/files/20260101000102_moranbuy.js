/*
 * MoranBuy (github.com/tito-devsec/moranbuy): the admin-managed MoranBuy business and the opt-in
 * that lets a business's products be recommended by MoranBuy.
 */
export async function up(knex) {
  if (!(await knex.schema.hasColumn('tenants', 'admin_managed'))) {
    await knex.schema.alterTable('tenants', (t) => {
      // An account Super Admin runs; the owner login is refused and the password is unusable.
      t.boolean('admin_managed').notNullable().defaultTo(false);
      // The business agreed that MoranBuy may show its products to MoranBuy customers.
      t.boolean('moranbuy_listed').notNullable().defaultTo(false);
      t.timestamp('moranbuy_listed_at', { useTz: true });
    });
  }
  if (!(await knex.schema.hasColumn('services', 'moranbuy_listed'))) {
    await knex.schema.alterTable('services', (t) => { t.boolean('moranbuy_listed').notNullable().defaultTo(true); });
  }
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS tenants_one_moranbuy ON tenants ((1)) WHERE workspace_type = \'moranbuy\'');
}

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS tenants_one_moranbuy');
  if (await knex.schema.hasColumn('services', 'moranbuy_listed')) await knex.schema.alterTable('services', (t) => { t.dropColumn('moranbuy_listed'); });
  if (await knex.schema.hasColumn('tenants', 'admin_managed')) await knex.schema.alterTable('tenants', (t) => { t.dropColumn('admin_managed'); t.dropColumn('moranbuy_listed'); t.dropColumn('moranbuy_listed_at'); });
}
