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
    listing_id TEXT NOT NULL,
    lead_seconds INTEGER NOT NULL DEFAULT 3600,
    search_id INTEGER,
    title TEXT,
    url TEXT,
    ends_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    notified_at INTEGER,
    error TEXT,
    UNIQUE(listing_id, lead_seconds)
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_pending ON notifications(notified_at, ends_at);

  CREATE TABLE IF NOT EXISTS pc_price_history (
    search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
    tier TEXT NOT NULL DEFAULT 'psa10',
    ts_ms INTEGER NOT NULL,
    price_cents INTEGER NOT NULL,
    PRIMARY KEY (search_id, tier, ts_ms)
  );

  CREATE TABLE IF NOT EXISTS hot_listings (
    listing_id TEXT PRIMARY KEY,
    search_id INTEGER,
    title TEXT,
    url TEXT,
    ends_at INTEGER,
    added_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS hot_polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    bid_usd_cents INTEGER,
    bid_count INTEGER,
    price_text TEXT,
    ends_at INTEGER,
    source TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_hot_polls_listing ON hot_polls(listing_id, ts_ms);

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
  add('pc_ace10_cents', 'INTEGER');
  add('pc_cgc_pristine_10_cents', 'INTEGER');
  add('pc_updated_at', 'INTEGER');

  // Add tier column to pc_price_history if absent, backfill existing rows as psa10
  const histCols = db.prepare(`PRAGMA table_info(pc_price_history)`).all().map((c) => c.name);
  if (histCols.length && !histCols.includes('tier')) {
    db.exec(`
      ALTER TABLE pc_price_history RENAME TO _pc_price_history_old;
      CREATE TABLE pc_price_history (
        search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
        tier TEXT NOT NULL DEFAULT 'psa10',
        ts_ms INTEGER NOT NULL,
        price_cents INTEGER NOT NULL,
        PRIMARY KEY (search_id, tier, ts_ms)
      );
      INSERT INTO pc_price_history (search_id, tier, ts_ms, price_cents)
        SELECT search_id, 'psa10', ts_ms, price_cents FROM _pc_price_history_old;
      DROP TABLE _pc_price_history_old;
    `);
  }
  add('required_keywords', 'TEXT'); // JSON array of strings
  add('forbidden_keywords', 'TEXT'); // JSON array of strings
  add('pc_image_url', 'TEXT'); // PriceCharting product image
  add('pack_odds', 'INTEGER'); // 1 in N packs (manual research)

  // Migrate notifications: add lead_seconds column + composite UNIQUE.
  // Rebuild table if old schema (UNIQUE on listing_id alone) is detected.
  const notifCols = db.prepare(`PRAGMA table_info(notifications)`).all().map((c) => c.name);
  if (notifCols.length && !notifCols.includes('lead_seconds')) {
    db.exec(`
      ALTER TABLE notifications RENAME TO _notifications_old;
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id TEXT NOT NULL,
        lead_seconds INTEGER NOT NULL DEFAULT 3600,
        recipient TEXT NOT NULL DEFAULT 'daniel',
        search_id INTEGER,
        title TEXT,
        url TEXT,
        ends_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        notified_at INTEGER,
        error TEXT,
        UNIQUE(listing_id, lead_seconds, recipient)
      );
      INSERT INTO notifications
        (listing_id, lead_seconds, recipient, search_id, title, url, ends_at, created_at, notified_at, error)
      SELECT listing_id, 3600, 'daniel', search_id, title, url, ends_at, created_at, notified_at, error
      FROM _notifications_old;
      DROP TABLE _notifications_old;
      CREATE INDEX IF NOT EXISTS idx_notifications_pending ON notifications(notified_at, ends_at);
    `);
  }
  // Second migration: add recipient to a table that already has lead_seconds
  // (fresh 32-migration deploys) but not yet recipient (33 migration).
  if (notifCols.length && notifCols.includes('lead_seconds') && !notifCols.includes('recipient')) {
    db.exec(`
      ALTER TABLE notifications RENAME TO _notifications_old;
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id TEXT NOT NULL,
        lead_seconds INTEGER NOT NULL DEFAULT 3600,
        recipient TEXT NOT NULL DEFAULT 'daniel',
        search_id INTEGER,
        title TEXT,
        url TEXT,
        ends_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        notified_at INTEGER,
        error TEXT,
        UNIQUE(listing_id, lead_seconds, recipient)
      );
      INSERT INTO notifications
        (listing_id, lead_seconds, recipient, search_id, title, url, ends_at, created_at, notified_at, error)
      SELECT listing_id, lead_seconds, 'daniel', search_id, title, url, ends_at, created_at, notified_at, error
      FROM _notifications_old;
      DROP TABLE _notifications_old;
      CREATE INDEX IF NOT EXISTS idx_notifications_pending ON notifications(notified_at, ends_at);
    `);
  }
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

export function updateSearch(id, { name, url, active, pricecharting_url, required_keywords, forbidden_keywords, pack_odds }) {
  // pack_odds explicit-null-clears requires special handling: undefined = keep, null = clear, number = set
  const packOddsPart = pack_odds === undefined
    ? 'pack_odds = pack_odds'
    : pack_odds === null
      ? 'pack_odds = NULL'
      : `pack_odds = ${parseInt(pack_odds) || null}`;
  db.prepare(
    `UPDATE searches SET
       name = COALESCE(?, name),
       url = COALESCE(?, url),
       active = COALESCE(?, active),
       pricecharting_url = COALESCE(?, pricecharting_url),
       required_keywords = COALESCE(?, required_keywords),
       forbidden_keywords = COALESCE(?, forbidden_keywords),
       ${packOddsPart}
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
       pc_image_url = COALESCE(?, pc_image_url),
       pc_loose_cents = ?,
       pc_grade7_cents = ?,
       pc_grade8_cents = ?,
       pc_grade9_cents = ?,
       pc_grade9_5_cents = ?,
       pc_psa10_cents = ?,
       pc_ace10_cents = ?,
       pc_cgc_pristine_10_cents = ?,
       pc_updated_at = strftime('%s','now')
     WHERE id = ?`
  ).run(
    info.product_id ?? null,
    info.product_name ?? null,
    info.image_url ?? null,
    info.prices?.loose ?? null,
    info.prices?.grade7 ?? null,
    info.prices?.grade8 ?? null,
    info.prices?.grade9 ?? null,
    info.prices?.grade9_5 ?? null,
    info.prices?.psa10 ?? null,
    info.prices?.ace10 ?? null,
    info.prices?.cgc_pristine_10 ?? null,
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

const LISTING_SELECT_COLS = `
  l.*, s.name AS search_name, s.url AS search_url,
  s.required_keywords AS search_required_keywords,
  s.forbidden_keywords AS search_forbidden_keywords,
  s.pc_psa10_cents AS search_pc_psa10_cents,
  s.pc_ace10_cents AS search_pc_ace10_cents,
  s.pc_cgc_pristine_10_cents AS search_pc_cgc_pristine_10_cents
`;

export function listListings({ activeOnly = true } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const sql = `
    SELECT ${LISTING_SELECT_COLS}
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
      `SELECT ${LISTING_SELECT_COLS}
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

export function listRuns(limit = 50) {
  return db
    .prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?')
    .all(limit);
}

export function markHot({ listing_id, search_id, title, url, ends_at }) {
  if (!listing_id) return;
  db.prepare(
    `INSERT INTO hot_listings (listing_id, search_id, title, url, ends_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(listing_id) DO UPDATE SET
       search_id = excluded.search_id,
       title     = excluded.title,
       url       = excluded.url,
       ends_at   = excluded.ends_at`
  ).run(listing_id, search_id ?? null, title ?? null, url ?? null, ends_at ?? null);
}

export function unmarkHot(listing_id) {
  db.prepare('DELETE FROM hot_listings WHERE listing_id = ?').run(listing_id);
}

export function activeHotListingIds() {
  return new Set(
    db.prepare('SELECT listing_id FROM hot_listings').all().map((r) => r.listing_id)
  );
}

export function listHotListings() {
  return db.prepare('SELECT * FROM hot_listings ORDER BY added_at DESC').all();
}

const insertHotPollStmt = db.prepare(
  `INSERT INTO hot_polls (listing_id, ts_ms, bid_usd_cents, bid_count, price_text, ends_at, source, error)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

export function insertHotPoll({ listing_id, ts_ms, bid_usd_cents, bid_count, price_text, ends_at, source, error }) {
  insertHotPollStmt.run(
    listing_id,
    ts_ms,
    bid_usd_cents ?? null,
    bid_count ?? null,
    price_text ?? null,
    ends_at ?? null,
    source ?? null,
    error ?? null
  );
}

export function getHotPollTimeline(listing_id, sinceMs = 0) {
  return db
    .prepare(
      `SELECT ts_ms, bid_usd_cents, bid_count, price_text, error
       FROM hot_polls
       WHERE listing_id = ? AND ts_ms > ?
       ORDER BY ts_ms ASC`
    )
    .all(listing_id, sinceMs);
}

export function pruneOldHotPolls(olderThanSec = 3600) {
  const cutoff = Date.now() - olderThanSec * 1000;
  db.prepare('DELETE FROM hot_polls WHERE ts_ms < ?').run(cutoff);
}

export function searchIdsWithHotOrEndingSoon(hoursAhead = 24) {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec + hoursAhead * 3600;
  const rows = db
    .prepare(
      `SELECT DISTINCT s.id FROM searches s
       LEFT JOIN listings l ON l.search_id = s.id
       LEFT JOIN hot_listings h ON h.listing_id = l.listing_id
       WHERE s.active = 1
         AND (h.listing_id IS NOT NULL OR (l.ends_at IS NOT NULL AND l.ends_at BETWEEN ? AND ?))`
    )
    .all(nowSec, cutoff);
  return rows.map((r) => r.id);
}

export function enableNotification({ listing_id, lead_seconds, recipient, search_id, title, url, ends_at }) {
  if (!listing_id || !ends_at || !lead_seconds) return;
  const rec = recipient || 'daniel';
  db.prepare(
    `INSERT INTO notifications (listing_id, lead_seconds, recipient, search_id, title, url, ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(listing_id, lead_seconds, recipient) DO UPDATE SET
       search_id = excluded.search_id,
       title     = excluded.title,
       url       = excluded.url,
       ends_at   = excluded.ends_at`
  ).run(listing_id, lead_seconds, rec, search_id ?? null, title ?? null, url ?? null, ends_at);
}

export function disableNotification(listing_id, lead_seconds, recipient) {
  const rec = recipient || null;
  if (lead_seconds && rec) {
    db.prepare(
      'DELETE FROM notifications WHERE listing_id = ? AND lead_seconds = ? AND recipient = ? AND notified_at IS NULL'
    ).run(listing_id, lead_seconds, rec);
  } else if (lead_seconds) {
    db.prepare(
      'DELETE FROM notifications WHERE listing_id = ? AND lead_seconds = ? AND notified_at IS NULL'
    ).run(listing_id, lead_seconds);
  } else {
    db.prepare(
      'DELETE FROM notifications WHERE listing_id = ? AND notified_at IS NULL'
    ).run(listing_id);
  }
}

// Map of listing_id → Map of recipient → Set of lead_seconds
export function activeNotificationsByListing() {
  const rows = db
    .prepare('SELECT listing_id, lead_seconds, recipient FROM notifications WHERE notified_at IS NULL')
    .all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.listing_id)) map.set(r.listing_id, new Map());
    const byRecipient = map.get(r.listing_id);
    if (!byRecipient.has(r.recipient)) byRecipient.set(r.recipient, new Set());
    byRecipient.get(r.recipient).add(r.lead_seconds);
  }
  return map;
}

export function listPendingNotifications() {
  const nowSec = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `SELECT * FROM notifications
       WHERE notified_at IS NULL
         AND ends_at IS NOT NULL
         AND ends_at - ? BETWEEN 0 AND lead_seconds
       ORDER BY ends_at ASC`
    )
    .all(nowSec);
}

export function markNotified(id, error = null) {
  db.prepare(
    `UPDATE notifications SET notified_at = strftime('%s','now'), error = ? WHERE id = ?`
  ).run(error, id);
}

const upsertHistoryStmt = db.prepare(
  `INSERT INTO pc_price_history (search_id, tier, ts_ms, price_cents)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(search_id, tier, ts_ms) DO UPDATE SET price_cents = excluded.price_cents`
);

export function upsertPriceHistory(searchId, history, tier = 'psa10') {
  if (!Array.isArray(history) || history.length === 0) return;
  const tx = db.transaction((items) => {
    for (const p of items) {
      if (p && p.ts_ms && p.cents > 0) {
        upsertHistoryStmt.run(searchId, tier, p.ts_ms, p.cents);
      }
    }
  });
  tx(history);
}

export function snapshotTierPrice(searchId, tier, priceCents) {
  if (!priceCents || priceCents <= 0) return;
  // Snap ts to the current day at 00:00 UTC so re-runs on the same day
  // overwrite instead of accumulating.
  const now = new Date();
  const dayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  upsertHistoryStmt.run(searchId, tier, dayMs, priceCents);
}

export function getPriceHistory(searchId, tier = 'psa10') {
  return db
    .prepare(
      `SELECT ts_ms, price_cents FROM pc_price_history
       WHERE search_id = ? AND tier = ? ORDER BY ts_ms ASC`
    )
    .all(searchId, tier);
}

export function getAllPriceHistories(searchId) {
  const rows = db
    .prepare(
      `SELECT tier, ts_ms, price_cents FROM pc_price_history
       WHERE search_id = ? ORDER BY tier, ts_ms ASC`
    )
    .all(searchId);
  const out = {};
  for (const r of rows) {
    if (!out[r.tier]) out[r.tier] = [];
    out[r.tier].push({ ts_ms: r.ts_ms, price_cents: r.price_cents });
  }
  return out;
}

if (process.argv.includes('--init')) {
  console.log(`DB initialized at ${DB_PATH}`);
  process.exit(0);
}
