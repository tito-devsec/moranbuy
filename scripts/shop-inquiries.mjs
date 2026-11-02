// Run inside the api container: node scripts/shop-inquiries.mjs list [new|all]  |  answer <REF> yes|no [price] [note...]
import { listShopInquiries, answerShopInquiry } from '../services/api/src/services/shop-inquiries.js';
import { shoppingDeps } from '../services/api/src/services/shopping.js';
import { db } from '../services/api/src/db/connection.js';

const [cmd, a, b, c, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'list') {
    for (const q of await listShopInquiries({ status: a || 'new' })) console.log(`${q.ref} [${q.status}] ${q.shop_name} | shop ${q.shop_phone || 'no number'} | ${q.product_name}${q.price ? ` | ${q.price} ${q.currency}` : ''} | customer ${q.customer_phone} | ${new Date(q.created_at).toISOString()}`);
  } else if (cmd === 'answer' && a && /^(yes|no)$/i.test(b || '')) {
    const price = c && /^\d+$/.test(c) ? Number(c) : null;
    const note = [price === null ? c : null, ...rest].filter(Boolean).join(' ') || null;
    console.log(JSON.stringify(await answerShopInquiry({ moran: shoppingDeps().moran, ref: a, available: /^yes$/i.test(b), price, note })));
  } else console.log('Usage: list [new|all] | answer <REF> yes|no [price] [note...]');
} finally { await db.destroy(); }
