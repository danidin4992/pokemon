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
import { scrapeSearch, fetchItemPage } from './scraper.js';
import { searchByWebUrl, getItemById } from './ebay-api.js';

export const scrapeDataSource = {
  name: 'scrape',
  async listBySearchUrl(url) {
    return await scrapeSearch(url);
  },
  async listByItemId(itemId) {
    return await fetchItemPage(itemId);
  },
};

// Official eBay Buy Browse API. Returns the same shape as parseListings()
// so DB/UI/notifier/hot-poller need no changes.
export const apiDataSource = {
  name: 'api',
  async listBySearchUrl(url) {
    return await searchByWebUrl(url);
  },
  async listByItemId(itemId) {
    return await getItemById(itemId);
  },
};

const wantApi =
  process.env.EBAY_DATA_SOURCE === 'api' && !!process.env.EBAY_API_TOKEN;

export const datasource = wantApi ? apiDataSource : scrapeDataSource;

console.log(`📡 Data source: ${datasource.name}`);
