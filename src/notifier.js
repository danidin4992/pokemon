import 'dotenv/config';
import {
  listPendingNotifications,
  markNotified,
  db,
} from './db.js';
import { toUsdCents, formatUsd, getCachedRates } from './currency.js';

const WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL;
const POLL_INTERVAL_MS = 60 * 1000; // check every 60s

function enrichListing(n) {
  // Look up the current listing row to include live bid + market data
  const listing = db
    .prepare(
      `SELECT l.*, s.pc_psa10_cents AS market_psa10_cents
       FROM listings l
       LEFT JOIN searches s ON s.id = l.search_id
       WHERE l.listing_id = ?`
    )
    .get(n.listing_id);
  if (!listing) return null;
  const rates = getCachedRates();
  const bidCents = toUsdCents(listing.price_numeric, listing.price_currency, rates);
  const marketCents = listing.market_psa10_cents;
  const diffCents = bidCents != null && marketCents != null ? bidCents - marketCents : null;
  const diffPct = diffCents != null && marketCents ? Math.round((diffCents / marketCents) * 100) : null;
  return {
    title: n.title || listing.title,
    url: n.url || listing.url,
    listing_id: n.listing_id,
    ends_at_iso: new Date(n.ends_at * 1000).toISOString(),
    ends_in_minutes: Math.max(0, Math.round((n.ends_at - Date.now() / 1000) / 60)),
    current_bid_usd: bidCents != null ? bidCents / 100 : null,
    current_bid_text: listing.price_text,
    bids: listing.bid_count,
    psa10_market_usd: marketCents != null ? marketCents / 100 : null,
    diff_usd: diffCents != null ? diffCents / 100 : null,
    diff_pct: diffPct,
    is_below_market: diffCents != null ? diffCents < 0 : null,
    image_url: listing.image_url,
    location: listing.location,
  };
}

function fmtUsd(cents) {
  if (cents == null) return '—';
  const d = cents / 100;
  return d >= 1000 ? '$' + Math.round(d).toLocaleString('en-US') : '$' + d.toFixed(2);
}

function ntfyTopicFromUrl(url) {
  // Detect ntfy.sh URLs and split into (root, topic).
  const m = url.match(/^(https?:\/\/[^/]*ntfy\.sh)\/([^/?#]+)/i);
  if (!m) return null;
  return { root: m[1], topic: m[2] };
}

// Build an ntfy JSON POST for the phone. Node's fetch requires ASCII headers,
// so we can't put emoji in Title — using ntfy's JSON API instead means Unicode
// (title, message, tags) all pass through cleanly.
async function fireWebhook(payload) {
  const ntfy = ntfyTopicFromUrl(WEBHOOK_URL);
  if (ntfy) {
    const bidStr = fmtUsd(payload.current_bid_usd != null ? payload.current_bid_usd * 100 : null);
    const marketStr = fmtUsd(payload.psa10_market_usd != null ? payload.psa10_market_usd * 100 : null);
    const diffLine =
      payload.diff_pct != null
        ? `${payload.is_below_market ? '↓' : '↑'} ${payload.diff_pct > 0 ? '+' : ''}${payload.diff_pct}% vs PSA 10`
        : '';
    const bidsLine = payload.bids != null ? `${payload.bids} bids` : '';
    const message = [
      `Ends in ~${payload.ends_in_minutes}m`,
      `Bid ${bidStr}  ·  Market ${marketStr}`,
      [diffLine, bidsLine].filter(Boolean).join('  ·  '),
    ]
      .filter(Boolean)
      .join('\n');

    const body = {
      topic: ntfy.topic,
      title: `🎴 ${(payload.title || 'Pokemon auction').substring(0, 90)}`,
      message,
      priority: payload.lead_minutes <= 5 ? 5 : 4, // 5 = max, wakes screen
      tags: payload.is_below_market
        ? ['fire', 'rocket', 'green_circle']
        : ['bell', 'rocket', 'red_circle'],
    };
    if (payload.url) {
      body.click = payload.url;
      body.actions = [{ action: 'view', label: 'Open on eBay', url: payload.url, clear: true }];
    }

    const res = await fetch(ntfy.root, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ntfy returned ${res.status} ${res.statusText} — ${text.substring(0, 200)}`);
    }
    return;
  }

  // Generic webhook (Slack / Discord / Zapier / custom) — original JSON body
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Webhook returned ${res.status} ${res.statusText}`);
}

export async function runNotifier() {
  if (!WEBHOOK_URL) return { skipped: 'NOTIFY_WEBHOOK_URL not set' };
  const pending = listPendingNotifications();
  if (pending.length === 0) return { sent: 0, errors: 0 };

  let sent = 0;
  let errors = 0;
  for (const n of pending) {
    const enriched = enrichListing(n);
    const payload = {
      type: 'auction_ending_soon',
      lead_minutes: Math.round(n.lead_seconds / 60),
      ...(enriched || {
        title: n.title,
        url: n.url,
        listing_id: n.listing_id,
        ends_at_iso: new Date(n.ends_at * 1000).toISOString(),
        ends_in_minutes: Math.max(0, Math.round((n.ends_at - Date.now() / 1000) / 60)),
      }),
    };

    try {
      await fireWebhook(payload);
      markNotified(n.id);
      sent++;
      console.log(`[notifier] Sent for ${payload.title?.substring(0, 40)} (ends in ${payload.ends_in_minutes}m)`);
    } catch (err) {
      // Mark with error so we don't retry forever — we'll try again NEXT poll
      // but stop retrying after ends_at has passed
      const msg = err.message || String(err);
      console.error(`[notifier] Failed for ${n.listing_id}: ${msg}`);
      errors++;
      // Only mark as notified (with error) if the auction already ended,
      // otherwise leave pending for retry
      if (n.ends_at < Math.floor(Date.now() / 1000)) {
        markNotified(n.id, msg);
      }
    }
  }
  return { sent, errors };
}

let intervalHandle = null;
export function startNotifier() {
  if (intervalHandle) return;
  if (!WEBHOOK_URL) {
    console.log('🔕 Notifier disabled — NOTIFY_WEBHOOK_URL not set');
    return;
  }
  console.log(`🔔 Notifier polling every ${POLL_INTERVAL_MS / 1000}s (per-notification leads, webhook: ${WEBHOOK_URL.replace(/\?.*/, '').replace(/(:\/\/[^/]+).*/, '$1/…')})`);
  intervalHandle = setInterval(() => {
    runNotifier().catch((e) => console.error('[notifier] Poll error:', e));
  }, POLL_INTERVAL_MS);
  // Run once immediately so a fresh startup catches pending items right away
  runNotifier().catch((e) => console.error('[notifier] Initial run error:', e));
}
