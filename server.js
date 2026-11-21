// server.js — LeafLens backend. Express + SQLite.
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { db, Q, insertLinks, insertEvents } from './db.js';
import { analytics } from './analytics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const UPLOADS = path.join(DATA_DIR, 'uploads');
const PORT = parseInt(process.env.PORT || '8080', 10);
const ALLOW_SIGNUP = (process.env.ALLOW_SIGNUP ?? 'true') !== 'false';
const MAX_MB = parseInt(process.env.MAX_UPLOAD_MB || '60', 10);
const PDF_CACHE_TTL = parseInt(process.env.PDF_CACHE_TTL || '600', 10); // seconds a proxied PDF is cached
// Footgun: disables the private-IP guard for url-source fetches. Only enable on a
// trusted single-tenant install where you need to pull PDFs from a LAN file server.
const ALLOW_PRIVATE_FETCH = process.env.ALLOW_PRIVATE_FETCH === 'true';

// A secret is required — refuse to boot with a default, so sessions are never forgeable.
const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error('FATAL: SESSION_SECRET must be set to a random string of 16+ chars. Refusing to start.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(cookieParser());
// sendBeacon posts as text/plain — accept JSON from either content type
app.use(express.json({ limit: '256kb', type: ['application/json', 'text/plain'] }));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.pdf'),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    cb(file.mimetype === 'application/pdf' ? null : new Error('Only PDF files are accepted'),
       file.mimetype === 'application/pdf'),
});

// ---------- helpers ----------
const uid = () => crypto.randomUUID();
const slugify = (s) => (s || 'doc').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'doc';
function uniqueSlug(base) {
  let s = slugify(base), i = 1;
  while (Q.pubBySlug.get(s)) s = slugify(base) + '-' + (++i);
  return s;
}
function deviceFromUA(ua = '') {
  if (/mobile|iphone|android.*mobile/i.test(ua)) return 'mobile';
  if (/ipad|tablet|android/i.test(ua)) return 'tablet';
  return 'desktop';
}

// ---- url-source fetching (SSRF-guarded, size-capped PDF pull) ----
function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}
async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('URL must start with http:// or https://');
  if (!ALLOW_PRIVATE_FETCH) {
    let addr;
    try { addr = (await dns.lookup(u.hostname)).address; }
    catch { throw new Error('Could not resolve that hostname'); }
    if (isPrivateIp(addr)) throw new Error('URL resolves to a private/internal address — refused for security');
  }
  return u;
}
async function fetchPdf(sourceUrl) {
  await assertSafeUrl(sourceUrl);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  let resp;
  try {
    resp = await fetch(sourceUrl, { redirect: 'error', signal: ac.signal, headers: { 'User-Agent': 'LeafLens/1.0' } });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'Timed out fetching the PDF' : 'Could not fetch the PDF (' + e.message + ')');
  }
  clearTimeout(timer);
  if (!resp.ok) throw new Error('Source returned HTTP ' + resp.status);
  const len = parseInt(resp.headers.get('content-length') || '0', 10);
  if (len && len > MAX_MB * 1024 * 1024) throw new Error('PDF exceeds the ' + MAX_MB + 'MB limit');
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_MB * 1024 * 1024) throw new Error('PDF exceeds the ' + MAX_MB + 'MB limit');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('That URL does not point to a PDF (missing %PDF header)');
  return buf;
}
const cachePath = (pub) => path.join(UPLOADS, pub.id + '.cache.pdf');
async function serveProxied(pub, res) {
  const cache = cachePath(pub);
  const fresh = fs.existsSync(cache) && (Date.now() - pub.fetched_at) < PDF_CACHE_TTL * 1000;
  if (fresh) return res.type('application/pdf').sendFile(cache);
  try {
    const buf = await fetchPdf(pub.source_url);
    fs.writeFileSync(cache, buf);
    Q.setFetched.run({ id: pub.id, t: Date.now() });
    return res.type('application/pdf').send(buf);
  } catch (e) {
    if (fs.existsSync(cache)) { // upstream down but we have a cached copy — serve it rather than break the reader
      console.warn('[LeafLens] url-source refetch failed, serving stale cache:', e.message);
      return res.type('application/pdf').sendFile(cache);
    }
    console.error('[LeafLens] url-source fetch failed:', e.message);
    return res.status(502).send('Upstream PDF unavailable: ' + e.message);
  }
}
function currentUser(req) {
  const t = req.cookies.ll_session;
  return t ? Q.sessionUser.get(t) : null;
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_authenticated' });
  req.user = u; next();
}
// Same-origin guard for mutating requests (lightweight CSRF defense; cookie is SameSite=Lax too).
function sameOrigin(req, res, next) {
  const o = req.get('origin');
  if (o) {
    try { if (new URL(o).host !== req.get('host')) return res.status(403).json({ error: 'bad_origin' }); }
    catch { return res.status(403).json({ error: 'bad_origin' }); }
  }
  next();
}
function ownPub(req, res, next) {
  const pub = Q.pubBySlug.get(req.params.slug);
  if (!pub) return res.status(404).json({ error: 'not_found' });
  if (pub.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  req.pub = pub; next();
}

// ---------- auth ----------
app.post('/api/auth/signup', sameOrigin, (req, res) => {
  if (!ALLOW_SIGNUP) return res.status(403).json({ error: 'signup_disabled' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const pass = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });
  if (pass.length < 8) return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 8 characters.' });
  if (Q.userByEmail.get(email)) return res.status(409).json({ error: 'email_taken' });
  const id = uid();
  Q.createUser.run(id, email, bcrypt.hashSync(pass, 10));
  startSession(res, id);
  res.json({ ok: true, email });
});
app.post('/api/auth/login', sameOrigin, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pass = String(req.body.password || '');
  const u = Q.userByEmail.get(email);
  if (!u || !bcrypt.compareSync(pass, u.pass_hash)) return res.status(401).json({ error: 'bad_credentials' });
  startSession(res, u.id);
  res.json({ ok: true, email });
});
app.post('/api/auth/logout', (req, res) => {
  const t = req.cookies.ll_session;
  if (t) Q.deleteSession.run(t);
  res.clearCookie('ll_session').json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  res.json(u ? { email: u.email, signup: ALLOW_SIGNUP } : { email: null, signup: ALLOW_SIGNUP });
});
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  Q.createSession.run(token, userId);
  res.cookie('ll_session', token, {
    httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30,
    secure: process.env.COOKIE_SECURE === 'true',
  });
}

// ---------- publications (owner) ----------
app.get('/api/pubs', requireAuth, (req, res) => {
  const rows = Q.pubsByUser.all(req.user.id).map(p => ({
    slug: p.slug, title: p.title, numPages: p.num_pages, doublePage: !!p.double_page,
    source: p.source, sourceUrl: p.source_url, created_at: p.created_at,
    sessions: db.prepare(`SELECT COUNT(*) n FROM reader_sessions WHERE pub_id=?`).get(p.id).n,
  }));
  res.json(rows);
});

// Two source modes: multipart file upload, or JSON { sourceUrl } to pull from a remote URL.
app.post('/api/pubs', requireAuth, sameOrigin, (req, res) => {
  const ct = req.get('content-type') || '';
  if (ct.includes('multipart')) return handleUpload(req, res);
  return handleUrlPub(req, res);
});
function handleUpload(req, res) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'upload_failed', message: err.message });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const title = String(req.body.title || 'Untitled').trim().slice(0, 140) || 'Untitled';
    const numPages = Math.max(1, parseInt(req.body.numPages || '1', 10));
    const aspect = Math.min(3, Math.max(0.3, parseFloat(req.body.aspect || '1.414')));
    const doublePage = req.body.doublePage === 'false' ? 0 : 1;
    const id = uid(), slug = uniqueSlug(title);
    Q.createPub.run({ id, slug, user_id: req.user.id, title, file: req.file.filename,
      num_pages: numPages, aspect, double_page: doublePage, source: 'upload', source_url: null });
    res.json({ ok: true, slug });
  });
}
async function handleUrlPub(req, res) {
  const title = String(req.body.title || 'Untitled').trim().slice(0, 140) || 'Untitled';
  const sourceUrl = String(req.body.sourceUrl || '').trim();
  const doublePage = req.body.doublePage === false || req.body.doublePage === 'false' ? 0 : 1;
  if (!sourceUrl) return res.status(400).json({ error: 'no_url', message: 'Provide the PDF URL.' });
  let buf;
  try { buf = await fetchPdf(sourceUrl); }
  catch (e) { return res.status(400).json({ error: 'bad_source', message: e.message }); }
  const id = uid(), slug = uniqueSlug(title);
  Q.createPub.run({ id, slug, user_id: req.user.id, title, file: '',
    num_pages: 0, aspect: 1.414, double_page: doublePage, source: 'url', source_url: sourceUrl });
  fs.writeFileSync(path.join(UPLOADS, id + '.cache.pdf'), buf);
  Q.setFetched.run({ id, t: Date.now() });
  res.json({ ok: true, slug });
}

// bulk replace extracted links (sent by the dashboard right after upload)
app.post('/api/pubs/:slug/links', requireAuth, sameOrigin, ownPub, (req, res) => {
  const links = Array.isArray(req.body.links) ? req.body.links : [];
  const rows = links.slice(0, 2000).map(l => ({
    id: uid(), pub_id: req.pub.id, page: Math.max(1, parseInt(l.page || 1, 10)),
    url: String(l.url || '').slice(0, 2048), label: String(l.label || l.url || 'link').slice(0, 200),
    sponsor: l.sponsor ? String(l.sponsor).slice(0, 120) : null,
    nx: num(l.nx), ny: num(l.ny), nw: num(l.nw), nh: num(l.nh),
  })).filter(r => r.url);
  Q.clearLinks.run(req.pub.id);
  insertLinks(rows);
  // url-source pubs learn their page count/aspect here (parsed client-side after the proxy fetch)
  if (req.body.numPages) {
    Q.updatePubMeta.run({ id: req.pub.id,
      num_pages: Math.max(1, parseInt(req.body.numPages, 10)),
      aspect: Math.min(3, Math.max(0.3, parseFloat(req.body.aspect || req.pub.aspect || 1.414))) });
  }
  res.json({ ok: true, count: rows.length });
});

// force a re-pull of a url-source PDF on the next read
app.post('/api/pubs/:slug/resync', requireAuth, sameOrigin, ownPub, (req, res) => {
  if (req.pub.source !== 'url') return res.status(400).json({ error: 'not_url_source' });
  Q.setFetched.run({ id: req.pub.id, t: 0 });
  res.json({ ok: true });
});

app.patch('/api/pubs/:slug/links/:id', requireAuth, sameOrigin, ownPub, (req, res) => {
  const l = Q.linkById.get(req.params.id, req.pub.id);
  if (!l) return res.status(404).json({ error: 'not_found' });
  const sponsor = req.body.sponsor ? String(req.body.sponsor).slice(0, 120) : null;
  Q.setSponsor.run(sponsor, req.params.id, req.pub.id);
  res.json({ ok: true });
});

app.get('/api/pubs/:slug/analytics', requireAuth, ownPub, (req, res) => {
  const dev = ['all', 'desktop', 'mobile', 'tablet'].includes(req.query.device) ? req.query.device : 'all';
  res.json(analytics(req.pub, dev));
});

app.delete('/api/pubs/:slug', requireAuth, sameOrigin, ownPub, (req, res) => {
  if (req.pub.file) { try { fs.unlinkSync(path.join(UPLOADS, req.pub.file)); } catch { /* gone */ } }
  try { fs.unlinkSync(cachePath(req.pub)); } catch { /* no cache */ }
  Q.deletePub.run(req.pub.id);
  res.json({ ok: true });
});

// ---------- public reader API ----------
app.get('/api/r/:slug', (req, res) => {
  const pub = Q.pubBySlug.get(req.params.slug);
  if (!pub) return res.status(404).json({ error: 'not_found' });
  res.json({
    title: pub.title, numPages: pub.num_pages, aspect: pub.aspect, doublePage: !!pub.double_page,
    pdf: `/files/${pub.slug}.pdf`,
    links: Q.linksByPub.all(pub.id).map(l => ({
      id: l.id, page: l.page, url: l.url, label: l.label, sponsor: l.sponsor,
      nx: l.nx, ny: l.ny, nw: l.nw, nh: l.nh })),
  });
});

app.get('/files/:slug.pdf', (req, res) => {
  const pub = Q.pubBySlug.get(req.params.slug);
  if (!pub) return res.status(404).send('Not found');
  if (pub.source === 'url') return serveProxied(pub, res);
  const f = path.join(UPLOADS, pub.file);
  if (!fs.existsSync(f)) return res.status(404).send('File missing');
  res.type('application/pdf').sendFile(f);
});

// event ingestion (public; readers aren't logged in). Batches from sendBeacon/fetch.
const rate = new Map(); // ip -> {n, t}
app.post('/api/r/:slug/events', (req, res) => {
  const pub = Q.pubBySlug.get(req.params.slug);
  if (!pub) return res.status(404).json({ error: 'not_found' });

  const ip = req.ip || 'x';
  const now = Date.now(), r = rate.get(ip) || { n: 0, t: now };
  if (now - r.t > 10000) { r.n = 0; r.t = now; }
  if (++r.n > 300) { rate.set(ip, r); return res.status(429).json({ error: 'rate_limited' }); }
  rate.set(ip, r);

  const sid = String(req.body.sid || '').slice(0, 64);
  const events = Array.isArray(req.body.events) ? req.body.events.slice(0, 200) : [];
  if (!sid || !events.length) return res.json({ ok: true });

  // ensure a reader_session exists (device/referrer taken from the 'open' event or headers)
  const open = events.find(e => e.type === 'open');
  const device = (open && ['desktop', 'mobile', 'tablet'].includes(open.device))
    ? open.device : deviceFromUA(req.get('user-agent'));
  const referrer = normRef(open?.referrer) ;
  Q.upsertSession.run({ sid, pub_id: pub.id, device, referrer,
    country: null, ua: String(req.get('user-agent') || '').slice(0, 300) });

  let maxPage = 0;
  const rows = [];
  for (const e of events) {
    const type = String(e.type || '').slice(0, 20);
    if (!['open', 'page_enter', 'page_exit', 'link_click', 'zoom', 'search', 'complete'].includes(type)) continue;
    const page = e.page != null ? Math.max(0, parseInt(e.page, 10) || 0) : null;
    if (page) maxPage = Math.max(maxPage, page);
    rows.push({ pub_id: pub.id, sid, type, page,
      dwell_ms: e.dwell_ms != null ? Math.min(3600000, Math.max(0, parseInt(e.dwell_ms, 10) || 0)) : null,
      link_id: e.link_id ? String(e.link_id).slice(0, 64) : null,
      query: e.query ? String(e.query).slice(0, 120) : null,
      ts: e.ts ? parseInt(e.ts, 10) : now });
  }
  insertEvents(rows);
  if (maxPage) Q.bumpSession.run({ sid, max_page: maxPage });
  res.json({ ok: true, stored: rows.length });
});

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function normRef(ref) {
  if (!ref) return 'direct';
  try { const h = new URL(ref).hostname.replace(/^www\./, ''); return h || 'direct'; }
  catch { return 'direct'; }
}

// ---------- static pages ----------
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/r/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reader.html')));
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error('[LeafLens] error:', err);
  res.status(500).json({ error: 'server_error', message: err.message });
});

app.listen(PORT, () => {
  console.log(`LeafLens running on http://localhost:${PORT}  (signup ${ALLOW_SIGNUP ? 'open' : 'closed'})`);
});
