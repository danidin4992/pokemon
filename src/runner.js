import {
  listSearches,
  upsertListing,
  createRun,
  finishRun,
  updateSearchPrices,
  deleteListingsNotInSet,
} from './db.js';
import { scrapeSearch } from './scraper.js';
import { fetchProductInfo } from './pricecharting.js';
import { refreshRatesIfStale } from './currency.js';

export async function runAllSearches({ onProgress } = {}) {
  const runId = createRun();
  try {
    await refreshRatesIfStale();
  } catch (e) {
    onProgress?.({ stage: 'rates-error', error: e.message });
  }
  const searches = listSearches({ activeOnly: true });

  let totalFound = 0;
  let totalNew = 0;
  const perSearch = [];
  let firstError = null;

  for (const search of searches) {
    try {
      onProgress?.({ stage: 'scraping', search });
      const listings = await scrapeSearch(search.url);
      let newCount = 0;
      const seenIds = [];
      for (const l of listings) {
        const { isNew } = upsertListing({ ...l, search_id: search.id });
        if (isNew) newCount++;
        seenIds.push(l.listing_id);
      }
      // Authoritative: this run is the source of truth for this search.
      // Any listings not in this run are gone from eBay's results — drop them.
      if (listings.length > 0) {
        deleteListingsNotInSet(search.id, seenIds);
      }
      totalFound += listings.length;
      totalNew += newCount;
      perSearch.push({ search, found: listings.length, isNew: newCount });
      onProgress?.({ stage: 'scraped', search, found: listings.length, isNew: newCount });

      if (search.pricecharting_url) {
        try {
          onProgress?.({ stage: 'pc-fetching', search });
          const info = await fetchProductInfo(search.pricecharting_url);
          updateSearchPrices(search.id, info);
          onProgress?.({ stage: 'pc-fetched', search, info });
        } catch (e) {
          onProgress?.({ stage: 'pc-error', search, error: e.message });
        }
      }

      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    } catch (err) {
      const msg = err.message || String(err);
      perSearch.push({ search, error: msg });
      onProgress?.({ stage: 'error', search, error: msg });
      if (!firstError) firstError = `${search.name}: ${msg}`;
    }
  }

  return {
    runId,
    perSearch,
    totalFound,
    totalNew,
    finish: ({ emailSent } = {}) => {
      finishRun(runId, {
        searches_run: searches.length,
        listings_found: totalFound,
        new_listings: totalNew,
        error: firstError,
        email_sent: emailSent,
      });
    },
  };
}
