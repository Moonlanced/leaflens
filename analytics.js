// analytics.js — turn raw events into the aggregate shape the dashboard renders.
import { db, Q } from './db.js';

const st = {
  sessions:    db.prepare(`SELECT COUNT(*) n FROM reader_sessions WHERE pub_id=@pub AND (@dev='all' OR device=@dev)`),
  devices:     db.prepare(`SELECT device, COUNT(*) n FROM reader_sessions WHERE pub_id=@pub GROUP BY device`),
  referrers:   db.prepare(`SELECT referrer, COUNT(*) n FROM reader_sessions WHERE pub_id=@pub AND (@dev='all' OR device=@dev) GROUP BY referrer ORDER BY n DESC LIMIT 8`),
  hours:       db.prepare(`SELECT CAST(strftime('%H', started_at) AS INT) h, COUNT(*) n FROM reader_sessions WHERE pub_id=@pub AND (@dev='all' OR device=@dev) GROUP BY h`),
  // distinct sessions reaching each page
  pageViews:   db.prepare(`
    SELECT e.page page, COUNT(DISTINCT e.sid) n
    FROM events e JOIN reader_sessions r ON r.sid=e.sid
    WHERE e.pub_id=@pub AND e.type='page_enter' AND (@dev='all' OR r.device=@dev)
    GROUP BY e.page`),
  enters:      db.prepare(`
    SELECT e.page page, COUNT(*) n
    FROM events e JOIN reader_sessions r ON r.sid=e.sid
    WHERE e.pub_id=@pub AND e.type='page_enter' AND (@dev='all' OR r.device=@dev)
    GROUP BY e.page`),
  dwell:       db.prepare(`
    SELECT e.page page, SUM(e.dwell_ms) s, COUNT(*) c
    FROM events e JOIN reader_sessions r ON r.sid=e.sid
    WHERE e.pub_id=@pub AND e.type='page_exit' AND (@dev='all' OR r.device=@dev)
    GROUP BY e.page`),
  zooms:       db.prepare(`
    SELECT e.page page, COUNT(*) n
    FROM events e JOIN reader_sessions r ON r.sid=e.sid
    WHERE e.pub_id=@pub AND e.type='zoom' AND (@dev='all' OR r.device=@dev)
    GROUP BY e.page`),
  durations:   db.prepare(`
    SELECT e.sid, SUM(e.dwell_ms) ms
    FROM events e JOIN reader_sessions r ON r.sid=e.sid
    WHERE e.pub_id=@pub AND e.type='page_exit' AND (@dev='all' OR r.device=@dev)
    GROUP BY e.sid`),
  completions: db.prepare(`SELECT max_page FROM reader_sessions WHERE pub_id=@pub AND (@dev='all' OR device=@dev)`),
  clicks:      db.prepare(`
    SELECT e.link_id, COUNT(*) n
    FROM events e JOIN reader_sessions r ON r.sid=e.sid
    WHERE e.pub_id=@pub AND e.type='link_click' AND (@dev='all' OR r.device=@dev)
    GROUP BY e.link_id`),
  searches:    db.prepare(`
    SELECT LOWER(e.query) q, COUNT(*) n
    FROM events e JOIN reader_sessions r ON r.sid=e.sid
    WHERE e.pub_id=@pub AND e.type='search' AND e.query IS NOT NULL AND (@dev='all' OR r.device=@dev)
    GROUP BY q ORDER BY n DESC LIMIT 12`),
};

export function analytics(pub, dev = 'all') {
  const p = { pub: pub.id, dev };
  const N = pub.num_pages || 0;
  const z = (fill = 0) => new Array(N + 1).fill(fill);

  const pageViews = z(), dwellAvg = z(), reReads = z(), zoomArr = z();
  const pv = {}; for (const r of st.pageViews.all(p)) pv[r.page] = r.n;
  for (let i = 1; i <= N; i++) pageViews[i] = pv[i] || 0;
  for (const r of st.dwell.all(p)) if (r.page >= 1 && r.page <= N) dwellAvg[r.page] = r.c ? r.s / r.c / 1000 : 0;
  for (const r of st.enters.all(p)) if (r.page >= 1 && r.page <= N) reReads[r.page] = Math.max(0, r.n - (pv[r.page] || 0));
  for (const r of st.zooms.all(p)) if (r.page >= 1 && r.page <= N) zoomArr[r.page] = r.n;

  const devices = { desktop: 0, mobile: 0, tablet: 0 };
  for (const r of st.devices.all(p)) if (r.device in devices) devices[r.device] = r.n;

  const referrers = {}; for (const r of st.referrers.all(p)) referrers[r.referrer || 'direct'] = r.n;
  const hours = new Array(24).fill(0); for (const r of st.hours.all(p)) hours[r.h] = r.n;

  const durMs = st.durations.all(p).map(r => r.ms || 0);
  const durationAvg = durMs.length ? durMs.reduce((a, b) => a + b, 0) / durMs.length / 1000 : 0;

  const maxPages = st.completions.all(p).map(r => r.max_page || 0);
  const completionAvg = maxPages.length ? maxPages.reduce((a, b) => a + b / Math.max(1, N), 0) / maxPages.length : 0;
  const bounce = maxPages.length ? maxPages.filter(m => m <= 1).length / maxPages.length : 0;

  const clickMap = {}; for (const r of st.clicks.all(p)) clickMap[r.link_id] = r.n;
  const links = Q.linksByPub.all(pub.id).map(l => {
    const imp = pageViews[l.page] || 0, clicks = clickMap[l.id] || 0;
    return { id: l.id, page: l.page, label: l.label, url: l.url, sponsor: l.sponsor,
             imp, clicks, ctr: imp ? clicks / imp : 0 };
  });

  const searches = st.searches.all(p).map(r => ({ q: r.q, c: r.n }));

  return {
    title: pub.title, numPages: N, doublePage: !!pub.double_page,
    sessions: st.sessions.get(p).n,
    devices, referrers, hours,
    pageViews, dwellAvg, reReads, zooms: zoomArr,
    completionAvg, durationAvg, bounce,
    links, searches,
  };
}
