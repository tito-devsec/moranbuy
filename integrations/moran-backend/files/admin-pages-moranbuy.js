import { h, icon, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { api } from '../core/api.js';
import { bootPage } from '../core/page.js';
import { simpleTable } from '../core/table.js';
import { badge, drawer, loadInto, toast, toastError, button, busy, confirmAction } from '../core/ui.js';
import { card } from '../core/widgets.js';
import { input, select, textarea, readForm } from '../core/forms.js';
import { formatDateTime, formatInt } from '../core/format.js';

/*
 * MoranBuy inside Super Admin (docs/moranbuy.md). The setup card walks through: register the
 * MoranBuy business, connect its WhatsApp number with Meta's Embedded Signup, choose the name it
 * appears under, then the MoranBuy dashboard opens below. The dashboard reads the MoranBuy
 * service through /api/admin/moranbuy/api/* (signed; MoranBuy audits every action under this admin).
 */
const mb = {
  get: (p, q) => api.get(`/moranbuy/api/${p}`, q),
  post: (p, b) => api.post(`/moranbuy/api/${p}`, b),
  put: (p, b) => api.put(`/moranbuy/api/${p}`, b),
};
const money = (n, c = 'TZS') => (n === null || n === undefined ? t('not stated') : `${c === 'TZS' ? 'TSh' : c} ${formatInt(n)}`);
const pre = (v) => h('pre', { class: 'fs-xs mb-0', text: JSON.stringify(v, null, 1) });

// ---- Meta Embedded Signup from Super Admin, the same flow the owner dashboard runs ----
let sdkReady = null;
function loadFacebookSdk(appId) {
  if (sdkReady) return sdkReady;
  sdkReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(t('Facebook took too long to load. Check the connection and try again.'))), 15000);
    const init = () => { clearTimeout(timeout); window.FB.init({ appId, version: 'v25.0', cookie: true, xfbml: false }); resolve(); };
    if (window.FB) return init();
    window.fbAsyncInit = init;
    if (!document.getElementById('facebook-jssdk')) { const s = document.createElement('script'); s.id = 'facebook-jssdk'; s.src = 'https://connect.facebook.net/en_US/sdk.js'; s.async = true; document.head.append(s); }
  });
  return sdkReady;
}

// Meta posts the account ids back as a message event; the server can find them itself when the event is lost.
function nextSignupEvent(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, ms);
    function onMsg(e) {
      if (!/facebook\.com$/.test(new URL(e.origin).hostname)) return;
      let data; try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
      if (!data || data.type !== 'WA_EMBEDDED_SIGNUP') return;
      clearTimeout(timer); window.removeEventListener('message', onMsg);
      const d = data.data || {};
      if (['FINISH', 'FINISH_ONLY_WABA', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'].includes(data.event)) resolve({ wabaId: d.waba_id || null, phoneNumberId: d.phone_number_id || null, businessId: d.business_id || null, coexistence: data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' });
      else resolve({ cancelled: true, message: d.error_message || null });
    }
    window.addEventListener('message', onMsg);
  });
}

async function connectWhatsApp(onProgress) {
  const cfg = await api.get('/moranbuy/signup-config');
  if (!cfg.configId) throw new Error(t('WhatsApp signup is not configured on the backend (META_EMBEDDED_SIGNUP_CONFIG_ID).'));
  await loadFacebookSdk(cfg.appId);
  const event = nextSignupEvent(15 * 60 * 1000);
  const response = await new Promise((resolve) => window.FB.login((r) => resolve(r || {}), { config_id: cfg.configId, response_type: 'code', override_default_response_type: true, extras: cfg.extras || { setup: {} } }));
  const code = response.authResponse && response.authResponse.code;
  if (!code) throw new Error(t('The Facebook window was closed before the number was connected.'));
  onProgress(t('Linking the number…'));
  const ids = (await Promise.race([event, new Promise((r) => setTimeout(() => r(null), 12000))])) || {};
  if (ids.cancelled) throw new Error(ids.message || t('Meta did not finish the signup.'));
  return api.post('/moranbuy/whatsapp/connect', { code, wabaId: ids.wabaId || undefined, phoneNumberId: ids.phoneNumberId || undefined, businessId: ids.businessId || undefined, coexistence: ids.coexistence || undefined, reason: 'Connected from Super Admin' });
}

// ---- the setup card: register, connect, name, open ----
function setupCard(state, onDone) {
  const el = h('div');
  const render = async () => {
    const s = await api.get('/moranbuy');
    let profile = null;
    try { profile = s.registered ? (await mb.get('agent-profile')).profile : null; } catch { profile = null; }
    const connected = s.tenant?.whatsapp?.status === 'connected';
    const named = !!(profile && profile.name && profile.name !== 'MoranBuy');
    const step = (n, title, done, body) => h('div', { class: 'd-flex gap-3 py-3 border-bottom' },
      h('div', { class: `rounded-circle d-inline-flex align-items-center justify-content-center flex-shrink-0 ${done ? 'bg-success text-white' : 'bg-light text-muted'}`, attrs: { style: undefined }, text: done ? '✓' : String(n) }),
      h('div', { class: 'flex-grow-1' }, h('div', { class: 'fw-bold', text: title }), body));
    const status = h('div', { class: 'text-muted fs-sm mt-1' });
    const registerBtn = button(t('Register MoranBuy'), { onClick: () => busy(registerBtn, async () => {
      const ownerEmail = prompt(t('Contact email for the MoranBuy business (admins sign in; this address never does):'));
      if (!ownerEmail) return;
      await api.post('/moranbuy/register', { ownerEmail, reason: 'Registered from the MoranBuy page' });
      toast(t('MoranBuy registered.')); render();
    }).catch(toastError) });
    const connectBtn = button(connected ? t('Reconnect WhatsApp number') : t('Connect MoranBuy to WhatsApp'), { iconName: 'whatsapp', variant: connected ? 'secondary' : 'primary', onClick: () => busy(connectBtn, async () => {
      status.textContent = t('Opening the Facebook window…');
      const r = await connectWhatsApp((m) => { status.textContent = m; });
      toast(t('Connected {n}', { n: r.displayNumber || '' })); render();
    }).catch((e) => { status.textContent = e.message; toastError(e); }) });
    const nameInput = input({ name: 'name', label: t('Name MoranBuy appears under'), value: profile?.name || '', required: true, maxlength: 60, help: t('Customers see this name in replies ("Habari, mimi ni … wa MoranBuy"). The WhatsApp display name itself is set in Meta Business Manager.') });
    const nameBtn = button(t('Save name'), { onClick: () => busy(nameBtn, async () => {
      const name = readForm(nameInput).name;
      if (!name) return;
      await api.post('/moranbuy/profile', { name, reason: 'Set from Super Admin' });
      await mb.put('agent-profile', { name, reason: 'Set from Super Admin' });
      toast(t('Name saved.')); render();
    }).catch(toastError) });
    const openBtn = button(t('Open MoranBuy dashboard'), { iconName: 'bag-check-fill', onClick: () => onDone() });
    mount(el, card({ title: t('Set up MoranBuy'), body: h('div', {},
      step(1, t('Register the MoranBuy business'), s.registered, s.registered ? h('div', { class: 'fs-sm text-muted', text: `${s.tenant.businessName} · ${s.tenant.status}` }) : registerBtn),
      step(2, t('Connect MoranBuy to WhatsApp'), connected, h('div', {}, h('div', { class: 'fs-sm text-muted mb-2', text: connected ? t('Connected: {n}', { n: s.tenant.whatsapp.displayNumber || '' }) : t('Uses the same Meta Embedded Signup as every business. Sign in to the Facebook account that owns the MoranBuy number.') }), s.registered ? connectBtn : null, status)),
      step(3, t('Choose the name MoranBuy appears under'), named, s.registered ? h('div', { class: 'row g-2 align-items-end' }, h('div', { class: 'col-md-6' }, nameInput), h('div', { class: 'col-auto' }, nameBtn)) : h('div', { class: 'fs-sm text-muted', text: t('Register first.') })),
      step(4, t('Open the MoranBuy dashboard'), false, s.registered && connected ? openBtn : h('div', { class: 'fs-sm text-muted', text: t('Available once the number is connected.') })),
      s.service.secretConfigured ? null : h('div', { class: 'alert alert-warning mt-3 mb-0 fs-sm', text: t('MORANBUY_API_URL and MORANBUY_SHARED_SECRET are not set on the backend; the dashboard cannot reach MoranBuy.') }),
    ) }));
    if (s.registered && connected && state.autoOpen) { state.autoOpen = false; onDone(); }
  };
  render().catch((e) => mount(el, card({ title: t('Set up MoranBuy'), body: h('p', { class: 'text-danger', text: e.message }) })));
  return { el, refresh: render };
}

// ---- the dashboard: the MoranBuy admin sections, read through the signed proxy ----
const SECTIONS = ['Overview', 'Insights', 'Merchants', 'Verification', 'Ranking', 'Campaigns', 'Outreach', 'Templates', 'Follow-up', 'Orders', 'Notifications', 'Billing', 'Muse Spark', 'Credentials', 'Integration Health', 'Retention', 'Audit'];

function dashboard() {
  const body = h('div');
  const tabs = h('ul', { class: 'nav nav-pills flex-wrap gap-1 mb-3' });
  let active = 'Overview';
  const show = (name) => { active = name; [...tabs.children].forEach((li) => li.firstChild.classList.toggle('active', li.dataset.name === name)); loadInto(body, () => load(name), (d) => h('div', {}, explainBar(name), render(name, d, () => show(name)))); };
  SECTIONS.forEach((name) => tabs.append(h('li', { class: 'nav-item', dataset: { name } }, h('a', { class: 'nav-link', attrs: { href: '#' }, text: t(name), on: { click: (e) => { e.preventDefault(); show(name); } } }))));
  show(active);
  return h('div', {}, tabs, body);
}

async function load(name) {
  switch (name) {
    case 'Overview': return mb.get('overview');
    case 'Insights': return { overview: await mb.get('insights?days=30&language=en'), schedules: (await mb.get('schedules')).schedules, uploads: (await mb.get('catalog-uploads')).uploads };
    case 'Merchants': return mb.get('merchants');
    case 'Verification': return mb.get('merchants', { verification: 'pending' });
    case 'Ranking': return { policy: await mb.get('ranking/policy'), runs: (await mb.get('ranking/runs')).runs };
    case 'Campaigns': case 'Outreach': return mb.get('campaigns');
    case 'Templates': return mb.get('templates');
    case 'Follow-up': return mb.get('followup');
    case 'Orders': return mb.get('orders');
    case 'Notifications': return { ...(await mb.get('notifications/order-confirmed')), terms: await mb.get('notifications/terms'), reminder: await mb.get('notifications/schedule-reminder') };
    case 'Billing': return { pricing: await mb.get('pricing'), servicePricing: await mb.get('service-pricing'), payments: (await mb.get('payments')).payments };
    case 'Muse Spark': return { muse: await mb.get('muse'), credentials: (await mb.get('credentials')).credentials };
    case 'Credentials': return mb.get('credentials');
    case 'Integration Health': return mb.get('integrations');
    case 'Retention': return mb.get('retention');
    case 'Audit': return mb.get('audit');
    default: return {};
  }
}

// Opens an uploaded file for review in a new tab; private files come through the signed proxy and each view is audited.
async function openUpload(u) {
  try {
    if (u.url) { window.open(u.url, '_blank', 'noopener'); return; }
    const r = await mb.get(`uploads/${u.id}`);
    const bytes = Uint8Array.from(atob(r.dataBase64), (c) => c.charCodeAt(0));
    window.open(URL.createObjectURL(new Blob([bytes], { type: r.upload.mime })), '_blank', 'noopener');
  } catch (err) { toastError(err); }
}

// Which admin section Muse can explain, by the section's tab name.
const EXPLAIN = { Overview: 'overview', Insights: 'demand', Campaigns: 'campaigns', Outreach: 'campaigns', 'Follow-up': 'followup', Orders: 'orders', Billing: 'payments', 'Muse Spark': 'muse', Retention: 'retention' };

// Asks MoranBuy for the section's counts, rule checks and Muse's reading, and shows them in place.
function explainBar(name) {
  const section = EXPLAIN[name];
  if (!section) return null;
  const out = h('div', { class: 'mt-2' });
  const btn = button(t('Explain with Muse'), { size: 'sm', variant: 'secondary', onClick: () => busy(btn, async () => {
    const r = await mb.post('summary', { section });
    out.replaceChildren(card({ title: t(r.source === 'muse' ? 'Muse Spark reading' : 'Rule checks (Muse is off or its reading did not match the numbers)'), body: h('div', {}, h('p', { text: r.summary }), r.checks.length ? h('ul', { class: 'mb-0' }, ...r.checks.map((c) => h('li', { text: c }))) : h('p', { class: 'text-muted mb-0', text: t('No checks raised.') })) }));
  }).catch(toastError) });
  return h('div', { class: 'mb-3' }, btn, out);
}

function merchantDrawer(id) {
  Promise.all([mb.get(`merchants/${id}`), mb.get(`merchants/${id}/uploads`).catch(() => ({ uploads: [] }))]).then(([d, up]) => { d.uploads = up.uploads;
    const ent = (service, action) => confirmAction({ title: t('{a} {s}', { a: action, s: service }), requireReason: true, action: async (reason) => { await mb.post(`merchants/${id}/entitlements/${service}`, { action, reason, billingState: 'paid' }); toast(t('Saved.')); } });
    drawer({ title: d.merchant.businessName, subtitle: `${d.merchant.registrationType} · ${d.merchant.verificationStatus} · ${d.merchant.status}`, width: 'mo-drawer-wide', body: h('div', {},
      h('h3', { class: 'fs-sm fw-bold mt-2', text: t('Services') }),
      simpleTable([{ key: 'service', label: t('Service') }, { key: 'status', label: t('Status'), render: (e) => `${e.status} · ${e.billing_state}` }, { key: '_', label: '', render: (e) => h('div', { class: 'd-flex gap-2' }, button(t('Activate'), { size: 'sm', onClick: () => ent(e.service, 'activate') }), button(t('Pause'), { size: 'sm', variant: 'secondary', onClick: () => ent(e.service, 'pause') })) }], d.entitlements),
      h('h3', { class: 'fs-sm fw-bold mt-3', text: t('Products') }),
      simpleTable([{ key: 'name', label: t('Product') }, { key: 'price', label: t('Price'), render: (l) => money(l.price, l.currency) }, { key: 'stock', label: t('Stock'), render: (l) => (l.stock === null ? t('unknown') : l.stock) }, { key: 'status', label: t('Status') }, { key: 'source', label: t('Source') }], d.listings),
      h('h3', { class: 'fs-sm fw-bold mt-3', text: t('Locations') }),
      simpleTable([{ key: 'name', label: t('Name') }, { key: 'formattedAddress', label: t('Address') }, { key: 'latitude', label: t('Position'), render: (l) => (l.latitude === null ? t('not placed') : `${l.latitude}, ${l.longitude}`) }, { key: 'deliveryFee', label: t('Delivery fee'), render: (l) => money(l.deliveryFee) }], d.locations),
      h('h3', { class: 'fs-sm fw-bold mt-3', text: t('Verification documents and uploads') }),
      simpleTable([{ key: 'purpose', label: t('Purpose') }, { key: 'originalName', label: t('File'), render: (u) => u.originalName || u.mime }, { key: 'sizeBytes', label: t('Size'), render: (u) => `${Math.round(u.sizeBytes / 1024)} KB` }, { key: '_', label: '', render: (u) => button(t('Open'), { size: 'sm', variant: 'secondary', onClick: () => openUpload(u) }) }], d.uploads || [], { empty: t('No uploads.') }),
      h('h3', { class: 'fs-sm fw-bold mt-3', text: t('Orders, campaigns, payments') }), pre({ orders: d.orders.length, campaigns: d.campaigns.length, payments: d.payments.length, followup: d.followup.settings }),
    ) });
  }).catch(toastError);
}

// The terms question put to every new sender, with Accept and Reject buttons, before the agent answers.
// The reminder a customer asked for ("nitanunua wiki ijayo"), sent from the MoranBuy number when it falls due.
function reminderCard(rem, reload) {
  const st = rem.settings;
  const form = h('div', { class: 'row g-2' },
    h('div', { class: 'col-md-6' }, textarea({ name: 'textSw', label: t('Reminder (Swahili), placeholders {name} {product} {when} {merchant}'), value: st.textSw, rows: 3, maxlength: 1000 })),
    h('div', { class: 'col-md-6' }, textarea({ name: 'textEn', label: t('Reminder (English)'), value: st.textEn, rows: 3, maxlength: 1000 })),
    h('div', { class: 'col-md-4' }, input({ name: 'templateName', label: t('Approved template (needed after 24 hours of silence)'), value: st.templateName, placeholder: 'moranbuy_reminder' })),
    h('div', { class: 'col-md-2' }, input({ name: 'templateLanguage', label: t('Template language'), value: st.templateLanguage })),
    h('div', { class: 'col-md-6' }, input({ name: 'reason', label: t('Reason (audited)'), required: true })));
  const save = button(t('Save reminder'), { onClick: () => busy(save, async () => { const f = readForm(form); if (!f.reason) return toastError(new Error(t('A reason is required.'))); await mb.put('notifications/schedule-reminder', f); toast(t('Saved.')); reload(); }).catch(toastError) });
  return card({ cls: 'mt-3', title: t('Customer schedule reminders'), body: h('div', {}, h('p', { class: 'fs-xs text-muted', text: t('{d}Schedules by status: {c}. Preview: {p}', { d: rem.dryRun ? 'Dry run is on (REMINDER_DRY_RUN): reminders are recorded, not sent. ' : '', c: JSON.stringify(rem.counts), p: rem.preview.sw }) }), form, h('div', { class: 'mt-2' }, save),
    simpleTable([{ key: 'kind', label: t('Kind') }, { key: 'when_text', label: t('When') }, { key: 'status', label: t('Status'), render: (r) => badge(r.status) }, { key: 'reminder_kind', label: t('Sent as') }, { key: 'skip_reason', label: t('Reason') }], rem.recent)) });
}

function termsCard(terms, reload) {
  const st = terms.settings;
  const form = h('div', { class: 'row g-2' },
    h('div', { class: 'col-md-6' }, textarea({ name: 'textSw', label: t('Terms question (Swahili), keep {terms_url} and {privacy_url}'), value: st.textSw, rows: 3, maxlength: 1024 })),
    h('div', { class: 'col-md-6' }, textarea({ name: 'textEn', label: t('Terms question (English)'), value: st.textEn, rows: 3, maxlength: 1024 })),
    h('div', { class: 'col-md-2' }, input({ name: 'version', label: t('Version (a change asks everyone again)'), value: st.version, maxlength: 20 })),
    h('div', { class: 'col-md-2' }, input({ name: 'acceptSw', label: t('Accept button (sw)'), value: st.acceptSw, maxlength: 20 })),
    h('div', { class: 'col-md-2' }, input({ name: 'rejectSw', label: t('Reject button (sw)'), value: st.rejectSw, maxlength: 20 })),
    h('div', { class: 'col-md-6' }, input({ name: 'reason', label: t('Reason (audited)'), required: true })));
  const save = button(t('Save terms question'), { onClick: () => busy(save, async () => { const f = readForm(form); if (!f.reason) return toastError(new Error(t('A reason is required.'))); await mb.put('notifications/terms', f); toast(t('Saved.')); reload(); }).catch(toastError) });
  return card({ cls: 'mt-3', title: t('Terms and privacy question (asked before anyone is answered)'), body: h('div', {}, h('p', { class: 'fs-xs text-muted', text: t('Accepted / pending / rejected: {c}. Pages: {u} and {p}', { c: JSON.stringify(terms.counts), u: st.termsUrl, p: st.privacyUrl }) }), form, h('div', { class: 'mt-2' }, save), h('p', { class: 'fs-sm text-muted mt-2', text: terms.preview.sw.body })) });
}

function render(name, d, reload) {
  const mTable = (rows) => simpleTable([
    { key: 'businessName', label: t('Business'), render: (m) => h('a', { attrs: { href: '#' }, text: m.businessName, on: { click: (e) => { e.preventDefault(); merchantDrawer(m.id); } } }) },
    { key: 'registrationType', label: t('Type') }, { key: 'verificationStatus', label: t('Verification'), render: (m) => badge(m.verificationStatus) }, { key: 'status', label: t('Account'), render: (m) => badge(m.status) },
    { key: 'listings', label: t('Products'), align: 'end' }, { key: 'entitlements', label: t('Services'), render: (m) => m.entitlements.map((e) => `${e.service}: ${e.status}`).join(', ') || '—' },
    { key: '_', label: '', render: (m) => h('div', { class: 'd-flex gap-1' },
      m.verificationStatus === 'pending' ? button(t('Verify'), { size: 'sm', onClick: () => confirmAction({ title: t('Verify {b}', { b: m.businessName }), action: async (reason) => { await mb.post(`merchants/${m.id}/verification`, { decision: 'verified', reason }); reload(); } }) }) : null,
      m.verificationStatus === 'pending' ? button(t('Reject'), { size: 'sm', variant: 'secondary', onClick: () => confirmAction({ title: t('Reject {b}', { b: m.businessName }), requireReason: true, danger: true, action: async (reason) => { await mb.post(`merchants/${m.id}/verification`, { decision: 'rejected', reason }); reload(); } }) }) : null,
      m.status === 'active' ? button(t('Suspend'), { size: 'sm', variant: 'secondary', onClick: () => confirmAction({ title: t('Suspend {b}', { b: m.businessName }), requireReason: true, danger: true, action: async (reason) => { await mb.post(`merchants/${m.id}/status`, { status: 'suspended', reason }); reload(); } }) }) : button(t('Reactivate'), { size: 'sm', onClick: () => confirmAction({ title: t('Reactivate {b}', { b: m.businessName }), requireReason: true, action: async (reason) => { await mb.post(`merchants/${m.id}/status`, { status: 'active', reason }); reload(); } }) })) },
  ], rows, { empty: t('No merchants yet.') });

  switch (name) {
    case 'Insights': {
      // What customers asked for across MoranBuy, where, and what sold; Muse's reading when it is on, the plain numbers otherwise.
      const s = d.overview.stats;
      const kv = (rows, a, b) => simpleTable([{ key: a, label: t(a) }, { key: b, label: t(b) }], rows);
      return h('div', {}, card({ title: t(`Demand, last ${s.days} days (${d.overview.source === 'muse' ? 'read by Muse Spark' : 'from the numbers'})`), body: h('div', {}, h('p', { style: 'white-space: pre-line', text: d.overview.summary }), d.overview.actions.length ? h('ul', {}, ...d.overview.actions.map((a) => h('li', { text: a }))) : null) }),
        h('div', { class: 'row g-3 mt-1' },
          h('div', { class: 'col-lg-4' }, card({ title: t('Most asked products'), body: simpleTable([{ key: 'productType', label: t('Product') }, { key: 'asks', label: t('Asks') }, { key: 'customers', label: t('Customers') }, { key: 'avgBudget', label: t('Avg budget'), render: (r) => r.avgBudget ? money(r.avgBudget, 'TZS') : '' }], s.topProducts) })),
          h('div', { class: 'col-lg-4' }, card({ title: t('Where customers are'), body: simpleTable([{ key: 'region', label: t('Region') }, { key: 'district', label: t('District') }, { key: 'asks', label: t('Asks') }], s.byDistrict.length ? s.byDistrict : s.byRegion) })),
          h('div', { class: 'col-lg-4' }, card({ title: t('Best sellers'), body: simpleTable([{ key: 'name', label: t('Product') }, { key: 'orders', label: t('Orders') }, { key: 'revenue', label: t('Revenue'), render: (r) => money(r.revenue, 'TZS') }], s.bestSellers) }))),
        h('div', { class: 'row g-3 mt-1' },
          h('div', { class: 'col-lg-4' }, card({ title: t('Asked for but not found'), body: kv(s.unmetDemand, 'productType', 'asks') })),
          h('div', { class: 'col-lg-4' }, card({ title: t('Customer schedules (open)'), body: simpleTable([{ key: 'kind', label: t('Kind') }, { key: 'when_text', label: t('When') }, { key: 'due_at', label: t('Due'), render: (r) => r.due_at ? new Date(r.due_at).toLocaleDateString() : '' }, { key: 'region', label: t('Region') }, { key: 'business_name', label: t('Business') }], d.schedules) })),
          h('div', { class: 'col-lg-4' }, card({ title: t('Products sent by chat'), body: simpleTable([{ key: 'business_name', label: t('Business') }, { key: 'kind', label: t('Kind') }, { key: 'status', label: t('Status'), render: (r) => badge(r.status) }, { key: 'muse_status', label: t('Muse') }], d.uploads) }))));
    }
    case 'Overview': return h('div', { class: 'row g-3' }, Object.entries(d).map(([k, v]) => h('div', { class: 'col-md-4' }, card({ title: t(k), body: pre(v) }))));
    case 'Merchants': case 'Verification': return card({ title: t(name), body: mTable(d.merchants) });
    case 'Ranking': {
      const form = h('div', { class: 'row g-2 align-items-end' }, h('div', { class: 'col-md-3' }, input({ name: 'priceSimilarityPct', label: t('Price band % of budget'), type: 'number', value: d.policy.effective.priceSimilarityPct, step: 0.5 })), h('div', { class: 'col-md-3' }, input({ name: 'staleAfterDays', label: t('Stale after days'), type: 'number', value: d.policy.effective.staleAfterDays })), h('div', { class: 'col-md-3' }, input({ name: 'overBudgetShowPct', label: t('Show over budget up to %'), type: 'number', value: d.policy.effective.overBudgetShowPct })), h('div', { class: 'col-md-3' }, input({ name: 'reason', label: t('Reason (audited)'), required: true })));
      const save = button(t('Save policy'), { onClick: () => busy(save, async () => { const f = readForm(form); if (!f.reason) return toastError(new Error(t('A reason is required.'))); await mb.put('ranking/policy', f); toast(t('Policy saved.')); reload(); }).catch(toastError) });
      return h('div', {}, card({ title: t('Ranking policy (budget first, location second is fixed in code)'), body: h('div', {}, form, h('div', { class: 'mt-2' }, save)) }),
        card({ cls: 'mt-3', title: t('Recent matching runs'), body: simpleTable([{ key: 'created_at', label: t('When'), render: (r) => formatDateTime(r.created_at) }, { key: 'product', label: t('Product'), render: (r) => r.request_json.productType }, { key: 'budget', label: t('Budget'), render: (r) => money(r.request_json.maxBudget) }, { key: 'candidates', label: t('Candidates'), align: 'end' }, { key: 'ranked', label: t('Ranked'), align: 'end' }, { key: 'over_budget', label: t('Over'), align: 'end' }, { key: 'excluded', label: t('Excluded'), align: 'end' }, { key: 'muse_status', label: t('Muse') }], d.runs, { onRowClick: (r) => mb.get(`ranking/runs/${r.id}`).then((ev) => drawer({ title: t('Run evidence'), width: 'mo-drawer-wide', body: pre(ev) })).catch(toastError) }) }));
    }
    case 'Campaigns': case 'Outreach': return card({ title: t(name), body: simpleTable([{ key: 'businessName', label: t('Business') }, { key: 'name', label: t('Name') }, { key: 'status', label: t('Status'), render: (c) => badge(c.status) }, { key: 'dryRun', label: t('Dry run'), render: (c) => (c.dryRun ? t('yes') : t('no')) }, { key: 'counts', label: t('Queued / sent / failed / skipped'), render: (c) => `${c.counts.queued} / ${c.counts.sent} / ${c.counts.failed} / ${c.counts.skipped}` }, { key: 'gateResults', label: t('Gates'), render: (c) => Object.entries(c.gateResults || {}).map(([k, v]) => `${k}:${v.ok ? 'ok' : 'no'}`).join(' ') || '—' }, { key: '_', label: '', render: (c) => (c.status === 'dispatching' ? button(t('Pause'), { size: 'sm', variant: 'secondary', onClick: () => confirmAction({ title: t('Pause campaign'), requireReason: true, action: async (reason) => { await mb.post(`campaigns/${c.id}/pause`, { reason }); reload(); } }) }) : null) }], d.campaigns.filter((c) => (name === 'Campaigns' ? c.kind === 'campaign' : c.kind === 'new_product_outreach'))) });
    case 'Templates': return card({ title: t('Templates (status is what Meta told Moran)'), body: simpleTable([{ key: 'name', label: t('Name') }, { key: 'language', label: t('Language') }, { key: 'headerFormat', label: t('Header') }, { key: 'status', label: t('Status'), render: (x) => badge(x.status) }, { key: 'statusReason', label: t('Reason') }], d.templates) });
    case 'Follow-up': return h('div', { class: 'row g-3' }, h('div', { class: 'col-lg-6' }, card({ title: t('Leads'), body: simpleTable([{ key: 'business_name', label: t('Business') }, { key: 'phone', label: t('Customer') }, { key: 'state', label: t('State'), render: (l) => `${l.state}${l.stop_reason ? ` (${l.stop_reason})` : ''}` }, { key: 'attempts', label: t('Attempts'), render: (l) => `${l.attempts}/${l.max_attempts}` }], d.leads) })), h('div', { class: 'col-lg-6' }, card({ title: t('Tasks'), body: simpleTable([{ key: 'due_at', label: t('Due'), render: (x) => formatDateTime(x.due_at) }, { key: 'status', label: t('Status') }, { key: 'skip_reason', label: t('Reason') }, { key: 'dry_run', label: t('Dry run'), render: (x) => (x.dry_run ? t('yes') : t('no')) }], d.tasks) })));
    case 'Orders': return card({ title: t('Orders'), body: simpleTable([{ key: 'order_ref', label: t('Ref') }, { key: 'business_name', label: t('Business') }, { key: 'listing_name', label: t('Product') }, { key: 'known_total', label: t('Known total'), render: (o) => `${money(o.known_total, o.currency)}${o.total_confirmed ? '' : ` (${t('delivery not confirmed')})`}` }, { key: 'status', label: t('Status'), render: (o) => badge(o.status) }, { key: 'created_at', label: t('When'), render: (o) => formatDateTime(o.created_at) }], d.orders.orders) });
    case 'Notifications': {
      const st = d.settings;
      const form = h('div', { class: 'row g-2' },
        h('div', { class: 'col-md-6' }, textarea({ name: 'textSw', label: t('Message to the business owner (Swahili)'), value: st.textSw, rows: 3, maxlength: 1000 })),
        h('div', { class: 'col-md-6' }, textarea({ name: 'textEn', label: t('Message to the business owner (English)'), value: st.textEn, rows: 3, maxlength: 1000 })),
        h('div', { class: 'col-md-4' }, input({ name: 'templateName', label: t('Approved template on the MoranBuy number (blank: plain text)'), value: st.templateName, placeholder: 'moranbuy_order_alert', help: t('Needed when the owner has not written to MoranBuy in the last 24 hours; create and submit it on the MoranBuy business page → Templates with 6 body variables in this order: order ref, product, quantity, total, fulfilment, customer phone.') })),
        h('div', { class: 'col-md-2' }, input({ name: 'templateLanguage', label: t('Template language'), value: st.templateLanguage })),
        h('div', { class: 'col-md-6' }, input({ name: 'reason', label: t('Reason (audited)'), required: true })));
      const save = button(t('Save notification'), { onClick: () => busy(save, async () => { const f = readForm(form); if (!f.reason) return toastError(new Error(t('A reason is required.'))); await mb.put('notifications/order-confirmed', f); toast(t('Saved.')); reload(); }).catch(toastError) });
      return h('div', {}, card({ title: t('When a customer confirms an order, the business owner gets this on WhatsApp'), body: h('div', {}, h('p', { class: 'fs-xs text-muted', text: t('Placeholders: {p}', { p: d.placeholders.map((x) => `{${x}}`).join(' ') }) }), form, h('div', { class: 'mt-2' }, save), h('div', { class: 'mt-3 fs-sm' }, h('div', { class: 'fw-bold', text: t('Preview') }), h('div', { class: 'text-muted', text: d.preview.sw }), h('div', { class: 'text-muted', text: d.preview.en }))) }),
        card({ cls: 'mt-3', title: t('Recent alerts sent'), body: simpleTable([{ key: 'created_at', label: t('When'), render: (n) => formatDateTime(n.created_at) }, { key: 'business_name', label: t('Business') }, { key: 'kind', label: t('Kind') }, { key: 'status', label: t('Status'), render: (n) => badge(n.status) }, { key: 'skip_reason', label: t('Reason'), render: (n) => n.skip_reason || n.error || '' }], d.recent) }),
        reminderCard(d.reminder, reload),
        termsCard(d.terms, reload));
    }
    case 'Billing': {
      const form = h('div', { class: 'row g-2 align-items-end' }, h('div', { class: 'col-md-3' }, input({ name: 'providerUnitTzs', label: t('WhatsApp provider rate per message (TZS)'), type: 'number', value: d.pricing.effective.providerUnitTzs ?? '' })), h('div', { class: 'col-md-3' }, input({ name: 'serviceFeeUnitTzs', label: t('MoranBuy fee per message'), type: 'number', value: d.pricing.effective.serviceFeeUnitTzs })), h('div', { class: 'col-md-2' }, input({ name: 'taxPct', label: t('Tax %'), type: 'number', value: d.pricing.effective.taxPct })), h('div', { class: 'col-md-4' }, input({ name: 'reason', label: t('Reason (audited)'), required: true })));
      const save = button(t('Save pricing'), { onClick: () => busy(save, async () => { const f = readForm(form); if (!f.reason) return toastError(new Error(t('A reason is required.'))); await mb.put('pricing', f); toast(t('Pricing saved.')); reload(); }).catch(toastError) });
      // Monthly prices of the paid services; a blank price keeps a service off sale, and every change is audited.
      const sp = d.servicePricing.effective;
      const svcForm = h('div', { class: 'row g-2 align-items-end' }, ...['campaign_engine', 'new_product_outreach', 'paid_followup'].map((s) => h('div', { class: 'col-md-3' }, input({ name: s, label: t(`${s.replace(/_/g, ' ')} (TZS / ${sp[s]?.periodDays || 30} days)`), type: 'number', value: sp[s]?.monthlyTzs ?? '' }))), h('div', { class: 'col-md-3' }, input({ name: 'reason', label: t('Reason (audited)'), required: true })));
      const saveSvc = button(t('Save service prices'), { onClick: () => busy(saveSvc, async () => { const f = readForm(svcForm); if (!f.reason) return toastError(new Error(t('A reason is required.'))); const body = { reason: f.reason }; for (const s of ['campaign_engine', 'new_product_outreach', 'paid_followup']) body[s] = { monthlyTzs: f[s] === '' || f[s] === undefined ? null : Number(f[s]), periodDays: sp[s]?.periodDays || 30 }; await mb.put('service-pricing', body); toast(t('Service prices saved.')); reload(); }).catch(toastError) });
      return h('div', {}, card({ title: t('Campaign pricing'), body: h('div', {}, form, h('div', { class: 'mt-2' }, save)) }), card({ cls: 'mt-3', title: t('Service prices (monthly)'), body: h('div', {}, h('p', { class: 'text-muted small', text: t('A business pays this through Snippe (or the sandbox outside production); the service switches on only after the payment is verified. Leave a price blank to keep that service off sale.') }), svcForm, h('div', { class: 'mt-2' }, saveSvc)) }), card({ cls: 'mt-3', title: t('Payments'), body: simpleTable([{ key: 'business_name', label: t('Business') }, { key: 'purpose', label: t('Purpose') }, { key: 'provider', label: t('Provider') }, { key: 'reference', label: t('Reference') }, { key: 'amount', label: t('Amount'), render: (p) => money(p.amount, p.currency) }, { key: 'status', label: t('Status'), render: (p) => badge(p.status) }], d.payments) }));
    }
    case 'Muse Spark': {
      const c = d.credentials.muse;
      const form = h('div', { class: 'row g-2 align-items-end' },
        h('div', { class: 'col-md-2' }, select({ name: 'provider', label: t('Provider'), value: c.provider === 'disabled' && !c.apiKey.configured ? 'meta' : c.provider, options: [{ value: 'meta', label: 'Meta Model API' }, { value: 'openai-compatible', label: t('OpenAI-compatible host') }, { value: 'disabled', label: t('Disabled') }] })),
        h('div', { class: 'col-md-3' }, input({ name: 'baseUrl', label: t('Base URL'), value: c.baseUrl })), h('div', { class: 'col-md-2' }, input({ name: 'model', label: t('Model'), value: c.model })),
        h('div', { class: 'col-md-3' }, input({ name: 'apiKey', label: t('Muse Spark API key'), type: 'password', placeholder: c.apiKey.configured ? `…${c.apiKey.last4} (${t('blank keeps')})` : t('from dev.meta.ai'), maxlength: 400 })),
        h('div', { class: 'col-md-2' }, input({ name: 'reason', label: t('Reason (audited)'), required: true })));
      const save = button(t('Save and test'), { onClick: () => busy(save, async () => { const f = readForm(form); if (!f.reason) return toastError(new Error(t('A reason is required.'))); if (!f.apiKey) delete f.apiKey; await mb.put('credentials/muse', f); const r = await mb.post('muse/test', {}); toast(r.result === 'ok' ? t('Muse Spark answered: working.') : t('Muse Spark test: {r}', { r: r.code || r.result }), r.result === 'ok' ? 'success' : 'warning'); reload(); }).catch(toastError) });
      return h('div', {}, card({ title: t('Muse Spark API key (used within seconds, no restart)'), body: h('div', {}, form, h('div', { class: 'mt-2 d-flex gap-2 align-items-center' }, save, h('span', { class: 'fs-xs text-muted', text: c.apiKey.configured ? t('Key set (…{l}, source: {s})', { l: c.apiKey.last4, s: c.source }) : t('No key set') }))) }),
        card({ cls: 'mt-3', title: t('Status and telemetry (from real requests)'), body: pre({ status: d.muse.status, telemetry: d.muse.telemetry }) }),
        card({ cls: 'mt-3', title: t('Recent requests'), body: simpleTable([{ key: 'created_at', label: t('When'), render: (r) => formatDateTime(r.created_at) }, { key: 'feature', label: t('Feature') }, { key: 'model', label: t('Model') }, { key: 'status', label: t('Status') }, { key: 'latency_ms', label: t('ms'), align: 'end' }, { key: 'error_code', label: t('Error') }], d.muse.recent) }));
    }
    case 'Credentials': {
      const s = d.credentials.snippe; const hm = d.credentials.hermes;
      const sForm = h('div', { class: 'row g-2 align-items-end' }, h('div', { class: 'col-md-4' }, input({ name: 'apiKey', label: t('Snippe API key'), type: 'password', placeholder: s.apiKey.configured ? `…${s.apiKey.last4} (${t('blank keeps')})` : t('from /opt/moran-backend/.env'), maxlength: 400 })), h('div', { class: 'col-md-4' }, input({ name: 'webhookSecret', label: t('Snippe webhook secret'), type: 'password', placeholder: s.webhookSecret.configured ? t('set (blank keeps)') : '', maxlength: 400 })), h('div', { class: 'col-md-4' }, input({ name: 'reason', label: t('Reason (audited)'), required: true })));
      const sSave = button(t('Save Snippe'), { onClick: () => busy(sSave, async () => { const f = readForm(sForm); if (!f.reason) return toastError(new Error(t('A reason is required.'))); for (const k of ['apiKey', 'webhookSecret']) if (!f[k]) delete f[k]; await mb.put('credentials/snippe', f); toast(t('Snippe saved.')); reload(); }).catch(toastError) });
      const hForm = h('div', { class: 'row g-2 align-items-end' }, h('div', { class: 'col-md-3' }, input({ name: 'baseUrl', label: t('Hermes base URL (blank: plain fetch)'), value: hm.baseUrl || '' })), h('div', { class: 'col-md-3' }, input({ name: 'apiKey', label: t('Hermes API key'), type: 'password', placeholder: hm.apiKey.configured ? t('set (blank keeps)') : '', maxlength: 400 })), h('div', { class: 'col-md-3' }, input({ name: 'allowedDomains', label: t('Allowed shop domains'), value: hm.allowedDomains, maxlength: 2000 })), h('div', { class: 'col-md-3' }, input({ name: 'reason', label: t('Reason (audited)'), required: true })));
      const hSave = button(t('Save Hermes and enable research'), { onClick: () => busy(hSave, async () => { const f = readForm(hForm); if (!f.reason) return toastError(new Error(t('A reason is required.'))); if (!f.apiKey) delete f.apiKey; await mb.put('credentials/hermes', { ...f, enabled: !!f.allowedDomains }); toast(t('Hermes saved.')); reload(); }).catch(toastError) });
      return h('div', {}, card({ title: t('Snippe mobile money (the same account as Moran)'), body: h('div', {}, sForm, h('div', { class: 'mt-2' }, sSave), h('p', { class: 'fs-xs text-muted mt-2', text: t('Register the MoranBuy webhook URL with Snippe: {u}', { u: `${(d.credentials.snippe.baseUrl ? '' : '')}https://buy.moranai.co.tz/webhooks/payments` }) })) }), card({ cls: 'mt-3', title: t('Hermes research agent (optional)'), body: h('div', {}, hForm, h('div', { class: 'mt-2' }, hSave)) }));
    }
    case 'Retention': {
      // How long each kind of record is kept; a preview counts what would go, a purge deletes it and is audited.
      const keys = Object.keys(d.defaults);
      const form = h('div', { class: 'row g-2' }, ...keys.map((k) => h('div', { class: 'col-md-3' }, input({ name: k, label: t(`${k.replace(/Days$/, '').replace(/([A-Z])/g, ' $1').toLowerCase()} (days, min ${d.floors[k]})`), type: 'number', value: d.settings[k] }))), h('div', { class: 'col-md-6' }, input({ name: 'reason', label: t('Reason (audited)'), required: true })));
      const save = button(t('Save retention'), { onClick: () => busy(save, async () => { const f = readForm(form); if (!f.reason) return toastError(new Error(t('A reason is required.'))); const body = { reason: f.reason }; for (const k of keys) if (f[k] !== '' && f[k] !== undefined) body[k] = Number(f[k]); await mb.put('retention', body); toast(t('Saved.')); reload(); }).catch(toastError) });
      const run = (dryRun) => confirmAction({ title: dryRun ? t('Preview what would be removed') : t('Delete expired records now'), requireReason: true, danger: !dryRun, action: async (reason) => { await mb.post('retention/run', { dryRun, confirm: dryRun ? undefined : true, reason }); reload(); } });
      const res = (x) => x ? simpleTable([{ key: 'table', label: t('Records') }, { key: 'keepDays', label: t('Kept (days)') }, { key: 'expired', label: t('Expired') }, { key: 'removed', label: t('Removed') }], Object.entries(x.result).map(([table, v]) => ({ table, ...v }))) : h('p', { class: 'text-muted', text: t('Not run yet.') });
      return h('div', {}, card({ title: t('Retention'), body: h('div', {}, h('p', { class: 'fs-xs text-muted', text: t('{s}Never purged here: {n}.', { s: d.scheduledDryRun ? 'The scheduled purge runs every 6 hours in count-only mode (RETENTION_DRY_RUN=true). ' : 'The scheduled purge deletes expired records every 6 hours. ', n: d.neverPurged.join(', ') }) }), form, h('div', { class: 'mt-2 d-flex gap-2' }, save, button(t('Preview'), { variant: 'secondary', onClick: () => run(true) }), button(t('Purge now'), { variant: 'danger', onClick: () => run(false) }))) }),
        h('div', { class: 'row g-3 mt-1' }, h('div', { class: 'col-lg-6' }, card({ title: t('Last preview {w}', { w: d.lastPreview ? formatDateTime(d.lastPreview.ranAt) : '' }), body: res(d.lastPreview) })), h('div', { class: 'col-lg-6' }, card({ title: t('Last purge {w}', { w: d.lastRun ? formatDateTime(d.lastRun.ranAt) : '' }), body: res(d.lastRun) }))));
    }
    case 'Integration Health': {
      const pull = button(t('Pull opted-in Moran businesses now'), { onClick: () => busy(pull, async () => { const r = await mb.post('sync/moran-listings', {}); toast(r.ok ? t('Pulled: {m} businesses, {c} new, {u} updated', { m: r.merchants, c: r.created, u: r.updated }) : t('Pull failed: {s}', { s: r.status }), r.ok ? 'success' : 'warning'); reload(); }).catch(toastError) });
      return card({ title: t('Integration health'), right: pull, body: pre(d) });
    }
    case 'Audit': return card({ title: t('MoranBuy audit log'), body: simpleTable([{ key: 'created_at', label: t('When'), render: (e) => formatDateTime(e.created_at) }, { key: 'actor_type', label: t('Actor') }, { key: 'action', label: t('Action') }, { key: 'target_type', label: t('Target'), render: (e) => `${e.target_type || ''} ${e.target_id || ''}` }, { key: 'reason', label: t('Reason') }], d.events) });
    default: return pre(d);
  }
}

bootPage({
  key: 'moranbuy', title: 'MoranBuy', subtitle: 'The reverse marketplace: its WhatsApp business, merchants, ranking, campaigns, follow-up and Muse Spark.', perms: ['businesses.read'], range: false,
  async render(root) {
    const state = { autoOpen: new URLSearchParams(location.search).get('open') === '1' };
    const dash = h('div', { class: 'mt-4' });
    const setup = setupCard(state, () => { mount(dash, dashboard()); dash.scrollIntoView({ behavior: 'smooth' }); });
    root.append(setup.el, dash);
  },
});
