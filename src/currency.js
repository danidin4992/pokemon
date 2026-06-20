import { getSettings, setSetting } from './db.js';

const RATES_TTL_SEC = 23 * 3600; // refresh once a day

export async function fetchRates() {
  const res = await fetch('https://open.er-api.com/v6/latest/USD', {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Exchange rate API returned ${res.status}`);
  const json = await res.json();
  if (json.result !== 'success' || !json.rates) {
    throw new Error('Exchange rate API returned no rates');
  }
  return json.rates;
}

export async function refreshRatesIfStale() {
  const settings = getSettings();
  const fetchedAt = settings.exchange_rates_fetched_at;
  const now = Math.floor(Date.now() / 1000);
  if (fetchedAt && now - fetchedAt < RATES_TTL_SEC && settings.exchange_rates) {
    return settings.exchange_rates;
  }
  const rates = await fetchRates();
  setSetting('exchange_rates', rates);
  setSetting('exchange_rates_fetched_at', now);
  return rates;
}

export function getCachedRates() {
  const settings = getSettings();
  return settings.exchange_rates || null;
}

// Convert a numeric price + ISO-4217 currency code to USD cents (integer).
// Returns null if currency unknown or input invalid.
export function toUsdCents(amount, currency, rates) {
  if (amount == null || isNaN(amount)) return null;
  if (!currency) return null;
  if (currency === 'USD') return Math.round(amount * 100);
  if (!rates) return null;
  const rate = rates[currency]; // 1 USD = X currency
  if (!rate || rate <= 0) return null;
  return Math.round((amount / rate) * 100);
}

export function formatUsd(cents) {
  if (cents == null) return '—';
  const dollars = cents / 100;
  if (dollars >= 1000) {
    return '$' + dollars.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  return '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
