import 'dotenv/config';
import { Resend } from 'resend';
import { listSearches, listListingsForSearch, getSettings } from './db.js';
import { matchesListing } from './filters.js';
import { toUsdCents, formatUsd, getCachedRates } from './currency.js';

function fmtPrice(l, rates) {
  const cents = toUsdCents(l.price_numeric, l.price_currency, rates);
  if (cents != null) return formatUsd(cents);
  return l.price_text || '—';
}

function renderEmailDiff(bidCents, marketCents) {
  if (bidCents == null || marketCents == null || marketCents === 0) return '';
  const diff = bidCents - marketCents;
  const pct = Math.round((diff / marketCents) * 100);
  const sign = diff > 0 ? '+' : (diff < 0 ? '−' : '');
  const abs = formatUsd(Math.abs(diff));
  const bg = diff < 0 ? '#e6f6ec' : (diff > 0 ? '#fde8e8' : '#f0f0f0');
  const color = diff < 0 ? '#1b7a3d' : (diff > 0 ? '#b1241c' : '#666');
  return `<div style="margin-top:6px;padding:3px 8px;background:${bg};color:${color};border-radius:4px;font-size:11px;font-weight:700;display:inline-block">
    ${sign}${abs} · ${sign}${Math.abs(pct)}% vs PSA 10
  </div>`;
}

function fmtTimeLeft(l) {
  if (l.time_left_text) return l.time_left_text;
  if (!l.ends_at) return '—';
  const sec = l.ends_at - Math.floor(Date.now() / 1000);
  if (sec <= 0) return 'ended';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtEndTimeInTz(endAtSec, tz) {
  if (!endAtSec) return '';
  const d = new Date(endAtSec * 1000);
  const time = d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const nowDay = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const endDay = d.toLocaleDateString('en-CA', { timeZone: tz });
  if (nowDay === endDay) return time;
  const weekday = d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
  return `${weekday} ${time}`;
}

function fmtEndTimes(endAtSec) {
  if (!endAtSec) return '';
  const il = fmtEndTimeInTz(endAtSec, 'Asia/Jerusalem');
  const ny = fmtEndTimeInTz(endAtSec, 'America/New_York');
  return `${il} IL · ${ny} NY`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildDigestHtml() {
  const searches = listSearches({ activeOnly: true });
  const settings = getSettings();
  const rates = getCachedRates();
  const todayIso = new Date().toISOString().slice(0, 10);

  let body = '';
  let totalEnding = 0;

  for (const s of searches) {
    const raw = listListingsForSearch(s.id);
    const filtered = raw.filter((l) =>
      matchesListing(
        l.title,
        { required_keywords: s.required_keywords, forbidden_keywords: s.forbidden_keywords },
        settings
      )
    );
    const ending24h = filtered.filter(
      (l) => l.ends_at && l.ends_at - Math.floor(Date.now() / 1000) <= 86400
    );
    totalEnding += ending24h.length;

    body += `<h2 style="margin:30px 0 10px;font-family:system-ui,sans-serif;font-size:18px;color:#0053a0">
      ${escapeHtml(s.name)}
      <span style="font-weight:normal;font-size:13px;color:#666">— ${ending24h.length} ending in 24h / ${filtered.length} matching</span>
    </h2>`;
    const marketCents = s.pc_psa10_cents;
    if (s.pricecharting_url && marketCents != null) {
      const fmtUsdInt = (c) => (c == null ? '—' : '$' + (c / 100).toFixed(0));
      body += `<div style="font-size:12px;color:#666;margin:-4px 0 8px;font-family:system-ui,sans-serif">
        <strong style="color:#b45f00">PSA 10 market: ${fmtUsdInt(marketCents)}</strong>
      </div>`;
    }

    if (ending24h.length === 0) {
      body += `<p style="color:#999;font-family:system-ui,sans-serif;font-size:13px;margin:0 0 10px">No auctions ending in the next 24h.</p>`;
      continue;
    }

    body += `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;font-family:system-ui,sans-serif;font-size:13px">`;
    for (const l of ending24h) {
      body += `<tr style="border-bottom:1px solid #eee">
        <td style="width:80px;padding:8px 4px;vertical-align:top">
          ${l.image_url ? `<img src="${escapeHtml(l.image_url)}" width="70" style="display:block;border-radius:4px">` : ''}
        </td>
        <td style="padding:8px;vertical-align:top">
          <a href="${escapeHtml(l.url)}" style="color:#0053a0;text-decoration:none;font-weight:600">${escapeHtml(l.title)}</a>
          <div style="color:#666;margin-top:4px">
            ${escapeHtml(l.condition || '')} ${l.location ? `· ${escapeHtml(l.location)}` : ''}
          </div>
        </td>
        <td style="padding:8px;vertical-align:top;text-align:right;white-space:nowrap">
          <div style="font-weight:700;font-size:14px" title="${escapeHtml(l.price_text || '')}">${escapeHtml(fmtPrice(l, rates))}</div>
          <div style="color:#666;margin-top:4px">${l.bid_count ?? 0} bids</div>
          <div style="color:#e53238;font-weight:600;margin-top:2px">${escapeHtml(fmtTimeLeft(l))}</div>
          <div style="color:#888;font-size:11px;margin-top:2px">${escapeHtml(fmtEndTimes(l.ends_at))}</div>
          ${renderEmailDiff(toUsdCents(l.price_numeric, l.price_currency, rates), marketCents)}
        </td>
      </tr>`;
    }
    body += `</table>`;
  }

  const html = `<!doctype html>
<html><body style="margin:0;padding:20px;background:#f5f5f5">
<div style="max-width:680px;margin:0 auto;background:white;padding:24px;border-radius:8px;font-family:system-ui,sans-serif">
  <h1 style="margin:0 0 4px;font-size:22px;color:#111">🎴 Pokemon auctions — ${todayIso}</h1>
  <p style="margin:0 0 20px;color:#666;font-size:14px">${totalEnding} auctions ending in the next 24 hours across ${searches.length} watched searches.</p>
  ${body}
  <hr style="margin:32px 0;border:0;border-top:1px solid #eee">
  <p style="color:#999;font-size:12px;text-align:center;margin:0">
    Sent by your local pokemon-auctions agent.
  </p>
</div>
</body></html>`;

  return { html, totalEnding, searchCount: searches.length };
}

export async function sendDigest() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not set in .env');
  }
  if (!process.env.DIGEST_TO_EMAIL) {
    throw new Error('DIGEST_TO_EMAIL not set in .env');
  }

  const { html, totalEnding } = buildDigestHtml();
  const resend = new Resend(process.env.RESEND_API_KEY);
  const todayIso = new Date().toISOString().slice(0, 10);

  const { data, error } = await resend.emails.send({
    from: process.env.DIGEST_FROM_EMAIL || 'onboarding@resend.dev',
    to: process.env.DIGEST_TO_EMAIL,
    subject: `🎴 Pokemon auctions — ${totalEnding} ending today (${todayIso})`,
    html,
  });

  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
  return data;
}
