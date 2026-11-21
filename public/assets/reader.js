// reader.js — public flipbook viewer + analytics tracker (beacons real events to the backend).
const PDFJS_VER = '4.6.82';
const CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}`;

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');

const S = {
  meta: null, pdf: null, N: 0, aspect: 1.414, doublePage: true, cover: true,
  idx: 0, zoom: 1, panX: 0, panY: 0, canvasCache: {}, renderCache: {}, links: [],
};

/* ---------------- tracker ---------------- */
const SID_KEY = 'll_sid_' + slug;
let sid = sessionStorage.getItem(SID_KEY);
if (!sid) { sid = crypto.randomUUID(); sessionStorage.setItem(SID_KEY, sid); }
const EP = `/api/r/${encodeURIComponent(slug)}/events`;
let queue = [], maxPage = 0, completeSent = false;
function track(type, data = {}) {
  queue.push({ type, ...data, ts: Date.now() });
  if (data.page && data.page > maxPage) {
    maxPage = data.page;
    if (!completeSent && maxPage >= S.N) { completeSent = true; queue.push({ type: 'complete', page: maxPage, ts: Date.now() }); }
  }
  if (queue.length >= 15) flush(false);
}
function flush(useBeacon) {
  if (!queue.length) return;
  const body = JSON.stringify({ sid, events: queue });
  queue = [];
  try {
    if (useBeacon && navigator.sendBeacon) navigator.sendBeacon(EP, new Blob([body], { type: 'text/plain' }));
    else fetch(EP, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch (e) { /* never let tracking break reading */ }
}
setInterval(() => flush(false), 10000);
addEventListener('pagehide', () => { bankDwell(); flush(true); });
addEventListener('beforeunload', () => { bankDwell(); flush(true); });

/* ---------------- dwell bookkeeping ---------------- */
let curPages = [], enter = {};
function enterPages(pages) {
  bankDwell();
  curPages = pages.slice(); const now = Date.now();
  for (const p of pages) { enter[p] = now; track('page_enter', { page: p }); }
}
function bankDwell() {
  const now = Date.now();
  for (const p of curPages) if (enter[p]) { const ms = now - enter[p]; enter[p] = null;
    if (ms > 250 && ms < 3600000) track('page_exit', { page: p, dwell_ms: ms }); }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) bankDwell();
  else { const now = Date.now(); for (const p of curPages) enter[p] = now; }
});

/* ---------------- pdf loading ---------------- */
async function boot() {
  try {
    const res = await fetch(`/api/r/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error(res.status === 404 ? 'This document does not exist or was removed.' : 'Server error ' + res.status);
    S.meta = await res.json();
    S.N = S.meta.numPages; S.aspect = S.meta.aspect || 1.414;
    S.doublePage = S.meta.doublePage && innerWidth > 820; S.links = S.meta.links || [];
    $('#title').textContent = S.meta.title;
    document.title = S.meta.title + ' — LeafLens';

    const pdfjs = await import(`${CDN}/pdf.min.mjs`);
    pdfjs.GlobalWorkerOptions.workerSrc = `${CDN}/pdf.worker.min.mjs`;
    const buf = await (await fetch(S.meta.pdf)).arrayBuffer();
    S.pdf = await pdfjs.getDocument({ data: buf }).promise;

    // session open event
    track('open', { device: guessDevice(), referrer: document.referrer || '' });

    $('#loading').classList.add('off');
    $('#stage').style.display = ''; $('#toolbar').style.display = '';
    buildRail();
    await renderSpread();
    flush(false);
  } catch (e) {
    $('#loading').classList.add('off');
    $('#fatal').classList.add('show');
    $('#fatalMsg').textContent = e.message || String(e);
    console.error('[LeafLens reader]', e);
  }
}

async function renderPage(num) {
  if (S.canvasCache[num]) return S.canvasCache[num];
  if (S.renderCache[num]) return S.renderCache[num];
  S.renderCache[num] = (async () => {
    const page = await S.pdf.getPage(num);
    const dpr = Math.min(devicePixelRatio || 1, 2), target = 1100;
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (target / base.width) * dpr });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    S.canvasCache[num] = c; return c;
  })();
  return S.renderCache[num];
}

function spreadPages(idx) {
  if (!S.doublePage) return [idx + 1].filter(p => p <= S.N);
  if (S.cover) { if (idx === 0) return [1]; const l = idx * 2; return [l, l + 1].filter(p => p <= S.N); }
  const l = idx * 2 + 1; return [l, l + 1].filter(p => p <= S.N);
}
function maxSpread() {
  if (!S.doublePage) return S.N - 1;
  return S.cover ? Math.ceil(S.N / 2) : Math.ceil((S.N + 1) / 2) - 1;
}

async function renderSpread() {
  const pages = spreadPages(S.idx);
  const book = $('#book'); book.innerHTML = '';
  const wrap = $('#stageWrap'), pad = 40;
  const availH = wrap.clientHeight - pad, availW = wrap.clientWidth - pad;
  const halves = pages.length > 1 ? 2 : 1;
  let halfH = availH, halfW = halfH / S.aspect;
  if (halfW * halves > availW) { halfW = availW / halves; halfH = halfW * S.aspect; }
  for (const p of pages) {
    const half = document.createElement('div'); half.className = 'half';
    half.style.width = halfW + 'px'; half.style.height = halfH + 'px';
    const c = await renderPage(p);
    const cv = document.createElement('canvas'); cv.width = c.width; cv.height = c.height;
    cv.getContext('2d').drawImage(c, 0, 0); half.appendChild(cv);
    addLinks(half, p); book.appendChild(half);
  }
  if (pages.length > 1) { const s = document.createElement('div'); s.className = 'spine'; book.appendChild(s); }
  applyZoom(); updateChrome(); enterPages(pages);
  spreadPages(S.idx + 1).forEach(p => renderPage(p).catch(() => {}));
}

function addLinks(half, p) {
  S.links.filter(l => l.page === p).forEach(l => {
    if (l.nx == null) return;
    const a = document.createElement('div');
    a.className = 'lnk' + (l.sponsor ? ' sponsor' : '');
    a.style.left = l.nx * 100 + '%'; a.style.top = l.ny * 100 + '%';
    a.style.width = l.nw * 100 + '%'; a.style.height = l.nh * 100 + '%';
    a.title = (l.sponsor ? 'Sponsor: ' + l.sponsor + ' — ' : '') + l.url;
    a.addEventListener('click', e => {
      e.preventDefault();
      track('link_click', { page: p, link_id: l.id });
      flush(true);
      if (/^https?:/i.test(l.url)) { const x = document.createElement('a'); x.href = l.url; x.target = '_blank'; x.rel = 'noopener'; x.click(); }
      toast(l.sponsor ? 'Visiting ' + l.sponsor : 'Opening link…');
    });
    half.appendChild(a);
  });
}

function updateChrome() {
  $('#pageind').innerHTML = `<b>${spreadPages(S.idx).join('–') || '—'}</b> / ${S.N}`;
  $('#prev').disabled = S.idx <= 0; $('#next').disabled = S.idx >= maxSpread();
  $$('#rail .thumb').forEach(t => t.classList.toggle('active', spreadPages(S.idx).includes(+t.dataset.p)));
}
function applyZoom() { $('#stage').style.transform = `scale(${S.zoom}) translate(${S.panX}px,${S.panY}px)`; }

async function go(dir) {
  const ni = S.idx + dir; if (ni < 0 || ni > maxSpread()) return;
  await flip(dir); S.idx = ni; await renderSpread();
}
function flip(dir) {
  return new Promise(res => {
    const book = $('#book'), half = book.querySelector('.half'); if (!half) return res();
    const w = half.clientWidth, h = half.clientHeight;
    const leaf = document.createElement('div'); leaf.className = 'leaf';
    leaf.style.width = w + 'px'; leaf.style.height = h + 'px';
    leaf.style.left = (dir > 0 ? (S.doublePage ? w : 0) : 0) + 'px';
    leaf.style.transformOrigin = dir > 0 ? 'left center' : 'right center';
    const f = document.createElement('div'); f.className = 'face';
    const cv = book.querySelectorAll('.half canvas');
    try { f.style.backgroundImage = 'url(' + cv[cv.length - 1].toDataURL() + ')'; } catch {}
    leaf.appendChild(f); book.appendChild(leaf);
    requestAnimationFrame(() => { leaf.style.transition = 'transform .42s cubic-bezier(.3,.1,.2,1)'; leaf.style.transform = `rotateY(${dir > 0 ? -160 : 160}deg)`; });
    setTimeout(() => { leaf.remove(); res(); }, 420);
  });
}

function buildRail() {
  const rail = $('#rail'); rail.innerHTML = '';
  for (let p = 1; p <= S.N; p++) {
    const t = document.createElement('div'); t.className = 'thumb'; t.dataset.p = p;
    const cv = document.createElement('canvas'); t.appendChild(cv);
    const n = document.createElement('div'); n.className = 'n'; n.textContent = p; t.appendChild(n);
    t.addEventListener('click', () => { S.idx = spreadIndexForPage(p); renderSpread(); });
    rail.appendChild(t); renderThumb(p, cv);
  }
}
async function renderThumb(p, cv) {
  const c = await renderPage(p).catch(() => null); if (!c) return;
  const w = 126, h = Math.round(w * (c.height / c.width)); cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(c, 0, 0, w, h);
}
function spreadIndexForPage(p) { for (let i = 0; i <= maxSpread(); i++) if (spreadPages(i).includes(p)) return i; return 0; }

let searchCache = {};
async function doSearch(q) {
  q = q.trim(); if (!q) return;
  track('search', { query: q });
  for (let p = 1; p <= S.N; p++) {
    let txt = searchCache[p];
    if (txt === undefined) { try { const pg = await S.pdf.getPage(p); const tc = await pg.getTextContent(); txt = tc.items.map(i => i.str).join(' ').toLowerCase(); } catch { txt = ''; } searchCache[p] = txt; }
    if (txt.includes(q.toLowerCase())) { S.idx = spreadIndexForPage(p); await renderSpread(); toast('Found on page ' + p); return; }
  }
  toast('“' + q + '” not found');
}

function guessDevice() { const w = innerWidth; return w < 620 ? 'mobile' : w < 1000 ? 'tablet' : 'desktop'; }
let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2000); }

/* ---- wiring ---- */
$('#prev').onclick = () => go(-1); $('#next').onclick = () => go(1);
addEventListener('keydown', e => { if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1); });
$('#zoomIn').onclick = () => { S.zoom = Math.min(2.6, S.zoom + .25); applyZoom(); if (S.zoom > 1) track('zoom', { page: spreadPages(S.idx)[0] }); };
$('#zoomOut').onclick = () => { S.zoom = Math.max(1, S.zoom - .25); if (S.zoom <= 1) { S.panX = S.panY = 0; } applyZoom(); };
$('#spread').onclick = () => { S.doublePage = !S.doublePage; S.idx = 0; renderSpread(); };
$('#railBtn').onclick = () => $('#rail').classList.toggle('open');
$('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(e.target.value); });

let dragging = false, dx, dy;
const sw = $('#stageWrap');
sw.addEventListener('mousedown', e => { if (S.zoom <= 1) return; dragging = true; dx = e.clientX - S.panX * S.zoom; dy = e.clientY - S.panY * S.zoom; });
addEventListener('mouseup', () => dragging = false);
addEventListener('mousemove', e => { if (!dragging) return; S.panX = (e.clientX - dx) / S.zoom; S.panY = (e.clientY - dy) / S.zoom; applyZoom(); });
// swipe on touch
let tsx = null;
sw.addEventListener('touchstart', e => { tsx = e.touches[0].clientX; }, { passive: true });
sw.addEventListener('touchend', e => { if (tsx == null) return; const dxp = e.changedTouches[0].clientX - tsx; if (Math.abs(dxp) > 50) go(dxp < 0 ? 1 : -1); tsx = null; });
addEventListener('resize', () => { if (S.pdf) renderSpread(); });

boot();
