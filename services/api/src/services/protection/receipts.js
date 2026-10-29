import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { config } from '@moranbuy/core';

// Receipts look like a till slip: 80 mm wide, monospaced, every figure from the database and never from Muse.
const WIDTH = 227; // 80 mm in points
const MARGIN = 12;
const COLS = 34; // characters per line at 9.5 pt Courier inside the margins
const EAT_MS = 3 * 3600000;

export const receiptNumber = (n) => `MB-R-${String(n).padStart(6, '0')}`;

const pad2 = (n) => String(n).padStart(2, '0');
export function eatDate(d) {
  const t = new Date(new Date(d).getTime() + EAT_MS);
  return { date: `${pad2(t.getUTCDate())}-${pad2(t.getUTCMonth() + 1)}-${t.getUTCFullYear()}`, time: `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}` };
}

const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const maskPhone = (p) => { const s = String(p || '').replace(/\D/g, ''); return s.length >= 9 ? `+${s.slice(0, 3)} ${s.slice(3, 6)} ••• ${s.slice(-3)}` : ''; };
const maskCustomer = (p) => { const s = String(p || '').replace(/\D/g, ''); return s.length >= 9 ? `${s.slice(0, 4)}••••${s.slice(-3)}` : 'web'; };

// The signed summary in the QR code: anyone can read it offline, and the check code proves MoranBuy issued exactly these figures.
export function receiptSummary(f) {
  const lines = [
    `MoranBuy receipt ${f.receiptNo}`,
    `Order ${f.orderRef} | ${f.date} ${f.time}`,
    `Business: ${f.businessName}${f.servedBy ? ` (served by ${f.servedBy})` : ''}`,
    ...f.items.map((i) => `${i.quantity}x ${i.name} @ ${money(i.unitPrice)}`),
    `Delivery ${f.deliveryFee === null ? 'n/a' : money(f.deliveryFee)} | TOTAL ${f.currency} ${money(f.total)}`,
    `Paid ${f.method} ${f.paymentRef} | Customer ${maskCustomer(f.customerPhone)}`,
    `Status: ${f.status}`,
  ];
  return lines.join('\n');
}

export function checkCode(summary, secret = null) {
  secret = secret || config().AUTH_SECRET;
  const h = crypto.createHmac('sha256', `receipt:${secret}`).update(summary).digest();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i += 1) out += alphabet[h[i] % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export function qrText(f, summary, code, appUrl = null) {
  // Sandbox receipts are checked on the sandbox, which the public site serves under /api/demo.
  const site = () => { const c = config(); return `${String(c.APP_URL || 'https://buy.moranai.co.tz').replace(/\/+$/, '')}${c.DEMO_MODE ? '/api/demo' : ''}`; };
  const base = String(appUrl || site()).replace(/\/+$/, '');
  return `${summary}\nVerify: ${base}/r/${f.receiptNo}?c=${code.replace('-', '')}\nCheck: ${code}`;
}

// Two columns in a fixed-width line: the label wraps, the amount stays right-aligned.
function row(label, amount, cols = COLS) {
  const a = String(amount);
  const room = cols - a.length - 1;
  const words = String(label).split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur ? `${cur} ${w}` : w).length > room) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  out.push(cur);
  const last = out.pop();
  return [...out.map((l) => l), `${last}${' '.repeat(Math.max(1, cols - last.length - a.length))}${a}`];
}

const center = (s, cols = COLS) => { const t = String(s).slice(0, cols); const left = Math.floor((cols - t.length) / 2); return `${' '.repeat(left)}${t}`; };

// Builds the receipt PDF from facts; the QR code carries the signed summary.
export async function renderReceiptPdf(f, { secret = null, appUrl = null } = {}) {
  const summary = receiptSummary(f);
  const code = f.checkCode || checkCode(summary, secret);
  const text = qrText(f, summary, code, appUrl);
  const qr = await QRCode.toBuffer(text, { errorCorrectionLevel: 'M', margin: 1, scale: 4 });
  const lines = [];
  const dash = '-'.repeat(COLS);
  lines.push({ t: center('MORANBUY RECEIPT'), size: 13, bold: true, gap: 4 });
  lines.push({ t: center(f.businessName), bold: true });
  if (f.address) lines.push({ t: center(f.address) });
  if (f.businessPhone) lines.push({ t: center(`Tel: ${maskPhone(f.businessPhone)}`) });
  if (f.servedBy) lines.push({ t: center(`Served by: ${f.servedBy}${f.servedRole ? ` (${f.servedRole})` : ''}`) });
  lines.push({ t: dash });
  lines.push(...row(`Receipt: ${f.receiptNo}`, '').map((t) => ({ t })));
  lines.push({ t: `Order: ${f.orderRef}` });
  lines.push({ t: `Date: ${f.date}${' '.repeat(Math.max(1, COLS - 6 - f.date.length - f.time.length - 4))}${f.time} EAT` });
  lines.push({ t: dash });
  for (const i of f.items) lines.push(...row(`${i.quantity} x ${i.name}`, money(i.unitPrice * i.quantity)).map((t) => ({ t })));
  if (f.deliveryFee !== null && f.deliveryFee !== undefined) lines.push(...row(`Delivery${f.deliveryLabel ? ` (${f.deliveryLabel})` : ''}`, money(f.deliveryFee)).map((t) => ({ t })));
  lines.push({ t: dash });
  lines.push({ t: row(`TOTAL ${f.currency}`, money(f.total), Math.floor((COLS * 9.5) / 11))[0], size: 11, bold: true, gap: 2 });
  lines.push({ t: `Paid: ${f.method}` });
  lines.push({ t: `Ref: ${f.paymentRef}` });
  lines.push(...wrap(`Status: ${f.status}`).map((t) => ({ t, bold: true })));
  if (f.statusNote) lines.push(...wrap(f.statusNote).map((t) => ({ t, size: 8 })));
  lines.push({ t: dash });

  const lineHeight = (l) => (l.size || 9.5) * 1.25 + (l.gap || 0);
  const qrSize = 120;
  const height = MARGIN * 2 + lines.reduce((n, l) => n + lineHeight(l), 0) + qrSize + 48;
  const doc = new PDFDocument({ size: [WIDTH, Math.ceil(height)], margin: MARGIN, info: { Title: `MoranBuy receipt ${f.receiptNo}`, Author: 'MoranBuy', Subject: `Order ${f.orderRef}` } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));
  let y = MARGIN;
  for (const l of lines) {
    doc.font(l.bold ? 'Courier-Bold' : 'Courier').fontSize(l.size || 9.5);
    const w = doc.widthOfString(l.t);
    // Lines in a bigger size are centred by measure, the rest sit on the monospaced grid.
    const x = l.size && l.size > 10 && /^\s/.test(l.t) ? (WIDTH - doc.widthOfString(l.t.trim())) / 2 : MARGIN;
    doc.text(l.size && l.size > 10 && /^\s/.test(l.t) ? l.t.trim() : l.t, x, y, { lineBreak: false, width: Math.max(w, WIDTH - MARGIN * 2) });
    y += lineHeight(l);
  }
  y += 6;
  doc.image(qr, (WIDTH - qrSize) / 2, y, { width: qrSize, height: qrSize });
  y += qrSize + 6;
  doc.font('Courier-Bold').fontSize(9.5);
  const powered = 'Powered by MoranBuy';
  doc.text(powered, (WIDTH - doc.widthOfString(powered)) / 2, y, { lineBreak: false });
  y += 13;
  doc.font('Courier').fontSize(7.5);
  const check = `Check ${code}`;
  doc.text(check, (WIDTH - doc.widthOfString(check)) / 2, y, { lineBreak: false });
  doc.end();
  await done;
  return { pdf: Buffer.concat(chunks), checkCode: code, qrText: text, summary };
}

function wrap(text, cols = COLS) {
  const out = [];
  let cur = '';
  for (const w of String(text).split(/\s+/)) {
    if ((cur ? `${cur} ${w}` : w).length > cols) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}
