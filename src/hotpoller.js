import { listHotListings, insertHotPoll } from './db.js';
import { datasource } from './datasource.js';

// User-configurable via env — the intent is set exactly to their spec:
//   - final 30 sec: poll every 500ms (2 Hz)
//   - final 10 sec: poll every 333ms (3 Hz)
const WINDOW_START_SEC = parseInt(process.env.HOT_WINDOW_SEC || '30');
const FAST_WINDOW_SEC = parseInt(process.env.HOT_FAST_WINDOW_SEC || '10');
const SLOW_MS = parseInt(process.env.HOT_SLOW_MS || '500');
const FAST_MS = parseInt(process.env.HOT_FAST_MS || '333');

// Set of listing_ids currently being intensively polled
const activePolls = new Map(); // listing_id -> { stop: () => void }

function secUntilEnd(endsAtSec) {
  return endsAtSec - Math.floor(Date.now() / 1000);
}

async function pollOnce(listing) {
  const startMs = Date.now();
  try {
    const snap = await datasource.listByItemId(listing.listing_id);
    insertHotPoll({
      listing_id: listing.listing_id,
      ts_ms: Date.now(),
      bid_usd_cents: snap.bid_usd_cents,
      bid_count: snap.bid_count,
      price_text: snap.price_text,
      ends_at: snap.ends_at,
      source: datasource.name,
      error: null,
    });
    return snap;
  } catch (err) {
    insertHotPoll({
      listing_id: listing.listing_id,
      ts_ms: startMs,
      source: datasource.name,
      error: err.message || String(err),
    });
    return null;
  }
}

async function runPollLoop(listing) {
  const listingId = listing.listing_id;
  console.log(`🔥 [hot] Started polling ${listingId} (${listing.title?.substring(0, 40)}…)`);
  let cancelled = false;
  activePolls.set(listingId, { stop: () => { cancelled = true; } });

  try {
    while (!cancelled) {
      const remaining = secUntilEnd(listing.ends_at);
      if (remaining <= 0) break;
      const interval = remaining <= FAST_WINDOW_SEC ? FAST_MS : SLOW_MS;
      const cycleStart = Date.now();
      await pollOnce(listing);
      const elapsed = Date.now() - cycleStart;
      const sleepMs = Math.max(0, interval - elapsed);
      await new Promise((r) => setTimeout(r, sleepMs));
    }
    // One final poll right after end to record the closing state
    await pollOnce(listing);
  } finally {
    activePolls.delete(listingId);
    console.log(`🔥 [hot] Stopped polling ${listingId}`);
  }
}

function scanAndSchedule() {
  const hot = listHotListings();
  for (const l of hot) {
    if (!l.ends_at) continue;
    if (activePolls.has(l.listing_id)) continue;
    const remaining = secUntilEnd(l.ends_at);
    if (remaining <= 0) continue;
    if (remaining <= WINDOW_START_SEC) {
      runPollLoop(l).catch((e) => console.error('[hot] loop error:', e));
    }
  }
}

let scanHandle = null;
export function startHotPoller() {
  if (scanHandle) return;
  console.log(`🔥 Hot poller armed — activates last ${WINDOW_START_SEC}s (${SLOW_MS}ms), ramps to ${FAST_MS}ms at last ${FAST_WINDOW_SEC}s`);
  // Scan every second so a listing that crosses into the window is picked up quickly
  scanHandle = setInterval(() => {
    try { scanAndSchedule(); } catch (e) { console.error('[hot] scan error:', e); }
  }, 1000);
}

export function getActivePollListingIds() {
  return [...activePolls.keys()];
}
