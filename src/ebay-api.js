import 'dotenv/config';

// eBay Buy Browse API adapter (production).
//
// OAuth 2.0 client-credentials flow: exchange App ID + Cert ID for an app
// access token, cache it until ~5 min before expiry, then reuse.
//
// Docs:
//   - OAuth flow: https://developer.ebay.com/api-docs/static/oauth-client-credentials-grant.html
//   - Search:     https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search
//   - Item:       https://developer.ebay.com/api-docs/buy/browse/resources/item/methods/getItem

const OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const ITEM_URL = 'https://api.ebay.com/buy/browse/v1/item';
const MARKETPLACE = process.env.EBAY_MARKETPLACE || 'EBAY_US';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';

let cachedToken = null;
let cachedExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedExpiresAt - now > 5 * 60 * 1000) return cachedToken;

  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  if (!appId || !certId) {
    throw new Error('EBAY_APP_ID and EBAY_CERT_ID must be set');
  }
  const basic = Buffer.from(`${appId}:${certId}`).toString('base64');

  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`eBay OAuth failed ${res.status}: ${text.substring(0, 200)}`);
  }
  const json = await res.json();
  cachedToken = json.access_token;
  cachedExpiresAt = now + (json.expires_in || 7200) * 1000;
  return cachedToken;
}

// Translate a user-crafted eBay web search URL into Browse API query params.
// Handles the common ones we see in this project:
//   _nkw=X            → q=X                (keyword)
//   _dcat=X           → category_ids=X     (category)
//   LH_Auction=1      → filter: AUCTION
//   LH_BIN=1          → filter: FIXED_PRICE
//   _sop=1|15         → sort=endingSoonest
//   _sop=12           → sort=newlyListed
//   Grade=10          → aspect_filter Grade:{10}
//   Language=English  → aspect_filter Language:{English}
//   Any other capitalised key → treated as an aspect filter
export function webUrlToApiParams(webUrl) {
  const u = new URL(webUrl);
  const p = u.searchParams;
  const out = { limit: '200' };
  const filters = [];
  const aspects = [];

  const kw = p.get('_nkw');
  if (kw) out.q = kw;

  const cat = p.get('_dcat') || p.get('_sacat');
  if (cat && cat !== '0') {
    out.category_ids = cat;
    aspects.push(`categoryId:${cat}`);
  }

  if (p.get('LH_Auction') === '1' && p.get('LH_BIN') !== '1') {
    filters.push('buyingOptions:{AUCTION}');
  } else if (p.get('LH_BIN') === '1' && p.get('LH_Auction') !== '1') {
    filters.push('buyingOptions:{FIXED_PRICE}');
  }

  const sop = p.get('_sop');
  if (sop === '1' || sop === '15') out.sort = 'endingSoonest';
  else if (sop === '12') out.sort = 'newlyListed';

  // Every param starting with an uppercase letter is treated as an aspect.
  for (const [key, val] of p.entries()) {
    if (!/^[A-Z]/.test(key)) continue;
    if (['Language'].includes(key) && val === 'English') aspects.push(`Language:{English}`);
    else if (key === 'Grade' && /^\d+(\.\d+)?$/.test(val)) aspects.push(`Grade:{${val}}`);
    else aspects.push(`${key}:{${val}}`);
  }

  if (filters.length) out.filter = filters.join(',');
  // aspect_filter must include categoryId for eBay to accept the aspects
  if (aspects.length > 0 && aspects.some((a) => a.startsWith('categoryId:'))) {
    out.aspect_filter = aspects.join(',');
  }

  return out;
}

function paramsToQueryString(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.set(k, v);
  return sp.toString();
}

// Convert Browse API itemSummary into the same shape scraper.parseListings()
// returns, so the DB layer, filters, UI, notifier, etc. don't change.
function summaryToListing(s) {
  const priceObj = s.currentBidPrice || s.price || null;
  const priceNum = priceObj && !isNaN(parseFloat(priceObj.value)) ? parseFloat(priceObj.value) : null;
  const currency = priceObj?.currency || null;
  const priceText = priceObj ? `${currency} ${priceObj.value}` : null;
  const endsAt = s.itemEndDate
    ? Math.floor(new Date(s.itemEndDate).getTime() / 1000)
    : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const endingSoon = endsAt != null && endsAt - nowSec <= 3600;
  const timeLeftText = endsAt ? tersifyDelta(endsAt - nowSec) : null;
  const url = s.itemWebUrl ? stripUrlQuery(s.itemWebUrl) : null;

  return {
    listing_id: s.legacyItemId || s.itemId?.split('|')[1] || null,
    title: s.title,
    url,
    image_url: s.image?.imageUrl || s.thumbnailImages?.[0]?.imageUrl || null,
    price_text: priceText,
    price_numeric: priceNum,
    price_currency: currency,
    bid_count: typeof s.bidCount === 'number' ? s.bidCount : null,
    time_left_text: timeLeftText,
    ends_at: endsAt,
    ending_soon: endingSoon,
    location: s.itemLocation?.country || null,
    condition: s.condition || null,
  };
}

function tersifyDelta(sec) {
  if (sec == null || sec <= 0) return 'ended';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function stripUrlQuery(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

export async function searchByWebUrl(webUrl) {
  const params = webUrlToApiParams(webUrl);
  const token = await getAccessToken();
  const qs = paramsToQueryString(params);
  const res = await fetch(`${SEARCH_URL}?${qs}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`eBay Browse search ${res.status}: ${text.substring(0, 300)}`);
  }
  const json = await res.json();
  const summaries = Array.isArray(json.itemSummaries) ? json.itemSummaries : [];
  return summaries.map(summaryToListing).filter((l) => l.listing_id && l.title);
}

export async function getItemById(itemId) {
  if (!/^\d+$/.test(String(itemId))) throw new Error('itemId must be numeric');
  const token = await getAccessToken();
  // Browse API uses the "v1|..." legacy-item wrapper for its item endpoint,
  // but the legacy_item_id endpoint accepts the plain numeric id.
  const url = `${ITEM_URL}/get_item_by_legacy_id?legacy_item_id=${itemId}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`eBay Browse item ${res.status}: ${text.substring(0, 200)}`);
  }
  const it = await res.json();
  const priceObj = it.currentBidPrice || it.price || null;
  const priceNum = priceObj && !isNaN(parseFloat(priceObj.value)) ? parseFloat(priceObj.value) : null;
  const currency = priceObj?.currency || null;
  const bidUsdCents =
    priceObj && currency === 'USD' && !isNaN(priceNum)
      ? Math.round(priceNum * 100)
      : null;
  const endsAt = it.itemEndDate ? Math.floor(new Date(it.itemEndDate).getTime() / 1000) : null;
  return {
    bid_usd_cents: bidUsdCents,
    bid_count: typeof it.bidCount === 'number' ? it.bidCount : null,
    ends_at: endsAt,
    price_text: priceObj ? `${currency} ${priceObj.value}` : null,
    price_currency: currency,
    price_numeric: priceNum,
    title: it.title || null,
  };
}
