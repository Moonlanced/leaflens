// db.js — SQLite schema + prepared statements. Fails loudly if the data dir is unwritable.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const dbPath = path.join(DATA_DIR, 'leaflens.sqlite');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pubs (
  id          TEXT PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  file        TEXT NOT NULL,          -- stored filename under uploads/
  num_pages   INTEGER NOT NULL DEFAULT 0,
  aspect      REAL NOT NULL DEFAULT 1.414,
  double_page INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS links (
  id       TEXT PRIMARY KEY,
  pub_id   TEXT NOT NULL REFERENCES pubs(id) ON DELETE CASCADE,
  page     INTEGER NOT NULL,
  url      TEXT NOT NULL,
  label    TEXT NOT NULL,
  sponsor  TEXT,
  nx REAL, ny REAL, nw REAL, nh REAL
);
CREATE INDEX IF NOT EXISTS idx_links_pub ON links(pub_id);

CREATE TABLE IF NOT EXISTS reader_sessions (
  sid        TEXT PRIMARY KEY,
  pub_id     TEXT NOT NULL REFERENCES pubs(id) ON DELETE CASCADE,
  device     TEXT,
  referrer   TEXT,
  country    TEXT,
  ua         TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_at    TEXT NOT NULL DEFAULT (datetime('now')),
  max_page   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rs_pub ON reader_sessions(pub_id);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  pub_id   TEXT NOT NULL REFERENCES pubs(id) ON DELETE CASCADE,
  sid      TEXT NOT NULL,
  type     TEXT NOT NULL,            -- open|page_enter|page_exit|link_click|zoom|search|complete
  page     INTEGER,
  dwell_ms INTEGER,
  link_id  TEXT,
  query    TEXT,
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ev_pub_type ON events(pub_id, type);
CREATE INDEX IF NOT EXISTS idx_ev_pub_page ON events(pub_id, page);
`);

// ---- prepared statements ----
export const Q = {
  createUser: db.prepare(`INSERT INTO users (id,email,pass_hash) VALUES (?,?,?)`),
  userByEmail: db.prepare(`SELECT * FROM users WHERE email=?`),
  userById: db.prepare(`SELECT * FROM users WHERE id=?`),

  createSession: db.prepare(`INSERT INTO auth_sessions (token,user_id) VALUES (?,?)`),
  sessionUser: db.prepare(
    `SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`),
  deleteSession: db.prepare(`DELETE FROM auth_sessions WHERE token=?`),

  createPub: db.prepare(
    `INSERT INTO pubs (id,slug,user_id,title,file,num_pages,aspect,double_page)
     VALUES (@id,@slug,@user_id,@title,@file,@num_pages,@aspect,@double_page)`),
  pubBySlug: db.prepare(`SELECT * FROM pubs WHERE slug=?`),
  pubsByUser: db.prepare(`SELECT * FROM pubs WHERE user_id=? ORDER BY created_at DESC`),
  deletePub: db.prepare(`DELETE FROM pubs WHERE id=?`),

  clearLinks: db.prepare(`DELETE FROM links WHERE pub_id=?`),
  addLink: db.prepare(
    `INSERT INTO links (id,pub_id,page,url,label,sponsor,nx,ny,nw,nh)
     VALUES (@id,@pub_id,@page,@url,@label,@sponsor,@nx,@ny,@nw,@nh)`),
  linksByPub: db.prepare(`SELECT * FROM links WHERE pub_id=? ORDER BY page`),
  linkById: db.prepare(`SELECT * FROM links WHERE id=? AND pub_id=?`),
  setSponsor: db.prepare(`UPDATE links SET sponsor=? WHERE id=? AND pub_id=?`),

  upsertSession: db.prepare(
    `INSERT INTO reader_sessions (sid,pub_id,device,referrer,country,ua)
     VALUES (@sid,@pub_id,@device,@referrer,@country,@ua)
     ON CONFLICT(sid) DO UPDATE SET last_at=datetime('now')`),
  bumpSession: db.prepare(
    `UPDATE reader_sessions SET last_at=datetime('now'),
       max_page=MAX(max_page,@max_page) WHERE sid=@sid`),
  addEvent: db.prepare(
    `INSERT INTO events (pub_id,sid,type,page,dwell_ms,link_id,query,ts)
     VALUES (@pub_id,@sid,@type,@page,@dwell_ms,@link_id,@query,@ts)`),
};

export const insertLinks = db.transaction((rows) => { for (const r of rows) Q.addLink.run(r); });
export const insertEvents = db.transaction((rows) => { for (const r of rows) Q.addEvent.run(r); });
