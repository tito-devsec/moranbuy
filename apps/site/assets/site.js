// MoranBuy public site: shared header and footer, scroll motion, live numbers and the WhatsApp links. No libraries.
(function () {
  const LOGO = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="12" fill="#0f766e"/><path d="M11 15h18l-1.7 13.3a2.2 2.2 0 0 1-2.2 1.9h-10.2a2.2 2.2 0 0 1-2.2-1.9z" fill="#fff"/><path d="M15.5 15v-1.6a4.5 4.5 0 0 1 9 0V15" stroke="#fff" stroke-width="2.2" fill="none"/><path d="M14 22.5c3.5 3 8.5 3 12 0" stroke="#22d3ee" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>';
  const here = location.pathname.replace(/\/+$/, '') || '/';
  const link = (href, label) => `<a href="${href}" class="${here === href ? 'on' : ''}">${label}</a>`;

  const header = document.querySelector('[data-site-header]');
  if (header) {
    header.outerHTML = `<header class="site-header"><div class="wrap nav">
      <a class="brand" href="/" aria-label="MoranBuy home">${LOGO}MoranBuy</a>
      <nav class="nav-links" id="nav-links">${link('/how-it-works', 'How it works')}${link('/for-business', 'For businesses')}${link('/demo', 'Try the demo')}${link('/about', 'About')}</nav>
      <div class="nav-cta"><a class="btn btn-ghost" href="/demo">Try the demo</a><a class="btn btn-primary" data-whatsapp href="https://wa.me/moranbuy" target="_blank" rel="noopener"><span class="long">Open MoranBuy</span><span class="arrow">→</span></a><button class="menu-btn" aria-label="Menu" aria-expanded="false">☰</button></div>
    </div></header>`;
  }
  const footer = document.querySelector('[data-site-footer]');
  if (footer) {
    footer.outerHTML = `<footer class="site-footer"><div class="wrap">
      <div class="foot-grid">
        <div><a class="brand" href="/">${LOGO}MoranBuy</a><p style="max-width:320px">Tell it what you want and what you can pay. A product of Moran AI, Dar es Salaam, built on Meta AI.</p></div>
        <div><h4>Product</h4><a href="/how-it-works">How it works</a><a href="/for-business">For businesses</a><a href="/demo">Try the demo</a><a href="/business/">Business sign-in</a></div>
        <div><h4>Company</h4><a href="/about">About</a><a href="/developers">Developers</a><a href="/contact">Contact</a></div>
        <div><h4>Legal</h4><a href="/terms">Terms of Use</a><a href="/privacy">Privacy Policy</a><a href="/copyright">Copyrights</a></div>
      </div>
      <div class="foot-bottom"><span>© ${new Date().getFullYear()} Moran AI. All rights reserved.</span><span>support@moranai.co.tz · +255 724 660 550 · <span class="foot-credit">Icons: <a href="https://www.flaticon.com/uicons" target="_blank" rel="noopener" style="display:inline">UIcons by Flaticon</a></span></span></div>
    </div></footer>`;
  }

  const head = document.querySelector('.site-header');
  const menu = document.querySelector('.menu-btn');
  if (menu) menu.addEventListener('click', () => { const nl = document.getElementById('nav-links'); const open = nl.classList.toggle('open'); menu.setAttribute('aria-expanded', String(open)); });
  // The header turns solid after the hero starts to scroll away, hides while scrolling down, comes back on the way up.
  let lastY = 0;
  const onScroll = () => {
    const y = window.scrollY;
    if (head) { head.classList.toggle('scrolled', y > 40); head.classList.toggle('hidden', y > 400 && y > lastY && !document.getElementById('nav-links')?.classList.contains('open')); }
    lastY = y;
    statement();
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  // Elements fade and slide in once, when a fifth of them is on screen; phones play their chat; tracks fill.
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('visible');
      if (e.target.matches('[data-chat]')) playChat(e.target);
      if (e.target.matches('[data-count], [data-stat]')) countUp(e.target);
      seen.unobserve(e.target);
    }
  }, { threshold: 0.2 });
  document.querySelectorAll('[data-reveal], [data-chat], .track, [data-count], [data-stat]').forEach((el) => { if (el.dataset.reveal !== undefined && !el.style.transitionDelay) el.style.transitionDelay = `${(Number(el.dataset.delay) || 0) * 0.12}s`; seen.observe(el); });

  function playChat(box) {
    [...box.querySelectorAll('.bubble')].forEach((b, i) => setTimeout(() => b.classList.add('show'), 350 + i * Number(box.dataset.chat || 900)));
  }

  // Numbers count up from zero with an easing curve; the target comes from data-count or the live stats.
  function countUp(el) {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target)) return;
    const prefix = el.dataset.prefix || ''; const suffix = el.dataset.suffix || '';
    const start = performance.now(); const dur = 1800;
    const step = (t) => { const p = Math.min(1, (t - start) / dur); const v = Math.round(target * (1 - Math.pow(1 - p, 4))); el.textContent = `${prefix}${v.toLocaleString('en-US')}${suffix}`; if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  // The statement halves start apart and meet in the middle as the section scrolls through.
  const st = document.querySelector('.statement');
  function statement() {
    if (!st || window.innerWidth <= 960) return;
    const r = st.getBoundingClientRect(); const total = r.height - window.innerHeight;
    const p = Math.min(1, Math.max(0, -r.top / total));
    const ease = 1 - Math.pow(1 - Math.min(1, p * 1.6), 3);
    const L = st.querySelector('.left'); const R = st.querySelector('.right'); const A = st.querySelector('.art');
    if (L) { L.style.transform = `translateX(${(1 - ease) * -18}vw)`; L.style.opacity = String(0.25 + ease * 0.75); }
    if (R) { R.style.transform = `translateX(${(1 - ease) * 18}vw)`; R.style.opacity = String(ease); }
    if (A) { A.style.transform = `scale(${0.6 + ease * 0.4})`; A.style.opacity = String(ease); }
  }

  // Glass cards drift a little with the pointer over the hero.
  const card = document.querySelector('.hero-card');
  if (card && matchMedia('(pointer: fine)').matches) {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width - 0.5; const y = (e.clientY - r.top) / r.height - 0.5;
      card.querySelectorAll('.glass').forEach((g, i) => { const k = (i + 1) * 8; g.style.translate = `${x * k}px ${y * k}px`; });
    });
  }

  // Live numbers: only what MoranBuy really has; a card with no number yet stays hidden.
  // The numbers section stays hidden unless at least one real number comes back.
  fetch('/api/public/stats').then((r) => (r.ok ? r.json() : null)).then((s) => {
    if (!s || !Object.values(s).some((v) => v !== null && v !== undefined)) return;
    document.querySelectorAll('[data-stats]').forEach((sec) => { sec.hidden = false; });
    document.querySelectorAll('[data-stat]').forEach((el) => {
      const v = s[el.dataset.stat];
      const card = el.closest('.stat');
      if (v === null || v === undefined) { if (card) card.style.display = 'none'; return; }
      el.dataset.count = String(v);
      if (el.classList.contains('visible')) countUp(el);
    });
  }).catch(() => {});

  // Every "Open MoranBuy" opens a WhatsApp chat with MoranBuy's username (@moranbuy), greeting already typed.
  fetch('/api/public/contact').then((r) => r.json()).then((c) => {
    if (!c.whatsapp?.link) return;
    document.querySelectorAll('[data-whatsapp]').forEach((a) => { a.href = `${c.whatsapp.link}?text=${encodeURIComponent('Hello MoranBuy')}`; a.target = '_blank'; a.rel = 'noopener'; });
  }).catch(() => {});

  // The hero text and route line start once fonts are ready, so nothing jumps.
  const go = () => requestAnimationFrame(() => document.documentElement.classList.add('loaded'));
  if (document.fonts?.ready) document.fonts.ready.then(go); else window.addEventListener('load', go);
  setTimeout(go, 1200);
  onScroll();
})();
