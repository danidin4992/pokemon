import * as cheerio from 'cheerio';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIE_JAR =
  process.env.COOKIE_JAR ||
  (process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, '.ebay-cookies.txt')
    : path.join(__dirname, '..', '.ebay-cookies.txt'));

const cookieDir = path.dirname(COOKIE_JAR);
if (!fs.existsSync(cookieDir)) fs.mkdirSync(cookieDir, { recursive: true });

const BASE_HEADERS = [
  'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language: en-US,en;q=0.9',
  'sec-ch-ua: "Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile: ?0',
  'sec-ch-ua-platform: "macOS"',
  'Sec-Fetch-Dest: document',
  'Sec-Fetch-Mode: navigate',
  'Upgrade-Insecure-Requests: 1',
];

function isFreshCookieJar() {
  try {
    const stat = fs.statSync(COOKIE_JAR);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs < 6 * 60 * 60 * 1000; // 6h
  } catch {
    return false;
  }
}

async function warmupSession() {
  const args = [
    '-sSL', '--compressed', '--max-time', '30',
    '-c', COOKIE_JAR,
    '-H', 'Sec-Fetch-Site: none',
    '-H', 'Sec-Fetch-User: ?1',
  ];
  for (const h of BASE_HEADERS) args.push('-H', h);
  args.push('https://www.ebay.com/');
  try {
    await execFileP('curl', args, { maxBuffer: 5 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`Session warmup failed: ${err.message}`);
  }
}

async function curlSearchPage(url) {
  const args = [
    '-sSL', '--compressed', '--max-time', '30',
    '-b', COOKIE_JAR, '-c', COOKIE_JAR,
    '-H', 'Sec-Fetch-Site: same-origin',
    '-H', 'Sec-Fetch-User: ?1',
    '-H', 'Referer: https://www.ebay.com/',
  ];
  for (const h of BASE_HEADERS) args.push('-H', h);
  args.push(url);
  const { stdout } = await execFileP('curl', args, { maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

// eBay's bot detection blocks plain Node fetch (TLS fingerprint) and plain
// curl requests without a session. We warm up cookies from the homepage first,
// then issue the search with those cookies + a Referer.
export async function fetchSearchPage(url) {
  if (!isFreshCookieJar()) {
    await warmupSession();
  }

  let html = await curlSearchPage(url);
  if (html.includes('Error Page | eBay') || html.length < 50000) {
    // Cookies might have expired or been flagged — refresh and retry once.
    await warmupSession();
    html = await curlSearchPage(url);
  }
  if (html.includes('Error Page | eBay') || html.length < 50000) {
    throw new Error(`eBay served an error page (length=${html.length}) — bot-blocked`);
  }
  return html;
}

const CURRENCY_SYMBOLS = {
  '$': 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '¥': 'JPY',
  'C$': 'CAD',
  'A$': 'AUD',
};

function parsePrice(text) {
  if (!text) return { price_numeric: null, price_currency: null };
  const cleaned = text.trim();
  let currency = null;
  let numericPart = cleaned;

  const codeMatch = cleaned.match(/^([A-Z]{3})\s/);
  if (codeMatch) {
    currency = codeMatch[1];
    numericPart = cleaned.slice(codeMatch[0].length);
  } else {
    for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) {
      if (cleaned.startsWith(sym)) {
        currency = code;
        numericPart = cleaned.slice(sym.length);
        break;
      }
    }
  }

  const numMatch = numericPart.match(/[\d,]+(\.\d+)?/);
  if (!numMatch) return { price_numeric: null, price_currency: currency };
  const price = parseFloat(numMatch[0].replace(/,/g, ''));
  return { price_numeric: isNaN(price) ? null : price, price_currency: currency };
}

function parseTimeLeft(timeText) {
  if (!timeText) return null;
  const t = timeText.trim().toLowerCase();
  let totalSeconds = 0;
  const dayMatch = t.match(/(\d+)\s*d/);
  const hourMatch = t.match(/(\d+)\s*h/);
  const minMatch = t.match(/(\d+)\s*m(?!o)/);
  const secMatch = t.match(/(\d+)\s*s(?!\s*$|ec)/);
  if (dayMatch) totalSeconds += parseInt(dayMatch[1]) * 86400;
  if (hourMatch) totalSeconds += parseInt(hourMatch[1]) * 3600;
  if (minMatch) totalSeconds += parseInt(minMatch[1]) * 60;
  if (secMatch) totalSeconds += parseInt(secMatch[1]);
  if (totalSeconds === 0) return null;
  return Math.floor(Date.now() / 1000) + totalSeconds;
}

function cleanUrl(href) {
  if (!href) return null;
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`;
  } catch {
    return href;
  }
}

export function parseListings(html) {
  // eBay broadens the search with a "rewrite" / related-items block when
  // there are few exact matches. The boundary marker is
  // `srp-river-answer--REWRITE_START`. Everything after it is unrelated.
  // We slice the HTML at that marker before parsing so cheerio only sees
  // the genuine results.
  const rewriteIdx = html.indexOf('srp-river-answer--REWRITE_START');
  const usable = rewriteIdx > 0 ? html.substring(0, rewriteIdx) : html;
  const $ = cheerio.load(usable);
  const listings = [];

  $('li.s-card').each((_, el) => {
    const $el = $(el);
    const listingId = $el.attr('data-listingid');
    if (!listingId || listingId === '123456') return;

    const title = $el.find('.s-card__title span').first().text().trim();
    if (!title) return;

    const itemLink = $el.find('a.s-card__link[href*="/itm/"]').first().attr('href');
    const url = cleanUrl(itemLink);
    if (!url || url.includes('/itm/123456')) return;

    const image_url =
      $el.find('img.s-card__image').attr('data-defer-load') ||
      $el.find('img.s-card__image').attr('src') ||
      null;

    const price_text = $el.find('.s-card__price').first().text().trim();
    const { price_numeric, price_currency } = parsePrice(price_text);

    let bid_count = null;
    $el.find('.s-card__attribute-row .su-styled-text').each((_, sp) => {
      const txt = $(sp).text().trim();
      const bidMatch = txt.match(/^(\d+)\s+bids?$/i);
      if (bidMatch) bid_count = parseInt(bidMatch[1]);
    });

    const time_left_text = $el.find('.s-card__time-left').first().text().trim() || null;
    const ends_at = parseTimeLeft(time_left_text);
    const ending_soon = $el.find('.s-card__time--soon').length > 0;

    let location = null;
    $el.find('.s-card__attribute-row').each((_, row) => {
      const txt = $(row).text().trim();
      const m = txt.match(/Located in (.+)/i) || txt.match(/From (.+)/i);
      if (m) location = m[1].trim();
    });

    const condition = $el.find('.s-card__subtitle').first().text().trim() || null;

    listings.push({
      listing_id: listingId,
      title,
      url,
      image_url,
      price_text,
      price_numeric,
      price_currency,
      bid_count,
      time_left_text,
      ends_at,
      ending_soon,
      location,
      condition,
    });
  });

  return listings;
}

export async function scrapeSearch(url) {
  const html = await fetchSearchPage(url);
  return parseListings(html);
}
