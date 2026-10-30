// MoranBuy public site: shared header and footer, scroll motion, live numbers and the WhatsApp links. No libraries.
(function () {
  // The Moran AI mark, the same scribble as the favicon, in Moran green.
  const LOGO = '<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="#00d17a" fill-rule="evenodd" d="M119.0 31.0Q123.0 32.0 126.0 35.0Q129.0 38.0 130.0 43.0Q131.0 48.0 127.5 61.5Q124.0 75.0 113.5 95.5Q103.0 116.0 104.5 115.0Q106.0 114.0 106.5 112.0Q107.0 110.0 111.5 105.0Q116.0 100.0 116.5 98.0Q117.0 96.0 120.5 92.5Q124.0 89.0 124.0 88.0Q124.0 87.0 130.5 80.0Q137.0 73.0 138.5 72.5Q140.0 72.0 140.5 70.5Q141.0 69.0 142.0 69.0Q143.0 69.0 148.5 64.5Q154.0 60.0 157.0 59.0Q160.0 58.0 165.5 58.5Q171.0 59.0 174.5 62.0Q178.0 65.0 179.0 68.0Q180.0 71.0 180.0 77.0Q180.0 83.0 177.0 94.0Q174.0 105.0 171.0 110.5Q168.0 116.0 172.0 115.0Q176.0 114.0 181.5 114.5Q187.0 115.0 191.0 118.0Q195.0 121.0 196.5 124.5Q198.0 128.0 198.0 137.5Q198.0 147.0 197.0 151.5Q196.0 156.0 190.5 168.0Q185.0 180.0 187.0 179.0Q189.0 178.0 193.5 172.5Q198.0 167.0 199.0 167.0Q200.0 167.0 200.0 166.0Q200.0 165.0 203.5 162.0Q207.0 159.0 207.0 158.0Q207.0 157.0 209.0 155.0Q211.0 153.0 216.5 153.0Q222.0 153.0 225.0 155.5Q228.0 158.0 229.0 160.0Q230.0 162.0 229.5 166.5Q229.0 171.0 215.0 186.0Q201.0 201.0 200.0 201.0Q199.0 201.0 193.5 205.5Q188.0 210.0 180.5 213.5Q173.0 217.0 169.0 217.0Q165.0 217.0 162.0 216.0Q159.0 215.0 156.0 212.0Q153.0 209.0 152.0 206.5Q151.0 204.0 151.0 198.0Q151.0 192.0 152.0 188.5Q153.0 185.0 155.5 181.5Q158.0 178.0 158.0 176.5Q158.0 175.0 163.0 166.0Q168.0 157.0 168.0 155.5Q168.0 154.0 165.5 157.5Q163.0 161.0 159.0 170.0Q155.0 179.0 154.0 179.5Q153.0 180.0 153.0 181.5Q153.0 183.0 148.0 193.5Q143.0 204.0 137.0 211.5Q131.0 219.0 125.5 221.5Q120.0 224.0 117.0 224.0Q114.0 224.0 110.5 222.5Q107.0 221.0 104.0 217.0Q101.0 213.0 101.5 203.0Q102.0 193.0 106.5 180.5Q111.0 168.0 114.5 162.0Q118.0 156.0 120.0 150.5Q122.0 145.0 123.5 143.5Q125.0 142.0 125.0 140.5Q125.0 139.0 128.0 135.5Q131.0 132.0 139.0 116.5Q147.0 101.0 143.0 104.5Q139.0 108.0 133.5 117.0Q128.0 126.0 127.0 126.0Q126.0 126.0 126.0 127.5Q126.0 129.0 123.0 132.5Q120.0 136.0 118.0 140.5Q116.0 145.0 113.5 147.5Q111.0 150.0 106.0 158.5Q101.0 167.0 94.5 174.5Q88.0 182.0 87.0 184.5Q86.0 187.0 81.0 190.5Q76.0 194.0 70.5 193.5Q65.0 193.0 62.5 190.5Q60.0 188.0 59.0 184.5Q58.0 181.0 58.5 172.0Q59.0 163.0 64.0 144.5Q69.0 126.0 70.5 124.5Q72.0 123.0 72.0 121.5Q72.0 120.0 82.0 100.5Q92.0 81.0 84.5 89.0Q77.0 97.0 75.5 100.0Q74.0 103.0 71.0 105.5Q68.0 108.0 67.0 110.5Q66.0 113.0 60.0 119.5Q54.0 126.0 54.0 127.5Q54.0 129.0 48.5 135.5Q43.0 142.0 37.5 142.0Q32.0 142.0 30.5 140.0Q29.0 138.0 28.0 138.0Q27.0 138.0 26.0 136.0Q25.0 134.0 25.5 129.0Q26.0 124.0 27.5 123.0Q29.0 122.0 38.5 107.5Q48.0 93.0 53.0 88.0Q58.0 83.0 60.0 79.5Q62.0 76.0 64.5 74.0Q67.0 72.0 67.0 71.0Q67.0 70.0 71.0 66.5Q75.0 63.0 77.5 59.0Q80.0 55.0 87.0 48.5Q94.0 42.0 95.5 39.5Q97.0 37.0 101.5 34.5Q106.0 32.0 110.5 31.0Q115.0 30.0 119.0 31.0Z"/></svg>';
  const here = location.pathname.replace(/\/+$/, '') || '/';
  const link = (href, label) => `<a href="${href}" class="${here === href ? 'on' : ''}">${label}</a>`;

  const header = document.querySelector('[data-site-header]');
  if (header) {
    header.outerHTML = `<header class="site-header"><div class="wrap nav">
      <a class="brand" href="/" aria-label="MoranBuy home">${LOGO}MoranBuy</a>
      <nav class="nav-links" id="nav-links">${link('/how-it-works', 'How it works')}${link('/for-business', 'For businesses')}${link('/demo', 'Try the demo')}${link('/about', 'About')}<a class="menu-open" data-whatsapp href="https://wa.me/moranbuy" target="_blank" rel="noopener">Open MoranBuy <span class="arrow">→</span></a></nav>
      <div class="nav-cta"><a class="btn btn-ghost" href="/demo">Try the demo</a><a class="btn btn-primary" data-whatsapp href="https://wa.me/moranbuy" target="_blank" rel="noopener"><span class="long">Open MoranBuy</span><span class="arrow">→</span></a><button class="menu-btn" aria-label="Menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div>
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
