import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');

// Ensure the parent directory exists (Railway mounted volume might be empty)
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    pricecharting_url TEXT,
    pc_product_id TEXT,
    pc_product_name TEXT,
    pc_loose_cents INTEGER,
    pc_grade7_cents INTEGER,
    pc_grade8_cents INTEGER,
    pc_grade9_cents INTEGER,
    pc_grade9_5_cents INTEGER,
    pc_psa10_cents INTEGER,
    pc_updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
    listing_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    image_url TEXT,
    price_text TEXT,
    price_numeric REAL,
    price_currency TEXT,
    bid_count INTEGER,
    time_left_text TEXT,
    ends_at INTEGER,
    ending_soon INTEGER NOT NULL DEFAULT 0,
    location TEXT,
    condition TEXT,
    first_seen_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    last_seen_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    UNIQUE(search_id, listing_id)
  );

  CREATE INDEX IF NOT EXISTS idx_listings_search ON listings(search_id);
  CREATE INDEX IF NOT EXISTS idx_listings_ends_at ON listings(ends_at);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT NOT NULL UNIQUE,
    search_id INTEGER,
    title TEXT,
    url TEXT,
    ends_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    notified_at INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_pending ON notifications(notified_at, ends_at);

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    finished_at INTEGER,
    searches_run INTEGER NOT NULL DEFAULT 0,
    listings_found INTEGER NOT NULL DEFAULT 0,
    new_listings INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    email_sent INTEGER NOT NULL DEFAULT 0
  );
`);

export function listSearches({ activeOnly = false } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM searches WHERE active = 1 ORDER BY name'
    : 'SELECT * FROM searches ORDER BY name';
  return db.prepare(sql).all();
}

// Idempotent migration: add PriceCharting columns if missing
function migrate() {
  const cols = db.prepare(`PRAGMA table_info(searches)`).all().map((c) => c.name);
  const add = (col, type) => {
    if (!cols.includes(col)) db.exec(`ALTER TABLE searches ADD COLUMN ${col} ${type}`);
  };
  add('pricecharting_url', 'TEXT');
  add('pc_product_id', 'TEXT');
  add('pc_product_name', 'TEXT');
  add('pc_loose_cents', 'INTEGER');
  add('pc_grade7_cents', 'INTEGER');
  add('pc_grade8_cents', 'INTEGER');
  add('pc_grade9_cents', 'INTEGER');
  add('pc_grade9_5_cents', 'INTEGER');
  add('pc_psa10_cents', 'INTEGER');
  add('pc_updated_at', 'INTEGER');
  add('required_keywords', 'TEXT'); // JSON array of strings
  add('forbidden_keywords', 'TEXT'); // JSON array of strings
}
migrate();

const DEFAULT_SETTINGS = {
  global_required_keywords: ['PSA', 'CGC', 'BGS'],
  global_forbidden_keywords: ['9'],
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) {
    try {
      obj[r.key] = JSON.parse(r.value);
    } catch {
      obj[r.key] = r.value;
    }
  }
  return { ...DEFAULT_SETTINGS, ...obj };
}

export function setSetting(key, value) {
  const v = JSON.stringify(value);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, v);
}

function jsonOrNull(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return JSON.stringify(v);
  return v;
}

export function createSearch({ name, url, pricecharting_url, required_keywords, forbidden_keywords }) {
  const info = db
    .prepare(
      `INSERT INTO searches (name, url, pricecharting_url, required_keywords, forbidden_keywords)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      name,
      url,
      pricecharting_url || null,
      jsonOrNull(required_keywords),
      jsonOrNull(forbidden_keywords)
    );
  return info.lastInsertRowid;
}

export function updateSearch(id, { name, url, active, pricecharting_url, required_keywords, forbidden_keywords }) {
  db.prepare(
    `UPDATE searches SET
       name = COALESCE(?, name),
       url = COALESCE(?, url),
       active = COALESCE(?, active),
       pricecharting_url = COALESCE(?, pricecharting_url),
       required_keywords = COALESCE(?, required_keywords),
       forbidden_keywords = COALESCE(?, forbidden_keywords)
     WHERE id = ?`
  ).run(
    name ?? null,
    url ?? null,
    active == null ? null : (active ? 1 : 0),
    pricecharting_url ?? null,
    jsonOrNull(required_keywords),
    jsonOrNull(forbidden_keywords),
    id
  );
}

export function updateSearchPrices(id, info) {
  db.prepare(
    `UPDATE searches SET
       pc_product_id = ?,
       pc_product_name = ?,
       pc_loose_cents = ?,
       pc_grade7_cents = ?,
       pc_grade8_cents = ?,
       pc_grade9_cents = ?,
       pc_grade9_5_cents = ?,
       pc_psa10_cents = ?,
       pc_updated_at = strftime('%s','now')
     WHERE id = ?`
  ).run(
    info.product_id ?? null,
    info.product_name ?? null,
    info.prices?.loose ?? null,
    info.prices?.grade7 ?? null,
    info.prices?.grade8 ?? null,
    info.prices?.grade9 ?? null,
    info.prices?.grade9_5 ?? null,
    info.prices?.psa10 ?? null,
    id
  );
}

export function deleteSearch(id) {
  db.prepare('DELETE FROM searches WHERE id = ?').run(id);
}

export function clearListingsForSearch(searchId) {
  db.prepare('DELETE FROM listings WHERE search_id = ?').run(searchId);
}

export function deleteListingsNotInSet(searchId, keepListingIds) {
  if (!keepListingIds || keepListingIds.length === 0) {
    db.prepare('DELETE FROM listings WHERE search_id = ?').run(searchId);
    return;
  }
  const placeholders = keepListingIds.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM listings WHERE search_id = ? AND listing_id NOT IN (${placeholders})`
  ).run(searchId, ...keepListingIds);
}

const upsertListingStmt = db.prepare(`
  INSERT INTO listings
    (search_id, listing_id, title, url, image_url, price_text, price_numeric, price_currency,
     bid_count, time_left_text, ends_at, ending_soon, location, condition, last_seen_at)
  VALUES (@search_id, @listing_id, @title, @url, @image_url, @price_text, @price_numeric, @price_currency,
          @bid_count, @time_left_text, @ends_at, @ending_soon, @location, @condition, strftime('%s','now'))
  ON CONFLICT(search_id, listing_id) DO UPDATE SET
    title = excluded.title,
    url = excluded.url,
    image_url = excluded.image_url,
    price_text = excluded.price_text,
    price_numeric = excluded.price_numeric,
    price_currency = excluded.price_currency,
    bid_count = excluded.bid_count,
    time_left_text = excluded.time_left_text,
    ends_at = excluded.ends_at,
    ending_soon = excluded.ending_soon,
    location = excluded.location,
    condition = excluded.condition,
    last_seen_at = strftime('%s','now')
`);

export function upsertListing(row) {
  const existed = db
    .prepare('SELECT 1 FROM listings WHERE search_id = ? AND listing_id = ?')
    .get(row.search_id, row.listing_id);
  upsertListingStmt.run({
    search_id: row.search_id,
    listing_id: row.listing_id,
    title: row.title,
    url: row.url,
    image_url: row.image_url ?? null,
    price_text: row.price_text ?? null,
    price_numeric: row.price_numeric ?? null,
    price_currency: row.price_currency ?? null,
    bid_count: row.bid_count ?? null,
    time_left_text: row.time_left_text ?? null,
    ends_at: row.ends_at ?? null,
    ending_soon: row.ending_soon ? 1 : 0,
    location: row.location ?? null,
    condition: row.condition ?? null,
  });
  return { isNew: !existed };
}

export function listListings({ activeOnly = true } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const sql = `
    SELECT l.*, s.name AS search_name, s.url AS search_url,
           s.required_keywords AS search_required_keywords,
           s.forbidden_keywords AS search_forbidden_keywords,
           s.pc_psa10_cents AS search_pc_psa10_cents
    FROM listings l
    JOIN searches s ON s.id = l.search_id
    ${activeOnly ? 'WHERE l.ends_at IS NULL OR l.ends_at > ?' : ''}
    ORDER BY (l.ends_at IS NULL), l.ends_at ASC
  `;
  const stmt = db.prepare(sql);
  return activeOnly ? stmt.all(nowSec) : stmt.all();
}

export function listListingsForSearch(searchId) {
  const nowSec = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `SELECT l.*, s.required_keywords AS search_required_keywords,
              s.forbidden_keywords AS search_forbidden_keywords,
              s.pc_psa10_cents AS search_pc_psa10_cents
       FROM listings l
       JOIN searches s ON s.id = l.search_id
       WHERE l.search_id = ? AND (l.ends_at IS NULL OR l.ends_at > ?)
       ORDER BY (l.ends_at IS NULL), l.ends_at ASC`
    )
    .all(searchId, nowSec);
}

export function createRun() {
  const info = db.prepare('INSERT INTO runs DEFAULT VALUES').run();
  return info.lastInsertRowid;
}

export function finishRun(id, fields) {
  db.prepare(
    `UPDATE runs SET
       finished_at = strftime('%s','now'),
       searches_run = ?,
       listings_found = ?,
       new_listings = ?,
       error = ?,
       email_sent = ?
     WHERE id = ?`
  ).run(
    fields.searches_run ?? 0,
    fields.listings_found ?? 0,
    fields.new_listings ?? 0,
    fields.error ?? null,
    fields.email_sent ? 1 : 0,
    id
  );
}

export function getLastRun() {
  return db
    .prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1')
    .get();
}

export function enableNotification({ listing_id, search_id, title, url, ends_at }) {
  if (!listing_id || !ends_at) return;
  db.prepare(
    `INSERT INTO notifications (listing_id, search_id, title, url, ends_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(listing_id) DO UPDATE SET
       search_id = excluded.search_id,
       title     = excluded.title,
       url       = excluded.url,
       ends_at   = excluded.ends_at`
  ).run(listing_id, search_id ?? null, title ?? null, url ?? null, ends_at);
}

export function disableNotification(listing_id) {
  // Only remove if not yet sent — keep history of sent ones for audit
  db.prepare(
    'DELETE FROM notifications WHERE listing_id = ? AND notified_at IS NULL'
  ).run(listing_id);
}

export function activeNotificationListingIds() {
  return new Set(
    db
      .prepare('SELECT listing_id FROM notifications WHERE notified_at IS NULL')
      .all()
      .map((r) => r.listing_id)
  );
}

export function listPendingNotifications({ leadSeconds = 3600 } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `SELECT * FROM notifications
       WHERE notified_at IS NULL
         AND ends_at IS NOT NULL
         AND ends_at - ? BETWEEN 0 AND ?
       ORDER BY ends_at ASC`
    )
    .all(nowSec, leadSeconds);
}

export function markNotified(id, error = null) {
  db.prepare(
    `UPDATE notifications SET notified_at = strftime('%s','now'), error = ? WHERE id = ?`
  ).run(error, id);
}

if (process.argv.includes('--init')) {
  console.log(`DB initialized at ${DB_PATH}`);
  process.exit(0);
}
