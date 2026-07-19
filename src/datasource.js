/**
 * Data source abstraction — insulates the runner from the underlying eBay
 * fetch mechanism. Today we only have HTML scraping via curl. When the eBay
 * Developer API access is approved (waiting on eBay's review), we plug in a
 * second implementation here without touching the runner, DB, UI, or email.
 *
 * The contract each impl fulfills:
 *   listBySearchUrl(url) → array of listing objects matching parseListings()
 *   listByItemId(id)     → single listing object (or null) — used for hot polling
 *
 * Choice of impl is decided at import time by env vars:
 *   EBAY_API_TOKEN present + EBAY_DATA_SOURCE=api → API
 *   otherwise                                     → scrape (default)
 */
import { scrapeSearch } from './scraper.js';

export const scrapeDataSource = {
  name: 'scrape',
  async listBySearchUrl(url) {
    return await scrapeSearch(url);
  },
  async listByItemId(_itemId) {
    throw new Error('Per-item polling requires the eBay API — enable EBAY_API_TOKEN');
  },
};

// Placeholder: fills in when we swap in the Buy Browse API.
// The shape it returns must match the scraper's parseListings() output so the
// rest of the app (DB upsert, UI render, notifier enrichment) needs zero changes.
export const apiDataSource = {
  name: 'api',
  async listBySearchUrl(_url) {
    throw new Error('eBay Browse API adapter not implemented yet — waiting on developer approval');
  },
  async listByItemId(_itemId) {
    throw new Error('eBay Browse API adapter not implemented yet — waiting on developer approval');
  },
};

const wantApi =
  process.env.EBAY_DATA_SOURCE === 'api' && !!process.env.EBAY_API_TOKEN;

export const datasource = wantApi ? apiDataSource : scrapeDataSource;

console.log(`📡 Data source: ${datasource.name}`);
