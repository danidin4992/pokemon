import * as cheerio from 'cheerio';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

// HTML cell id => semantic name (per PriceCharting's own labeling)
// Reference: PriceCharting card grading tiers
const PRICE_FIELDS = {
  used_price: 'loose',        // Ungraded / raw
  complete_price: 'grade7',   // CIB / Grade 7-7.5
  new_price: 'grade8',        // Grade 8-8.5
  graded_price: 'grade9',     // PSA/CGC/BGS 9
  box_only_price: 'grade9_5', // Grade 9.5
  manual_only_price: 'psa10', // PSA 10
};

function parsePriceCents(text) {
  if (!text) return null;
  const cleaned = text.trim();
  if (cleaned === '-' || cleaned === '') return null;
  const match = cleaned.match(/\$([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  const dollars = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(dollars)) return null;
  return Math.round(dollars * 100);
}

export async function fetchPriceChartingPage(url) {
  const args = [
    '-sSL', '--compressed', '--max-time', '30',
    '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    url,
  ];
  const { stdout } = await execFileP('curl', args, { maxBuffer: 10 * 1024 * 1024 });
  if (stdout.length < 5000) {
    throw new Error(`PriceCharting returned short response (${stdout.length} bytes)`);
  }
  return stdout;
}

function extractPsa10History(html) {
  // PriceCharting embeds Highcharts series data in a global:
  //   VGPC.chart_data = {"manualonly":[[ts_ms, price_cents], ...], ...}
  // We only care about manualonly (= PSA 10).
  const marker = 'VGPC.chart_data';
  const start = html.indexOf(marker);
  if (start < 0) return [];
  const braceStart = html.indexOf('{', start);
  if (braceStart < 0) return [];
  // Naive brace-balance to find the closing }
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < html.length; i++) {
    const c = html[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return [];
  const jsonStr = html.substring(braceStart, end + 1);
  let obj;
  try { obj = JSON.parse(jsonStr); } catch { return []; }
  const series = obj.manualonly;
  if (!Array.isArray(series)) return [];
  return series
    .filter((pt) => Array.isArray(pt) && pt.length === 2 && pt[1] > 0)
    .map(([ts_ms, cents]) => ({ ts_ms: Math.floor(ts_ms), cents: Math.round(cents) }));
}

function extractProductImage($) {
  // PriceCharting hosts product images at
  // storage.googleapis.com/images.pricecharting.com/{hash}/240.jpg
  // Only the 240px size is actually uploaded — larger sizes return 404.
  let src = null;
  $('img').each((_, el) => {
    const s = $(el).attr('src') || '';
    if (s.includes('storage.googleapis.com/images.pricecharting.com/')) {
      src = s;
      return false;
    }
  });
  return src;
}

export function parseProductPage(html) {
  const $ = cheerio.load(html);

  const productIdAttr =
    $('[data-product-id]').first().attr('data-product-id') || null;
  const productId = productIdAttr ? String(productIdAttr).trim() : null;

  const productName =
    $('h1#product_name').text().replace(/\s+/g, ' ').trim() ||
    ($('title').text().split('|')[0] || '').trim() ||
    null;

  const prices = {};
  for (const [cellId, key] of Object.entries(PRICE_FIELDS)) {
    const priceText = $(`#${cellId} .price.js-price`).first().text().trim();
    prices[key] = parsePriceCents(priceText);
  }

  const psa10History = extractPsa10History(html);
  const image_url = extractProductImage($);

  return {
    product_id: productId,
    product_name: productName,
    image_url,
    prices,
    psa10_history: psa10History,
  };
}

export async function fetchProductInfo(url) {
  const html = await fetchPriceChartingPage(url);
  return parseProductPage(html);
}
