import bcrypt from 'bcryptjs';

// Creates the first platform admin from ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD when no admin exists; never overwrites one.
export async function seed(knex) {
  const email = String(process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD || '';
  if (!email || password.length < 12) { console.log('seed: ADMIN_BOOTSTRAP_EMAIL and a 12+ character ADMIN_BOOTSTRAP_PASSWORD are needed to create the first admin; nothing done'); return; }
  const existing = await knex('admin_users').count('id as n').first();
  if (Number(existing.n) > 0) { console.log('seed: an admin already exists; nothing done'); return; }
  await knex('admin_users').insert({ email, name: 'MoranBuy Admin', password_hash: await bcrypt.hash(password, 12), role: 'super_admin' });
  console.log(`seed: created super_admin ${email}`);
}
