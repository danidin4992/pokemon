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
  getSettings,
  setSetting,
} from './db.js';
import { runAllSearches } from './runner.js';
import { sendDigest } from './emailer.js';
import { fetchProductInfo } from './pricecharting.js';
import { matchesListing } from './filters.js';
import { toUsdCents, getCachedRates, refreshRatesIfStale } from './currency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

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
  res.json(listSearches());
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
  return rows.map((r) => ({
    ...r,
    price_usd_cents: toUsdCents(r.price_numeric, r.price_currency, rates),
  }));
}

app.get('/api/listings', (req, res) => {
  const searchId = req.query.search_id ? parseInt(req.query.search_id) : null;
  const includeExcluded = req.query.all === '1';
  let rows = searchId ? listListingsForSearch(searchId) : listListings({ activeOnly: true });
  if (!includeExcluded) rows = filterListings(rows);
  rows = annotateUsd(rows);
  res.json(rows);
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
const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? '0 8 * * *';
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

const PORT = process.env.PORT || 3737;
app.listen(PORT, () => {
  console.log(`🎴 pokemon-auctions server running at http://localhost:${PORT}`);
  if (AUTH_PASSWORD) console.log(`🔒 Basic Auth enabled (user: ${AUTH_USERNAME})`);
});
