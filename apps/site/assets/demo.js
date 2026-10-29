// Try-the-demo page: talks to the sandbox API, shows each person's WhatsApp on the phone and streams the server log into the terminal.
(() => {
  const API = '/api/demo';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hhmm = (at) => new Date(at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const money = (n) => `TSh ${Number(n || 0).toLocaleString('en-US')}`;
  const STAGES = ['awaiting_payment', 'paid_held', 'deliverer_assigned', 'delivered', 'released'];
  const stage = () => STAGES.indexOf(st.order?.protection);

  let st;
  const fresh = () => ({ id: null, info: null, role: 'customer', order: null, ownerShop: null, busy: false, payDismissed: false,
    timeline: { customer: [], owner: [], rider: [] }, rendered: { customer: 0, owner: 0, rider: 0 }, unread: { customer: 0, owner: 0, rider: 0 },
    seen: new Set(), flags: {}, queue: [], all: [], warns: 0 });

  // WhatsApp text formatting: *bold*, _italic_, ~strike~, links and line breaks.
  function fmt(text) {
    return esc(text)
      .replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|\s)_([^_\n]+)_/g, '$1<i>$2</i>').replace(/~([^~\n]+)~/g, '<s>$1</s>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, '<br>');
  }

  // ---------- Developer panel: console rows, network table, filters ----------
  const out = $('term-out');
  const body = $('term-body');
  const net = $('net');
  const netRows = $('net-rows');
  const view = { tab: 'console', level: 'all', q: '' };
  const TABS = {
    console: () => true,
    models: (l) => ['muse', 'parse', 'rank'].includes(l.svc) || /mms|meta model/i.test(l.msg),
    money: (l) => ['payment', 'webhook', 'protect', 'payout', 'receipt'].includes(l.svc) || /payments\//.test(l.msg),
  };
  const LEVEL = { all: () => true, info: (l) => l.level === 'INFO', warn: (l) => ['WARN', 'ERROR'].includes(l.level), debug: (l) => l.level === 'DEBUG' };
  const shown = (l) => (l.cmd || ((TABS[view.tab] || TABS.console)(l) && LEVEL[view.level](l))) && (!view.q || `${l.svc} ${l.msg}`.toLowerCase().includes(view.q));
  const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const time = (at) => { const d = new Date(at); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`; };
  function rowEl(l) {
    const el = document.createElement('div');
    if (l.cmd) { el.className = 'row cmd'; el.innerHTML = `<span class="m">${esc(l.msg)}</span>`; return el; }
    const lv = String(l.level || 'INFO').toLowerCase();
    el.className = `row ${lv === 'info' ? '' : lv}`;
    const msg = esc(l.msg).replace(/(^|\s)([a-z_.]+)=/g, '$1<span class="k">$2=</span>');
    el.innerHTML = `<span class="m"><span class="tag">[${esc(l.svc)}]</span> ${msg}</span><span class="src">${time(l.at)}</span>`;
    return el;
  }
  // One Network row per request the server made or received; WhatsApp sends are recorded, not delivered, and say so.
  function netRow(l) {
    let m;
    if (l.svc === 'inbound' && (m = /^POST (\S+) (\d+) (\d+)ms .*kind=(\S+)/.exec(l.msg))) return [m[1], 'POST', m[2], `whatsapp ${m[4]}`, '', `${m[3]} ms`];
    if (l.svc === 'muse' && (m = /^POST (\S+) model=(\S+) feature=(\S+) (\S+) (\S+)ms/.exec(l.msg))) return [m[1], 'POST', m[4], `${m[2]} · ${m[3]}`, '', `${m[5]} ms`, m[4] !== '200'];
    if (l.svc === 'muse' && (m = /^feature=(\S+) model=(\S+) status=(\S+)/.exec(l.msg))) return [`${m[2]} · ${m[1]}`, 'POST', `(${m[3]})`, 'meta model', '', '', false, true];
    if (l.svc === 'sandbox' && (m = /-> POST (\S+) (\d+) (\d+)ms/.exec(l.msg))) return [m[1], 'POST', m[2], 'mobile money', '', `${m[3]} ms`];
    if (l.svc === 'webhook' && (m = /^(\S+) ref=(\S+)/.exec(l.msg))) return ['/api/payments/webhook', 'POST', '200', m[1], '', ''];
    if (l.svc === 'outbound' && (m = /^(.+?) -> (\S+)(?: (\d+\w*B))?/.exec(l.msg))) return ['/internal/moranbuy/send', 'POST', 'recorded', m[1], m[3] || '', '', false, true];
    if (l.svc === 'payout' && (m = /provider=(\S+) .*status=(\S+)/.exec(l.msg))) return ['payout', 'POST', m[2], m[1], '', ''];
    return null;
  }
  function addNet(l) {
    const r = netRow(l); if (!r) return;
    const stick = nearBottom(net);
    const tr = document.createElement('tr');
    tr.innerHTML = r.slice(0, 6).map((v, k) => `<td class="${k === 2 && r[6] ? 'bad' : r[7] && k === 2 ? 'dim' : ''}" title="${esc(v)}">${esc(v)}</td>`).join('');
    netRows.appendChild(tr);
    if (stick) net.scrollTop = net.scrollHeight;
  }
  function write(l) {
    st.all.push(l); if (st.all.length > 3000) st.all.shift();
    if (l.level === 'WARN' || l.level === 'ERROR') { st.warns += 1; $('dt-warn-n').textContent = st.warns; $('dt-errs').hidden = false; }
    addNet(l);
    if (!shown(l)) return;
    const stick = nearBottom(body);
    out.appendChild(rowEl(l));
    while (out.childNodes.length > 1500) out.removeChild(out.firstChild);
    if (stick) body.scrollTop = body.scrollHeight;
  }
  function redraw() {
    out.textContent = '';
    const frag = document.createDocumentFragment();
    for (const l of st.all.filter(shown).slice(-1500)) frag.appendChild(rowEl(l));
    out.appendChild(frag); body.scrollTop = body.scrollHeight;
  }
  let pumping = false;
  async function pump() {
    if (pumping) return; pumping = true;
    while (st.queue.length) {
      const batch = st.queue.length > 30 ? 4 : 1;
      for (const l of st.queue.splice(0, batch)) write(l);
      await sleep(st.queue.length > 30 ? 8 : 26);
    }
    pumping = false;
  }
  const log = (lines) => { st.queue.push(...lines); pump(); };
  $('term-clear').addEventListener('click', () => { st.all = []; out.textContent = ''; netRows.textContent = ''; st.warns = 0; $('dt-errs').hidden = true; });
  document.querySelectorAll('.dt-tabs button').forEach((b) => b.addEventListener('click', () => {
    view.tab = b.dataset.tab;
    document.querySelectorAll('.dt-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    body.hidden = view.tab === 'network'; net.hidden = view.tab !== 'network';
    if (view.tab === 'network') net.scrollTop = net.scrollHeight; else redraw();
  }));
  $('dt-level').addEventListener('change', (e) => { view.level = e.target.value; redraw(); });
  $('dt-q').addEventListener('input', (e) => { view.q = e.target.value.trim().toLowerCase(); redraw(); });

  // ---------- Phone ----------
  const chat = $('chat');
  function toast(text) { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3600); }
  const tick = '<i class="fi fi-rr-check-double"></i>';
  const receiptUrl = () => `${API}/session/${st.id}/receipt`;

  function bubble(item) {
    const m = item.m;
    const wrap = document.createElement('div');
    wrap.style.display = 'contents';
    if (item.kind === 'sys') { wrap.innerHTML = `<div class="sys">${esc(item.text)}</div>`; return wrap; }
    if (item.kind === 'out') {
      if (item.type === 'image') wrap.innerHTML = `<div class="msg out photo-msg"><img src="${item.src}" alt="Photo sent"><span class="meta">${hhmm(item.at)} ${tick}</span></div>`;
      else if (item.type === 'voice') wrap.innerHTML = `<div class="msg out"><div class="dvoice"><span class="avatar"><i class="fi fi-sr-microphone"></i></span><button type="button" disabled><i class="fi fi-sr-play"></i></button><span class="wave">${waveBars(item.seed || 3, 1)}</span></div><span class="meta">${hhmm(item.at)} ${tick}</span></div>`;
      else wrap.innerHTML = `<div class="msg out">${fmt(item.text)}<span class="meta">${hhmm(item.at)} ${tick}</span></div>`;
      return wrap;
    }
    const meta = `<span class="meta">${hhmm(m.at)}</span>`;
    const text = m.body || (m.type === 'template' ? templateText(m) : '');
    if (m.type === 'document') {
      wrap.innerHTML = `<div class="msg in"><a class="doc" href="${receiptUrl()}" target="_blank" rel="noopener"><span class="ic">PDF</span><span><b>${esc(m.filename || 'receipt.pdf')}</b><small>PDF · tap to open</small></span></a>${text ? fmt(text) : ''}${meta}</div>`;
    } else if (m.audio) {
      wrap.innerHTML = `<div class="msg in"><div class="dvoice"><button type="button" aria-label="Play"><i class="fi fi-sr-play"></i></button><span class="wave">${waveBars(m.seq, 0)}</span><span class="avatar"><i class="fi fi-sr-microphone"></i></span></div>${meta}</div>`;
      wireVoice(wrap, m.seq);
    } else if (m.type === 'list') {
      wrap.innerHTML = `<div class="msg in">${fmt(text)}${m.footer ? `<span class="foot">${esc(m.footer)}</span>` : ''}${meta}<div class="list-btn"><i class="fi fi-rr-list"></i>${esc(m.button || 'Chagua')}</div></div>`;
      wrap.querySelector('.list-btn').addEventListener('click', () => openSheet(item));
    } else {
      const btns = m.buttons?.length ? m.buttons : null;
      wrap.innerHTML = `<div class="msg in${btns ? ' has-btns' : ''}">${fmt(text)}${m.footer ? `<span class="foot">${esc(m.footer)}</span>` : ''}${meta}</div>${btns ? `<div class="wa-btns">${btns.map((b) => `<button type="button" data-id="${esc(b.id)}"${item.used ? ' disabled' : ''}><i class="fi fi-rr-arrow-turn-down-left"></i>${esc(b.title)}</button>`).join('')}</div>` : ''}`;
      wrap.querySelectorAll('.wa-btns button').forEach((el) => el.addEventListener('click', () => {
        if (item.used || st.busy) return;
        pressButton(item, el.dataset.id, el.textContent.trim());
      }));
    }
    return wrap;
  }
  function templateText(m) {
    const params = (m.components || []).flatMap((c) => (c.parameters || []).map((p) => p.text).filter(Boolean));
    return `${m.templateName}${params.length ? `\n${params.join('\n')}` : ''}`;
  }
  function waveBars(seed, played) {
    let x = Number(seed) * 9301 + 49297; const bars = [];
    for (let i = 0; i < 28; i += 1) { x = (x * 9301 + 49297) % 233280; bars.push(`<i style="height:${30 + Math.round((x / 233280) * 70)}%"${played ? ' class="p"' : ''}></i>`); }
    return bars.join('');
  }
  function wireVoice(wrap, seq) {
    const btn = wrap.querySelector('.dvoice button'); let audio;
    btn.addEventListener('click', () => {
      if (!audio) {
        audio = new Audio(`${API}/session/${st.id}/audio/${seq}`);
        const bars = [...wrap.querySelectorAll('.wave i')];
        audio.addEventListener('timeupdate', () => { const k = Math.round((audio.currentTime / (audio.duration || 1)) * bars.length); bars.forEach((b, i) => b.classList.toggle('p', i < k)); });
        audio.addEventListener('ended', () => { btn.innerHTML = '<i class="fi fi-sr-play"></i>'; });
        audio.addEventListener('error', () => toast('This browser cannot play Ogg Opus voice notes. Chrome, Edge and Firefox can.'));
      }
      if (audio.paused) { audio.play().catch(() => {}); btn.innerHTML = '<i class="fi fi-sr-pause"></i>'; } else { audio.pause(); btn.innerHTML = '<i class="fi fi-sr-play"></i>'; }
    });
  }
  function openSheet(item) {
    const m = item.m;
    $('sheet-title').textContent = m.button || 'Chagua';
    const rows = (m.sections || []).flatMap((s) => s.rows || []);
    $('sheet-rows').innerHTML = rows.map((r) => `<button type="button" data-id="${esc(r.id)}">${esc(r.title)}${r.description ? `<small>${esc(r.description)}</small>` : ''}</button>`).join('');
    $('sheet-rows').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { $('sheet').hidden = true; send(st.role, { buttonId: b.dataset.id, buttonTitle: b.firstChild.textContent }, { type: 'text', text: b.firstChild.textContent }); }));
    $('sheet').hidden = false;
  }
  $('sheet-close').addEventListener('click', () => { $('sheet').hidden = true; });

  function emptyNote(role) {
    if (role === 'owner' && !st.order) return 'No order yet. The shop owner sees orders here once the customer places one.';
    if (role === 'rider' && stage() < 2) return 'The shop owner names the rider after the customer has paid. The rider then gets this order here.';
    return null;
  }
  function renderChat(full) {
    const role = st.role; const list = st.timeline[role];
    if (full) {
      chat.innerHTML = '<div class="day">Today</div><div class="sys">Sandbox: messages go to MoranBuy\'s real code on a test server and are shown here instead of WhatsApp. No real numbers or money.</div>';
      const note = emptyNote(role); if (note && !list.length) chat.insertAdjacentHTML('beforeend', `<div class="sys">${esc(note)}</div>`);
      chat.classList.add('noanim'); st.rendered[role] = 0;
    }
    for (let i = st.rendered[role]; i < list.length; i += 1) chat.appendChild(bubble(list[i]));
    st.rendered[role] = list.length;
    requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; chat.classList.remove('noanim'); });
  }
  function typing(on) {
    chat.querySelector('.typing')?.remove();
    if (on) { chat.insertAdjacentHTML('beforeend', '<div class="typing"><i></i><i></i><i></i></div>'); chat.scrollTop = chat.scrollHeight; }
  }
  function setRole(role) {
    st.role = role; st.unread[role] = 0;
    document.querySelectorAll('[data-role]').forEach((b) => b.classList.toggle('on', b.dataset.role === role));
    $('wa-sub').textContent = role === 'owner' ? `${st.ownerShop || 'Shop owner'} · business account` : role === 'rider' ? 'Rider · business account' : 'business account';
    badges(); renderChat(true); maybePay();
  }
  function badges() {
    document.querySelectorAll('[data-role]').forEach((b) => { const n = st.unread[b.dataset.role]; const el = b.querySelector('.badge'); if (el) { el.hidden = !n; el.textContent = n; } });
  }
  document.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => setRole(b.dataset.role)));

  // ---------- Talking to the sandbox ----------
  async function call(path, opts = {}) {
    const res = await fetch(`${API}${path}`, { method: opts.body ? 'POST' : (opts.method || 'GET'), headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || data?.message || `HTTP ${res.status}`), { status: res.status, code: data?.error?.code || data?.code });
    return data;
  }
  function ingest(r) {
    if (r.lines) {
      for (const l of r.lines) {
        if (l.svc === 'terms') st.flags.terms = true;
        if (l.svc === 'rank') st.flags.ranked = true;
        if (/state=selected/.test(l.msg)) st.flags.selected = true;
        if (/^arrived actor=deliverer/.test(l.msg)) st.flags.arrived = true;
        if (/^photo actor=deliverer/.test(l.msg)) st.flags.photo = true;
      }
      log(r.lines);
    }
    if ('order' in r) st.order = r.order;
    if (r.ownerShop) st.ownerShop = r.ownerShop;
    for (const role of ['customer', 'owner', 'rider']) {
      for (const m of r[role] || []) {
        const key = `${role}:${m.seq}`;
        if (st.seen.has(key)) continue;
        st.seen.add(key); st.timeline[role].push({ kind: 'in', m });
        if (role !== st.role) st.unread[role] += 1;
      }
    }
    if (st.role === 'owner' || st.role === 'rider') $('wa-sub').textContent = st.role === 'owner' ? `${st.ownerShop || 'Shop owner'} · business account` : 'Rider · business account';
    badges(); renderChat(false); steps(); maybePay(); links();
  }
  async function act(role, path, payload, local) {
    if (st.busy) return false;
    st.busy = true; $('send').disabled = true;
    if (local) { st.timeline[role].push({ kind: 'out', at: new Date().toISOString(), ...local }); if (role === st.role) renderChat(false); }
    if (role === st.role) setTimeout(() => st.busy && typing(true), 350);
    try {
      ingest(await call(`/session/${st.id}${path}`, { body: payload || {} }));
      return true;
    } catch (e) {
      if (e.status === 404 && e.code !== 'NO_RECEIPT') { toast('This sandbox session expired. Starting a new one.'); await start(); return false; }
      if (e.status === 429) toast('Too many actions in a minute. Wait a moment and try again.');
      else toast(e.message || 'The sandbox did not answer.');
      log([{ at: new Date().toISOString(), level: 'WARN', svc: 'client', msg: `${path.split('/')[1] || 'request'} failed: ${e.code || e.status || 'network'} ${e.message}` }]);
      return false;
    } finally { typing(false); st.busy = false; $('send').disabled = false; }
  }
  const send = (role, payload, local) => act(role, '/send', { role, ...payload }, local);
  function pressButton(item, id, title) {
    item.used = true;
    chat.querySelectorAll(`.wa-btns button[data-id="${CSS.escape(id)}"]`).forEach((b) => b.parentElement.querySelectorAll('button').forEach((x) => { x.disabled = true; }));
    return send(st.role, { buttonId: id, buttonTitle: title }, { type: 'text', text: title });
  }

  // Composer: text, photo, and the microphone sends a Swahili voice note made with Meta MMS-TTS.
  const input = $('msg');
  input.addEventListener('input', () => { $('send-icon').className = input.value.trim() ? 'fi fi-sr-paper-plane-top' : 'fi fi-sr-microphone'; });
  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return voice();
    input.value = ''; input.dispatchEvent(new Event('input'));
    await send(st.role, { text }, { type: 'text', text });
  });
  async function voice() {
    if (st.role !== 'customer') return toast('Voice notes are set up for the customer in this demo.');
    if (!st.info?.voice) return toast('Voice is not installed on this sandbox server.');
    await act('customer', '/voice', {}, { type: 'voice', seed: Date.now() % 97 });
  }
  $('file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const { src, base64 } = await shrink(f);
    await act(st.role, '/photo', { role: st.role, base64 }, { type: 'image', src });
  });
  async function shrink(file) {
    const img = await createImageBitmap(file);
    const k = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const src = c.toDataURL('image/jpeg', 0.85);
    return { src, base64: src.split(',')[1] };
  }
  // The same picture the server makes when no photo is given: a blender jar on its base.
  function samplePhotoSrc() {
    const c = document.createElement('canvas'); c.width = 480; c.height = 360; const g = c.getContext('2d');
    g.fillStyle = '#ece8e2'; g.fillRect(0, 0, 480, 360); g.fillStyle = '#c8e1eb'; g.fillRect(181, 61, 119, 189); g.fillStyle = '#1e2228'; g.fillRect(161, 251, 159, 59);
    return c.toDataURL('image/jpeg', 0.9);
  }

  // Sandbox mobile money prompt, shown on the customer's phone while a payment is waiting.
  function maybePay() {
    const show = st.role === 'customer' && st.order?.protection === 'awaiting_payment' && !st.payDismissed && !st.busy;
    if (show) { $('pay-text').textContent = `MoranBuy is requesting ${money(st.order.payment?.amount ?? st.order.total)} for order ${st.order.ref}. The money is held until you confirm delivery. Enter your PIN to pay.`; document.querySelectorAll('.pin span').forEach((s) => s.classList.remove('f')); }
    $('paybox').hidden = !show;
  }
  $('pay-cancel').addEventListener('click', () => { st.payDismissed = true; maybePay(); toast('Payment cancelled. Use the walkthrough step to bring the prompt back.'); });
  $('pay-ok').addEventListener('click', () => pay());
  async function pay() {
    if (st.busy) return false;
    st.payDismissed = false; if (st.role !== 'customer') setRole('customer'); maybePay();
    for (const s of document.querySelectorAll('.pin span')) { s.classList.add('f'); await sleep(140); }
    await sleep(200); $('paybox').hidden = true;
    return act('customer', '/pay', {});
  }

  function links() {
    const has = !!st.order?.receipt;
    $('guide-links').hidden = !has;
    if (has) $('open-receipt').href = receiptUrl();
  }
  $('open-verify').addEventListener('click', async (e) => {
    e.preventDefault();
    const w = window.open('', '_blank');
    try { const { path } = await call(`/session/${st.id}/verify`); if (w) w.location = path; else location.href = path; } catch (err) { if (w) w.close(); toast(err.message); }
  });

  // ---------- Walkthrough ----------
  const lastIn = (role, test) => [...st.timeline[role]].reverse().find((i) => i.kind === 'in' && test(i.m))?.m;
  const handoverCode = () => { for (const i of [...st.timeline.customer].reverse()) { const k = /(?:makabidhiano|handover code):\s*([A-Z0-9]{6})/.exec(i.m?.body || ''); if (k) return k[1]; } return null; };
  async function typeAndSend(role, text) {
    if (st.role !== role) { setRole(role); await sleep(450); }
    input.focus({ preventScroll: true });
    const step = Math.max(8, Math.min(28, 1100 / text.length));
    for (let i = 1; i <= text.length; i += 1) { input.value = text.slice(0, i); await sleep(step); }
    input.dispatchEvent(new Event('input')); await sleep(250);
    input.value = ''; input.dispatchEvent(new Event('input'));
    return send(role, { text }, { type: 'text', text });
  }
  async function tapButton(role, idTest, fallbackTitle) {
    if (st.role !== role) { setRole(role); await sleep(450); }
    const item = [...st.timeline[role]].reverse().find((i) => i.kind === 'in' && i.m.buttons?.some((b) => idTest(b.id)));
    const b = item?.m.buttons.find((x) => idTest(x.id));
    if (!b) return send(role, { text: fallbackTitle }, { type: 'text', text: fallbackTitle });
    const el = chat.querySelector(`.wa-btns button[data-id="${CSS.escape(b.id)}"]`);
    if (el) { el.style.background = '#e7f6f2'; await sleep(300); }
    return pressButton(item, b.id, b.title);
  }
  const live = () => st.info?.museLive;
  const STEPS = [
    { who: 'customer', t: 'Say hello', d: () => 'A new number gets the terms first, with two reply buttons. Nothing else is stored until they are accepted.',
      done: () => st.timeline.customer.some((i) => i.kind === 'in'), run: () => typeAndSend('customer', 'Habari') },
    { who: 'customer', t: 'Accept the terms', d: () => 'The acceptance is saved with the terms version, then MoranBuy asks what they need.',
      done: () => !!st.flags.terms, run: () => tapButton('customer', (id) => id === 'terms_accept', 'Nakubali') },
    { who: 'customer', t: 'Ask with a budget', d: () => `Product, budget, place and delivery in one Swahili sentence. ${live() ? 'Muse Spark 1.3 reads it' : 'There is no Meta key on this sandbox, so the rules parser reads it'}; the ranking puts offers within budget first, then by total price and distance.`,
      done: () => !!st.flags.ranked, run: () => typeAndSend('customer', 'Nina elfu tisini, nataka blenda, nipo Sinza Mori, niletewe') },
    { who: 'customer', t: 'Choose an offer', d: () => 'Reply with the offer number. The over-budget offer is listed separately and never ranked first.',
      done: () => !!st.flags.selected || !!st.order, run: () => typeAndSend('customer', '1') },
    { who: 'customer', t: 'Confirm the order', d: () => 'A yes places the order, and the shop gets it on WhatsApp at once.',
      done: () => !!st.order, run: () => typeAndSend('customer', 'ndio') },
    { who: 'owner', t: 'Shop accepts', d: () => 'The owner accepts with one reply. MoranBuy then asks the customer to pay MoranBuy, not the shop.',
      done: () => stage() >= 0, run: () => { const m = lastIn('owner', (x) => /KUBALI/.test(x.body || '')); return typeAndSend('owner', `KUBALI ${st.order.ref}${/ongeza ada|add the delivery fee/i.test(m?.body || '') ? ' 5000' : ''}`); } },
    { who: 'customer', t: 'Pay, money held', d: () => 'The sandbox mobile money prompt. The payment webhook is verified, the money is held, and the customer gets a receipt PDF and a handover code.',
      done: () => stage() >= 1, run: async () => { if (st.role !== 'customer') { setRole('customer'); await sleep(450); } st.payDismissed = false; maybePay(); await sleep(900); return pay(); } },
    { who: 'owner', t: 'Shop names the rider', d: () => 'The owner sends the rider\'s number by WhatsApp. The rider gets buttons for this order only.',
      done: () => stage() >= 2, run: () => typeAndSend('owner', `MSAFIRISHAJI ${st.order.ref} ${st.info.riderNumber} Baraka`) },
    { who: 'rider', t: 'Rider arrives', d: () => 'The rider taps Arrived at the customer\'s door.',
      done: () => !!st.flags.arrived || stage() >= 3, run: () => tapButton('rider', (id) => id.startsWith('dlv:arrived:'), 'Nimefika') },
    { who: 'rider', t: 'Photo at the door', d: () => `The photo is fingerprinted so an old or catalogue photo is caught${live() ? ', and Muse Spark with SAM 3.1 checks it shows the ordered product' : ''}.`,
      done: () => !!st.flags.photo || stage() >= 3, run: async () => { if (st.role !== 'rider') { setRole('rider'); await sleep(450); } return act('rider', '/photo', { role: 'rider' }, { type: 'image', src: samplePhotoSrc() }); } },
    { who: 'rider', t: 'Customer gives the code', d: () => 'The customer checks the product and gives the rider the code. Only its hash is stored, and three wrong tries lock it.',
      done: () => stage() >= 3, run: () => { const c = handoverCode(); if (!c) { toast('The code is in the customer\'s chat after payment.'); return false; } return typeAndSend('rider', c); } },
    { who: 'customer', t: 'Customer confirms', d: () => 'Confirming receipt pays the shop\'s mobile money at once; without it the money is released 48 hours after the code.',
      done: () => stage() >= 4, run: () => typeAndSend('customer', `NIMEPOKEA ${st.order.ref}`) },
  ];
  const WHO = { customer: 'Customer', owner: 'Shop owner', rider: 'Rider' };
  const current = () => STEPS.findIndex((s) => !s.done());
  function steps() {
    const now = current();
    $('steps').innerHTML = STEPS.map((s, i) => `<li class="${s.done() ? 'done' : i === now ? 'now' : ''}"><span class="n">${s.done() ? '&#10003;' : i + 1}</span><span>${esc(s.t)}</span><span class="w">${WHO[s.who]}</span></li>`).join('');
    const step = STEPS[now];
    $('step-who').textContent = step ? `Step ${now + 1} · ${WHO[step.who]}` : 'Done';
    $('step-title').textContent = step ? step.t : 'The order is complete and the shop is paid.';
    $('step-desc').textContent = step ? step.d() : 'Open the receipt, scan or open its check page, or start a new session and try a refusal: as the rider, report the product as refused instead of entering the code.';
    const next = document.querySelector('.demo-menu .next');
    if (next) next.innerHTML = step ? `Next: <b>${esc(step.t)}</b> (${WHO[step.who]})` : '<b>Order complete.</b> The shop is paid.';
    const done = STEPS.filter((s) => s.done()).length;
    $('guide-count').textContent = `${done} / ${STEPS.length}`;
    $('do-step').disabled = now < 0; $('run-all').disabled = now < 0;
    $('do-step').querySelector('span').textContent = now < 0 ? 'Complete' : 'Do this step';
    const list = $('steps'); const el = list.querySelector('.now');
    if (el) list.scrollTop = el.offsetTop - list.offsetTop - 40;
  }
  let running = false;
  async function doStep() {
    const i = current(); if (i < 0 || st.busy) return false;
    const ok = await STEPS[i].run();
    return ok !== false && current() !== i;
  }
  $('do-step').addEventListener('click', () => doStep());
  $('run-all').addEventListener('click', async () => {
    if (running) { running = false; return; }
    running = true; $('run-all').textContent = 'Stop';
    while (running && current() >= 0) { if (!(await doStep())) break; await sleep(1100); }
    running = false; $('run-all').textContent = 'Run all';
  });

  // ---------- On a phone: roles and the walkthrough live in the site menu ----------
  const navLinks = document.getElementById('nav-links');
  if (navLinks) {
    navLinks.insertAdjacentHTML('beforeend', `<div class="demo-menu"><h5>Whose phone</h5><div class="roles-m"><button type="button" data-role="customer" class="on">Customer<b class="badge" hidden></b></button><button type="button" data-role="owner">Shop<b class="badge" hidden></b></button><button type="button" data-role="rider">Rider<b class="badge" hidden></b></button></div><h5>Walkthrough</h5><p class="next"></p><div class="acts"><button type="button" class="act primary" data-act="step">Do next step</button><button type="button" class="act" data-act="all">Run all</button><button type="button" class="act" data-act="new">New</button></div></div>`);
    const close = () => { navLinks.classList.remove('open'); document.querySelector('.menu-btn')?.setAttribute('aria-expanded', 'false'); };
    navLinks.querySelectorAll('.demo-menu [data-role]').forEach((b) => b.addEventListener('click', () => { setRole(b.dataset.role); close(); }));
    navLinks.querySelector('[data-act=step]').addEventListener('click', () => { close(); doStep(); });
    navLinks.querySelector('[data-act=all]').addEventListener('click', () => { close(); $('run-all').click(); });
    navLinks.querySelector('[data-act=new]').addEventListener('click', () => { close(); running = false; start(); });
  }
  // On a desktop the phone is scaled to fit the window; on a phone the chat fills the screen.
  const phone = $('phone');
  function fit() {
    if (window.innerWidth <= 960) { phone.style.transform = ''; return; }
    const box = phone.parentElement;
    const k = Math.min(1, (box.clientHeight - 36) / 800, (box.clientWidth - 36) / 390);
    phone.style.transform = `scale(${k.toFixed(3)})`;
  }
  window.addEventListener('resize', fit); fit();
  setInterval(() => { $('clock').textContent = hhmm(); }, 10000); $('clock').textContent = hhmm();

  // ---------- Session ----------
  async function start() {
    const keep = $('dt-preserve').checked && st;
    const old = st?.queue || [];
    st = fresh(); st.queue = old;
    if (keep) { st.all = keep.all; st.warns = keep.warns; } else { out.textContent = ''; netRows.textContent = ''; $('dt-errs').hidden = true; }
    $('st-info').textContent = 'connecting';
    for (let attempt = 1; ; attempt += 1) {
      try {
        const s = await call('/session', { body: {} });
        st.id = s.sessionId; st.info = s;
        $('st-info').textContent = `db=moranbuy_demo whatsapp=recording payments=sandbox meta=${s.museLive ? 'live' : 'rules-fallback'} voice=${s.voice ? 'mms-tts' : 'off'}`;
        log(s.lines);
        break;
      } catch (e) {
        log([{ at: new Date().toISOString(), level: 'ERROR', svc: 'client', msg: `POST /api/demo/session ${e.status || 'network error'}: ${e.message}; retrying in ${Math.min(30, attempt * 5)}s` }]);
        await sleep(Math.min(30, attempt * 5) * 1000);
      }
    }
    setRole('customer'); steps(); links();
  }
  $('reset').addEventListener('click', () => { running = false; start(); });
  start();
})();
