import knex from 'knex';
import knexfile from './knexfile.js';

// The one Knex instance for the process.
export const db = knex(knexfile);

// Runs a cheap query to prove the database answers.
export async function checkDbConnection() {
  await db.raw('select 1');
  return true;
}
