# LeafLens

Self-hosted **PDF reading-analytics platform**. Upload a PDF, get a shareable flipbook
reader, and see exactly how people read it — where attention goes, where they drop off,
and what they click. Built for publishers who want to tailor the next issue to real
behaviour and show sponsors proof of delivery.

Readers need no account and nothing to install; they open a link, read, and every
interaction is beaconed back to your own server.

---

## What it tracks

Per publication, aggregated across all readers (filterable by device):

- **Reader sessions**, unique, with device mix and traffic source (referrer)
- **Reading funnel** — % of readers who reach each page (drop-off curve)
- **Time spent per page** (dwell) + an **attention heatmap**
- **Average completion** (how far through readers get) and **bounce rate**
- **Average time in document** per session
- **Link performance** — views, clicks and **click-through rate** per link
- **Sponsor/advertiser report** — impressions (page views), dwell on the placement,
  clicks, CTR, exportable per sponsor
- **In-document searches** — what readers looked for
- **When they read** — opens by hour
- **Automated plain-language insights** (hottest page, sharpest drop-off, top link…)
- CSV export of page- and link-level data

Reader features: real page-flip, cover + double-page spreads, single-page/mobile mode,
zoom & pan, thumbnails, in-document search, swipe on touch.

---

## Architecture

```
Browser (reader)  ──beacon events──►  Express API  ──►  SQLite (events + sessions)
Browser (publisher dashboard) ──►  Express API  ──►  SQLite (aggregated on read)
PDFs stored on disk under DATA_DIR/uploads
```

One Node process, one SQLite file, PDFs on disk. No external services.
PDF rendering and link extraction run in the browser via PDF.js (loaded from cdnjs).

| File | Purpose |
|------|---------|
| `server.js` | Express app: auth, upload, event ingestion, API |
| `db.js` | SQLite schema + prepared statements |
| `analytics.js` | Event → aggregate queries |
| `public/index.html` | Sign-in / sign-up |
| `public/dashboard.html` + `assets/dashboard.js` | Publisher app |
| `public/reader.html` + `assets/reader.js` | Public flipbook reader + tracker |

---

## Run it

### Docker (recommended)

```bash
cp .env.example .env
# put a secret in .env:
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env   # or edit by hand
docker compose up -d --build
```

Open <http://localhost:8080>, create an account, upload a PDF, share the reader link.

Data (SQLite + uploaded PDFs) lives in the `leaflens-data` Docker volume — back that up.

### Without Docker

```bash
npm install
SESSION_SECRET=$(openssl rand -hex 32) node server.js
```

Requires Node 20+.

---

## Configuration (env)

| Var | Default | Notes |
|-----|---------|-------|
| `SESSION_SECRET` | — | **Required.** 16+ chars. App refuses to boot without it. |
| `ALLOW_SIGNUP` | `true` | Set `false` after inviting people to lock down new accounts. |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS, else the login cookie is dropped. |
| `MAX_UPLOAD_MB` | `60` | Max PDF size. |
| `PORT` | `8080` | |
| `DATA_DIR` | `./data` | SQLite + uploads location. |

---

## Deploying for real (HTTPS)

Readers (and the login cookie) need HTTPS in production. Put a TLS reverse proxy in
front and set `COOKIE_SECURE=true`. Minimal [Caddy](https://caddyserver.com) example:

```
leaflens.yourdomain.com {
    reverse_proxy localhost:8080
}
```

Then in `.env`: `COOKIE_SECURE=true`. Caddy fetches and renews the certificate
automatically. (nginx/Traefik work the same way — just proxy to port 8080.)

To invite your friend: send them `https://leaflens.yourdomain.com`, they sign up,
upload their own PDFs. Each account only sees its own publications. Once everyone's
in, set `ALLOW_SIGNUP=false` and `docker compose up -d` to re-apply.

---

## Notes & limits

- **Failures are loud by design**: missing `SESSION_SECRET` aborts boot; a PDF that
  can't be parsed shows a red error instead of silently doing nothing.
- Analytics are aggregated **on read** with SQL — simple and correct up to large event
  volumes. If you ever outgrow it, add a nightly rollup table; the query shapes in
  `analytics.js` port straight over.
- **Geography** isn't populated (the `country` column is a stub). Add a GeoIP lookup on
  the reader IP in the events endpoint if you want it.
- Sponsors are driven by **clickable links embedded in the PDF**. Scanned PDFs with no
  link annotations won't auto-detect links — but you can still read the attention and
  completion analytics, and add links/sponsors manually later.
- The reader loads PDF.js from cdnjs. For a fully air-gapped install, vendor
  `pdf.min.mjs` + `pdf.worker.min.mjs` into `public/assets/` and point the two `CDN`
  constants (in `reader.js` and `dashboard.js`) at `/assets`.
- CSRF defense is same-origin checks + `SameSite=Lax` cookies, which suits a
  self-hosted tool. Add tokens if you expose it widely.

MIT — do what you like with it.
