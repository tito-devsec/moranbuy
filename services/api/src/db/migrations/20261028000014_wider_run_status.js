// A search's status also names the web research outcome ("disabled;research:not_configured"), which did not fit in 16 characters.
export async function up(knex) {
  await knex.raw('ALTER TABLE matching_runs ALTER COLUMN muse_status TYPE varchar(80)');
}

export async function down(knex) {
  await knex.raw('ALTER TABLE matching_runs ALTER COLUMN muse_status TYPE varchar(16) USING left(muse_status, 16)');
}
