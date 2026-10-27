// Merchant settings, the Moran services a linked merchant imports from, and the Moran service a listing came from.
export async function up(knex) {
  await knex.schema.alterTable('merchants', (t) => {
    t.jsonb('settings_json').notNullable().defaultTo('{}');
    t.jsonb('moran_services_json').notNullable().defaultTo('[]');
    t.string('moran_owner_email', 255);
  });
  await knex.schema.alterTable('listings', (t) => {
    t.string('moran_service_id', 64);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('listings', (t) => { t.dropColumn('moran_service_id'); });
  await knex.schema.alterTable('merchants', (t) => { t.dropColumn('settings_json'); t.dropColumn('moran_services_json'); t.dropColumn('moran_owner_email'); });
}
