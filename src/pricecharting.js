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

  return {
    product_id: productId,
    product_name: productName,
    prices,
  };
}

export async function fetchProductInfo(url) {
  const html = await fetchPriceChartingPage(url);
  return parseProductPage(html);
}
