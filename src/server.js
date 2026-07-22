import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import {
  listSearches,
  createSearch,
  updateSearch,
  updateSearchPrices,
  deleteSearch,
  clearListingsForSearch,
  listListings,
  listListingsForSearch,
  getLastRun,
  listRuns,
  getSettings,
  setSetting,
  enableNotification,
  disableNotification,
  activeNotificationsByListing,
  upsertPriceHistory,
  getPriceHistory,
  getAllPriceHistories,
  snapshotTierPrice,
  markHot,
  unmarkHot,
  activeHotListingIds,
  listHotListings,
  searchIdsWithHotOrEndingSoon,
  getHotPollTimeline,
  pruneOldHotPolls,
} from './db.js';
import { runAllSearches } from './runner.js';
import { sendDigest } from './emailer.js';
import { fetchProductInfo } from './pricecharting.js';
import { matchesListing } from './filters.js';
import { toUsdCents, getCachedRates, refreshRatesIfStale } from './currency.js';
import { startNotifier, runNotifier, getRecipients } from './notifier.js';
import { startHotPoller, getActivePollListingIds } from './hotpoller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Unauthenticated healthcheck — used by Railway / uptime monitors.
// Must come BEFORE the auth middleware so it isn't gated.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Basic Auth: gate everything if AUTH_PASSWORD is set. Local dev with no
// AUTH_PASSWORD env var skips auth entirely (so the local UI keeps working).
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
const AUTH_USERNAME = process.env.AUTH_USERNAME || 'admin';
if (AUTH_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Basic ') ? header.slice(6) : '';
    let user = '', pass = '';
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      user = decoded.slice(0, idx);
      pass = decoded.slice(idx + 1);
    } catch {}
    const ok =
      user === AUTH_USERNAME &&
      pass.length === AUTH_PASSWORD.length &&
      Buffer.from(pass).equals(Buffer.from(AUTH_PASSWORD));
    if (!ok) {
      res.set('WWW-Authenticate', 'Basic realm="pokemon-auctions"');
      return res.status(401).send('Authentication required');
    }
    next();
  });
}

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/searches', (req, res) => {
  const rows = listSearches();
  const enriched = rows.map((s) => {
    const all = getAllPriceHistories(s.id);
    return {
      ...s,
      psa10_history: all.psa10 || [],
      ace10_history: all.ace10 || [],
      cgc_pristine_10_history: all.cgc_pristine_10 || [],
    };
  });
  res.json(enriched);
});

app.post('/api/searches', async (req, res) => {
  const { name, url, pricecharting_url } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  if (!url.includes('ebay.com')) return res.status(400).json({ error: 'must be an ebay.com URL' });
  if (pricecharting_url && !pricecharting_url.includes('pricecharting.com')) {
    return res.status(400).json({ error: 'pricecharting_url must be a pricecharting.com URL' });
  }
  const id = createSearch({ name, url, pricecharting_url });
  if (pricecharting_url) {
    try {
      const info = await fetchProductInfo(pricecharting_url);
      updateSearchPrices(id, info);
    } catch (e) {
      // soft-fail; user can refresh later
    }
  }
  res.json({ id });
});

app.patch('/api/searches/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const before = listSearches().find((s) => s.id === id);
  updateSearch(id, req.body || {});
  // If the eBay URL changed, the old listings belong to a different search —
  // clear them so the UI doesn't show stale results until the next scrape.
  if (before && req.body?.url && req.body.url !== before.url) {
    clearListingsForSearch(id);
  }
  if (req.body?.pricecharting_url) {
    try {
      const info = await fetchProductInfo(req.body.pricecharting_url);
      updateSearchPrices(id, info);
    } catch (e) {}
  }
  res.json({ ok: true });
});

app.post('/api/searches/:id/refresh-prices', async (req, res) => {
  const id = parseInt(req.params.id);
  const search = listSearches().find((s) => s.id === id);
  if (!search) return res.status(404).json({ error: 'not found' });
  if (!search.pricecharting_url) return res.status(400).json({ error: 'no pricecharting_url' });
  try {
    const info = await fetchProductInfo(search.pricecharting_url);
    updateSearchPrices(id, info);
    if (info.psa10_history?.length) upsertPriceHistory(id, info.psa10_history, 'psa10');
    snapshotTierPrice(id, 'psa10', info.prices?.psa10);
    snapshotTierPrice(id, 'ace10', info.prices?.ace10);
    snapshotTierPrice(id, 'cgc_pristine_10', info.prices?.cgc_pristine_10);
    res.json({ ok: true, info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/searches/:id', (req, res) => {
  deleteSearch(parseInt(req.params.id));
  res.json({ ok: true });
});

function filterListings(rows) {
  const settings = getSettings();
  return rows.filter((row) =>
    matchesListing(
      row.title,
      {
        required_keywords: row.search_required_keywords,
        forbidden_keywords: row.search_forbidden_keywords,
      },
      settings
    )
  );
}

function annotateUsd(rows) {
  const rates = getCachedRates();
  const notifyMap = activeNotificationsByListing();
  const hotIds = activeHotListingIds();
  return rows.map((r) => {
    const perRecipient = notifyMap.get(r.listing_id);
    const notifyByRecipient = {};
    if (perRecipient) {
      for (const [rec, leads] of perRecipient) {
        notifyByRecipient[rec] = [...leads].sort((a, b) => a - b);
      }
    }
    return {
      ...r,
      price_usd_cents: toUsdCents(r.price_numeric, r.price_currency, rates),
      notify_by_recipient: notifyByRecipient,
      is_hot: hotIds.has(r.listing_id),
    };
  });
}

app.get('/api/recipients', (req, res) => {
  const recipients = getRecipients();
  res.json(
    Object.values(recipients).map((r) => ({ key: r.key, label: r.label }))
  );
});

app.get('/api/listings', (req, res) => {
  const searchId = req.query.search_id ? parseInt(req.query.search_id) : null;
  const includeExcluded = req.query.all === '1';
  let rows = searchId ? listListingsForSearch(searchId) : listListings({ activeOnly: true });
  if (!includeExcluded) rows = filterListings(rows);
  rows = annotateUsd(rows);
  res.json(rows);
});

const ALLOWED_LEADS = new Set([300, 900, 1800, 3600]);

function validateRecipient(req, res) {
  const rec = req.query.recipient || req.body?.recipient || 'daniel';
  const recipients = getRecipients();
  if (!recipients[rec]) {
    res.status(400).json({ error: `unknown recipient "${rec}". known: ${Object.keys(recipients).join(', ')}` });
    return null;
  }
  return rec;
}

app.post('/api/notify/:listingId/:leadSeconds', (req, res) => {
  const listingId = req.params.listingId;
  const leadSeconds = parseInt(req.params.leadSeconds);
  if (!ALLOWED_LEADS.has(leadSeconds)) {
    return res.status(400).json({ error: 'lead_seconds must be one of 300, 900, 1800, 3600' });
  }
  const recipient = validateRecipient(req, res);
  if (!recipient) return;
  const listing = listListings({ activeOnly: false }).find(
    (l) => l.listing_id === listingId
  );
  if (!listing) return res.status(404).json({ error: 'listing not found' });
  if (!listing.ends_at) return res.status(400).json({ error: 'listing has no end time' });
  enableNotification({
    listing_id: listing.listing_id,
    lead_seconds: leadSeconds,
    recipient,
    search_id: listing.search_id,
    title: listing.title,
    url: listing.url,
    ends_at: listing.ends_at,
  });
  res.json({ ok: true, recipient });
});

app.delete('/api/notify/:listingId/:leadSeconds', (req, res) => {
  const leadSeconds = parseInt(req.params.leadSeconds);
  const recipient = validateRecipient(req, res);
  if (!recipient) return;
  disableNotification(req.params.listingId, leadSeconds, recipient);
  res.json({ ok: true, recipient });
});

app.post('/api/notify-now', async (req, res) => {
  try {
    const result = await runNotifier();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/hot/:listingId', (req, res) => {
  const listingId = req.params.listingId;
  const listing = listListings({ activeOnly: false }).find(
    (l) => l.listing_id === listingId
  );
  if (!listing) return res.status(404).json({ error: 'listing not found' });
  markHot({
    listing_id: listing.listing_id,
    search_id: listing.search_id,
    title: listing.title,
    url: listing.url,
    ends_at: listing.ends_at,
  });
  res.json({ ok: true });
});

app.delete('/api/hot/:listingId', (req, res) => {
  unmarkHot(req.params.listingId);
  res.json({ ok: true });
});

app.get('/api/hot', (req, res) => {
  const rows = listHotListings();
  const active = new Set(getActivePollListingIds());
  res.json(rows.map((r) => ({ ...r, is_polling: active.has(r.listing_id) })));
});

app.get('/api/hot/:listingId/timeline', (req, res) => {
  const listingId = req.params.listingId;
  const since = parseInt(req.query.since) || 0;
  const polls = getHotPollTimeline(listingId, since);
  const active = getActivePollListingIds().includes(listingId);
  res.json({ polls, is_polling: active });
});

app.post('/api/refresh-rates', async (req, res) => {
  try {
    const rates = await refreshRatesIfStale();
    res.json({ ok: true, rate_count: Object.keys(rates).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

app.put('/api/settings', (req, res) => {
  const { global_required_keywords, global_forbidden_keywords } = req.body || {};
  if (Array.isArray(global_required_keywords)) {
    setSetting('global_required_keywords', global_required_keywords);
  }
  if (Array.isArray(global_forbidden_keywords)) {
    setSetting('global_forbidden_keywords', global_forbidden_keywords);
  }
  res.json(getSettings());
});

app.get('/api/last-run', (req, res) => {
  res.json(getLastRun() || null);
});

app.get('/api/ebay-usage', async (req, res) => {
  try {
    const { getUsage } = await import('./ebay-api.js');
    res.json(getUsage());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/runs', (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit) || 50);
  res.json(listRuns(limit));
});

let isRunning = false;
app.post('/api/run-now', async (req, res) => {
  if (isRunning) return res.status(409).json({ error: 'already running' });
  isRunning = true;
  const log = [];
  try {
    const result = await runAllSearches({
      onProgress: (e) => log.push(e),
    });
    let emailSent = false;
    if (req.body?.sendEmail && process.env.RESEND_API_KEY) {
      try {
        await sendDigest();
        emailSent = true;
      } catch (e) {
        log.push({ stage: 'email-error', error: e.message });
      }
    }
    result.finish({ emailSent });
    res.json({
      totalFound: result.totalFound,
      totalNew: result.totalNew,
      perSearch: result.perSearch,
      emailSent,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    isRunning = false;
  }
});

app.post('/api/send-email-now', async (req, res) => {
  try {
    await sendDigest();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// In-process daily cron — replaces launchd in cloud deploys.
// CRON_SCHEDULE default: 0 8 * * * (every day at 08:00). Set to "" to disable.
async function runWarmRefresh() {
  const searchIds = searchIdsWithHotOrEndingSoon(24);
  if (searchIds.length === 0) return { skipped: 'no hot or ending-soon searches' };
  const idSet = new Set(searchIds);
  const result = await runAllSearches({
    filterSearch: (s) => idSet.has(s.id),
    onProgress: (e) => {
      if (e.stage === 'scraped') console.log(`[warm]   ${e.search.name}: ${e.found} listings (${e.isNew} new)`);
      if (e.stage === 'error') console.error(`[warm]   ${e.search.name}: ${e.error}`);
    },
  });
  result.finish({ emailSent: false });
  return { searches: searchIds.length, found: result.totalFound, new: result.totalNew };
}

const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? '0 8 * * *';
const WARM_REFRESH_CRON = process.env.WARM_REFRESH_CRON || '';
if (CRON_SCHEDULE) {
  if (!cron.validate(CRON_SCHEDULE)) {
    console.error(`Invalid CRON_SCHEDULE "${CRON_SCHEDULE}" — cron disabled`);
  } else {
    cron.schedule(
      CRON_SCHEDULE,
      async () => {
        if (isRunning) {
          console.log('[cron] Skipping — manual run in progress');
          return;
        }
        isRunning = true;
        const startedAt = new Date();
        console.log(`[cron ${startedAt.toISOString()}] Starting daily run`);
        try {
          const result = await runAllSearches({
            onProgress: (e) => {
              if (e.stage === 'scraped') console.log(`[cron]   ${e.search.name}: ${e.found} listings (${e.isNew} new)`);
              if (e.stage === 'error') console.error(`[cron]   ${e.search.name}: ${e.error}`);
            },
          });
          let emailSent = false;
          if (process.env.RESEND_API_KEY) {
            try {
              await sendDigest();
              emailSent = true;
            } catch (e) {
              console.error('[cron] Email failed:', e.message);
            }
          }
          result.finish({ emailSent });
          console.log(`[cron] Done: ${result.totalFound} listings, ${result.totalNew} new, email=${emailSent}`);
        } catch (err) {
          console.error('[cron] Run failed:', err);
        } finally {
          isRunning = false;
        }
      },
      { timezone: process.env.CRON_TIMEZONE || 'Asia/Jerusalem' }
    );
    console.log(`⏰ Daily cron scheduled: "${CRON_SCHEDULE}" (${process.env.CRON_TIMEZONE || 'Asia/Jerusalem'})`);
  }
}

if (WARM_REFRESH_CRON) {
  if (!cron.validate(WARM_REFRESH_CRON)) {
    console.error(`Invalid WARM_REFRESH_CRON "${WARM_REFRESH_CRON}" — warm refresh disabled`);
  } else {
    cron.schedule(WARM_REFRESH_CRON, async () => {
      if (isRunning) return;
      isRunning = true;
      try {
        console.log(`[warm ${new Date().toISOString()}] Starting refresh`);
        const result = await runWarmRefresh();
        console.log(`[warm] Done:`, result);
      } catch (e) {
        console.error('[warm] Error:', e);
      } finally {
        isRunning = false;
      }
    }, { timezone: process.env.CRON_TIMEZONE || 'Asia/Jerusalem' });
    console.log(`🔥 Warm refresh scheduled: "${WARM_REFRESH_CRON}"`);
  }
} else {
  console.log(`🔥 Warm refresh disabled (set WARM_REFRESH_CRON to enable, e.g. "*/90 * * * *")`);
}

// Temporary: force API path once regardless of EBAY_DATA_SOURCE — for smoke test.
app.post('/api/ebay-api-smoke/:searchId', async (req, res) => {
  try {
    const id = parseInt(req.params.searchId);
    const s = listSearches().find((x) => x.id === id);
    if (!s) return res.status(404).json({ error: 'search not found' });
    const { apiDataSource } = await import('./datasource.js');
    const listings = await apiDataSource.listBySearchUrl(s.url);
    res.json({ count: listings.length, sample: listings.slice(0, 3) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/warm-refresh-now', async (req, res) => {
  if (isRunning) return res.status(409).json({ error: 'run in progress' });
  isRunning = true;
  try {
    const result = await runWarmRefresh();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    isRunning = false;
  }
});

const PORT = process.env.PORT || 3737;
app.listen(PORT, () => {
  console.log(`🎴 pokemon-auctions server running at http://localhost:${PORT}`);
  if (AUTH_PASSWORD) console.log(`🔒 Basic Auth enabled (user: ${AUTH_USERNAME})`);
  startNotifier();
  startHotPoller();
  // Housekeeping: keep hot_polls from growing forever
  setInterval(() => pruneOldHotPolls(6 * 3600), 10 * 60 * 1000);
});
