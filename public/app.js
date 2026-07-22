const $ = (s) => document.querySelector(s);

let searches = [];
let listings = [];
let settings = { global_required_keywords: [], global_forbidden_keywords: [] };
let recipients = [];
let currentRecipient = localStorage.getItem('pokemon-recipient') || 'daniel';
const currentSearchFilters = new Set(); // multi-select card ids (empty = show all)
const editingSearchId = new Set();

function parseCsv(v) {
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}
function joinCsv(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.join(', ');
}

function createTagInput(container, initialTags = [], placeholder = 'Type and press Enter…') {
  let tags = Array.isArray(initialTags) ? [...initialTags] : [];

  function render() {
    container.innerHTML =
      tags
        .map(
          (t, i) =>
            `<span class="tag-chip"><span class="tag-text">${escapeHtml(t)}</span><button type="button" class="tag-remove" data-i="${i}" aria-label="Remove ${escapeHtml(t)}">×</button></span>`
        )
        .join('') +
      `<input class="tag-add" placeholder="${escapeHtml(placeholder)}">`;
    bind();
  }

  function bind() {
    container.querySelectorAll('.tag-remove').forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        tags.splice(parseInt(btn.dataset.i), 1);
        render();
        focusInput();
      };
    });
    const input = container.querySelector('.tag-add');
    input.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        commitInput();
      } else if (e.key === 'Backspace' && !input.value && tags.length) {
        e.preventDefault();
        tags.pop();
        render();
        focusInput();
      }
    };
    input.onblur = () => commitInput();
    input.onpaste = (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (text && /[,\n]/.test(text)) {
        e.preventDefault();
        const parts = text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        for (const p of parts) if (!tags.includes(p)) tags.push(p);
        render();
        focusInput();
      }
    };
  }

  function commitInput() {
    const input = container.querySelector('.tag-add');
    if (!input) return;
    const v = input.value.trim();
    if (v && !tags.includes(v)) {
      tags.push(v);
      render();
      focusInput();
    }
  }

  function focusInput() {
    const input = container.querySelector('.tag-add');
    if (input) input.focus();
  }

  container.addEventListener('click', (e) => {
    if (e.target === container) focusInput();
  });

  render();

  return {
    get() {
      commitInput();
      return [...tags];
    },
    set(newTags) {
      tags = Array.isArray(newTags) ? [...newTags] : [];
      render();
    },
  };
}

function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

function fmtRelativeTime(sec) {
  if (!sec) return '—';
  const now = Math.floor(Date.now() / 1000);
  const diff = sec - now;
  if (diff <= 0) return 'ended';
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  return `${h}h ${m}m`;
}

function fmtAgo(sec) {
  if (!sec) return '—';
  const diff = Math.floor(Date.now() / 1000) - sec;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

async function loadSearches() {
  const res = await fetch('/api/searches');
  searches = await res.json();
  renderSearches();
  renderSearchFilter();
}

function fmtMoney(cents) {
  if (cents == null) return '—';
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtUsd(cents) {
  if (cents == null) return '—';
  const dollars = cents / 100;
  if (dollars >= 1000) return '$' + dollars.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

function renderEndTimes(endAtSec) {
  if (!endAtSec) return '';
  const il = fmtEndTimeInTz(endAtSec, 'Asia/Jerusalem');
  const ny = fmtEndTimeInTz(endAtSec, 'America/New_York');
  return `<div class="end-times">Ends <span class="tz">${il} IL</span> · <span class="tz">${ny} NY</span></div>`;
}

function fmtUsdCompact(cents) {
  if (cents == null) return '—';
  const d = cents / 100;
  if (d >= 1000) return '$' + (d / 1000).toFixed(1) + 'k';
  return '$' + Math.round(d);
}

const TIER_COLORS = {
  psa10: { line: '#e05a1c', fill: '#fce9dc', name: 'PSA 10' },
  ace10: { line: '#1b7a3d', fill: '#daf1e0', name: 'ACE 10' },
  cgc_pristine_10: { line: '#0053a0', fill: '#dbe7f4', name: 'CGC Pristine 10' },
};

function renderMultiSparkline(seriesByTier, opts = {}) {
  const W = opts.W || 460;
  const H = opts.H || 180;
  const PAD_L = opts.padL ?? 52;
  const PAD_R = opts.padR ?? 60;
  const PAD_T = opts.padT ?? 20;
  const PAD_B = opts.padB ?? 38;

  // Filter to tiers that actually have data
  const active = Object.keys(seriesByTier)
    .filter((k) => TIER_COLORS[k] && Array.isArray(seriesByTier[k]) && seriesByTier[k].some((p) => p.price_cents > 0))
    .map((k) => ({
      tier: k,
      color: TIER_COLORS[k],
      points: seriesByTier[k].filter((p) => p.price_cents > 0),
    }));
  if (active.length === 0) return '';

  // Global scale across all tiers
  const allValues = active.flatMap((s) => s.points.map((p) => p.price_cents));
  const allTimes = active.flatMap((s) => s.points.map((p) => p.ts_ms));
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const range = max - min || 1;
  const tMin = Math.min(...allTimes);
  const tMax = Math.max(...allTimes);
  const tRange = tMax - tMin || 1;

  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const xy = (p) => ({
    x: PAD_L + ((p.ts_ms - tMin) / tRange) * chartW,
    y: PAD_T + (1 - (p.price_cents - min) / range) * chartH,
  });

  // Axis lines + labels
  const midVal = min + range / 2;
  const gridMaxY = PAD_T;
  const gridMidY = PAD_T + chartH / 2;
  const gridMinY = PAD_T + chartH;

  // Series paths
  let seriesSvg = '';
  const legendItems = [];
  for (const s of active) {
    const pts = s.points.map(xy);
    if (pts.length === 1) {
      // single dot only — draw a bigger dot with label
      const p = pts[0];
      seriesSvg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${s.color.line}" stroke="white" stroke-width="1.5"/>`;
      seriesSvg += `<title>${s.color.name}: ${fmtUsd(s.points[0].price_cents)} (just started tracking)</title>`;
    } else {
      const d = 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L');
      seriesSvg += `<path d="${d}" fill="none" stroke="${s.color.line}" stroke-width="1.7"/>`;
      // Dots per point
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        seriesSvg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2" fill="${s.color.line}"><title>${new Date(s.points[i].ts_ms).toISOString().slice(0, 10)}: ${fmtUsd(s.points[i].price_cents)}</title></circle>`;
      }
      // Highlight last point
      const last = pts[pts.length - 1];
      seriesSvg += `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3.4" fill="${s.color.line}" stroke="white" stroke-width="1.5"/>`;
    }
    legendItems.push(
      `<span class="legend-item"><span class="legend-swatch" style="background:${s.color.line}"></span>${s.color.name} <strong>${fmtUsd(s.points[s.points.length - 1].price_cents)}</strong></span>`
    );
  }

  const firstDate = new Date(tMin).toISOString().slice(0, 7);
  const lastDate = new Date(tMax).toISOString().slice(0, 7);

  return `<div class="multi-spark-wrap">
    <div class="multi-spark-legend">${legendItems.join('')}</div>
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto">
      <line x1="${PAD_L}" y1="${gridMaxY}" x2="${W - PAD_R}" y2="${gridMaxY}" stroke="#eee" stroke-width="0.5" stroke-dasharray="2,3"/>
      <line x1="${PAD_L}" y1="${gridMidY}" x2="${W - PAD_R}" y2="${gridMidY}" stroke="#f2f2f2" stroke-width="0.5" stroke-dasharray="2,3"/>
      <line x1="${PAD_L}" y1="${gridMinY}" x2="${W - PAD_R}" y2="${gridMinY}" stroke="#eee" stroke-width="0.5" stroke-dasharray="2,3"/>
      <text x="${PAD_L - 4}" y="${gridMaxY + 3}" text-anchor="end" font-size="10" fill="#888" font-family="system-ui">${fmtUsdCompact(max)}</text>
      <text x="${PAD_L - 4}" y="${gridMidY + 3}" text-anchor="end" font-size="9" fill="#aaa" font-family="system-ui">${fmtUsdCompact(midVal)}</text>
      <text x="${PAD_L - 4}" y="${gridMinY + 3}" text-anchor="end" font-size="10" fill="#888" font-family="system-ui">${fmtUsdCompact(min)}</text>
      ${seriesSvg}
      <text x="${PAD_L}" y="${H - 6}" text-anchor="start" font-size="9" fill="#888" font-family="system-ui">${firstDate}</text>
      <text x="${W - PAD_R}" y="${H - 6}" text-anchor="end" font-size="9" fill="#888" font-family="system-ui">${lastDate}</text>
    </svg>
  </div>`;
}

function renderSparkline(history, currentCents, opts = {}) {
  if (!Array.isArray(history) || history.length < 2) return '';
  const W = opts.W || 320;
  const H = opts.H || 90;
  const PAD_L = opts.padL ?? 44, PAD_R = opts.padR ?? 52, PAD_T = opts.padT ?? 12, PAD_B = opts.padB ?? 22;
  const pts = history.filter((p) => p.price_cents > 0);
  if (pts.length < 2) return '';
  const values = pts.map((p) => p.price_cents);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const first = pts[0].ts_ms;
  const last = pts[pts.length - 1].ts_ms;
  const tRange = last - first || 1;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const xy = pts.map((p) => {
    const x = PAD_L + ((p.ts_ms - first) / tRange) * chartW;
    const y = PAD_T + (1 - (p.price_cents - min) / range) * chartH;
    return { x, y, ts: p.ts_ms, cents: p.price_cents };
  });
  const path = xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${path} L${xy[xy.length - 1].x.toFixed(1)},${PAD_T + chartH} L${xy[0].x.toFixed(1)},${PAD_T + chartH} Z`;
  const lastPt = xy[xy.length - 1];
  const firstPt = xy[0];

  const maxIdx = values.indexOf(max);
  const minIdx = values.indexOf(min);
  const maxPt = xy[maxIdx];
  const minPt = xy[minIdx];

  const dots = xy
    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.2" fill="#e05a1c"><title>${new Date(p.ts).toISOString().slice(0, 10)}: ${fmtUsd(p.cents)}</title></circle>`)
    .join('');

  const trend = pts[pts.length - 1].price_cents - pts[0].price_cents;
  const trendClass = trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat';
  const trendPct = Math.round((trend / pts[0].price_cents) * 100);
  const firstDate = new Date(pts[0].ts_ms).toISOString().slice(0, 7);
  const lastDate = new Date(pts[pts.length - 1].ts_ms).toISOString().slice(0, 7);

  // Y-axis grid lines: max and min horizontal reference lines with labels
  const gridMaxY = PAD_T;
  const gridMinY = PAD_T + chartH;
  const midY = PAD_T + chartH / 2;
  const midValue = min + range / 2;

  // Position the "current" and max/min labels beside their dots
  const currentLabelY = Math.max(PAD_T + 6, Math.min(H - PAD_B - 2, lastPt.y + 3));
  const maxLabelY = Math.max(PAD_T + 6, maxPt.y - 4);
  const minLabelY = Math.min(H - PAD_B - 2, minPt.y + 10);

  return `<div class="pc-spark ${trendClass}">
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet">
      <line x1="${PAD_L}" y1="${gridMaxY}" x2="${W - PAD_R}" y2="${gridMaxY}" stroke="#eee" stroke-width="0.5" stroke-dasharray="2,3"/>
      <line x1="${PAD_L}" y1="${midY}" x2="${W - PAD_R}" y2="${midY}" stroke="#f2f2f2" stroke-width="0.5" stroke-dasharray="2,3"/>
      <line x1="${PAD_L}" y1="${gridMinY}" x2="${W - PAD_R}" y2="${gridMinY}" stroke="#eee" stroke-width="0.5" stroke-dasharray="2,3"/>

      <text x="${PAD_L - 4}" y="${gridMaxY + 3}" text-anchor="end" font-size="10" fill="#888" font-family="system-ui">${fmtUsdCompact(max)}</text>
      <text x="${PAD_L - 4}" y="${midY + 3}" text-anchor="end" font-size="9" fill="#aaa" font-family="system-ui">${fmtUsdCompact(midValue)}</text>
      <text x="${PAD_L - 4}" y="${gridMinY + 3}" text-anchor="end" font-size="10" fill="#888" font-family="system-ui">${fmtUsdCompact(min)}</text>

      <path d="${areaPath}" fill="#fce9dc" opacity="0.55"/>
      <path d="${path}" fill="none" stroke="#e05a1c" stroke-width="1.6"/>
      ${dots}
      <circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="3.4" fill="#e05a1c" stroke="white" stroke-width="1.5"/>

      <text x="${lastPt.x + 6}" y="${currentLabelY}" font-size="11" fill="#b45f00" font-weight="700" font-family="system-ui">${fmtUsd(lastPt.cents)}</text>
      ${maxIdx !== pts.length - 1 && maxIdx !== 0 ? `<text x="${maxPt.x.toFixed(1)}" y="${maxLabelY}" text-anchor="middle" font-size="9" fill="#666" font-family="system-ui">${fmtUsdCompact(max)}</text>` : ''}
      ${minIdx !== pts.length - 1 && minIdx !== 0 ? `<text x="${minPt.x.toFixed(1)}" y="${minLabelY}" text-anchor="middle" font-size="9" fill="#666" font-family="system-ui">${fmtUsdCompact(min)}</text>` : ''}

      <text x="${firstPt.x.toFixed(1)}" y="${H - 6}" text-anchor="start" font-size="9" fill="#888" font-family="system-ui">${firstDate}</text>
      <text x="${lastPt.x.toFixed(1)}" y="${H - 6}" text-anchor="end" font-size="9" fill="#888" font-family="system-ui">${lastDate}</text>
    </svg>
    <div class="pc-spark-meta">
      <span class="pc-spark-current">${fmtUsd(lastPt.cents)}</span>
      <span class="pc-spark-range">${fmtUsdCompact(min)} – ${fmtUsdCompact(max)} · 6mo</span>
      <span class="pc-spark-trend">${trend > 0 ? '↑' : trend < 0 ? '↓' : '→'} ${trendPct > 0 ? '+' : ''}${trendPct}%</span>
    </div>
  </div>`;
}

function renderMiniSparkline(history) {
  if (!Array.isArray(history) || history.length < 2) return '';
  const W = 100, H = 24;
  const pts = history.filter((p) => p.price_cents > 0);
  if (pts.length < 2) return '';
  const values = pts.map((p) => p.price_cents);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const first = pts[0].ts_ms;
  const last = pts[pts.length - 1].ts_ms;
  const tRange = last - first || 1;
  const xy = pts.map((p) => {
    const x = ((p.ts_ms - first) / tRange) * W;
    const y = (1 - (p.price_cents - min) / range) * (H - 4) + 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = 'M' + xy.join(' L');
  const areaPath = path + ` L${W},${H} L0,${H} Z`;
  return `<svg class="mini-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${areaPath}" fill="#fce9dc" opacity="0.6"/>
    <path d="${path}" fill="none" stroke="#e05a1c" stroke-width="1.4"/>
  </svg>`;
}

// Fixed display order: PSA 10 → CGC Pristine 10 → ACE 10
const TIER_ORDER = [
  { key: 'pc_psa10_cents',           label: 'PSA 10',          cls: 'psa10' },
  { key: 'pc_cgc_pristine_10_cents', label: 'CGC Pristine 10', cls: 'cgc-pristine' },
  { key: 'pc_ace10_cents',           label: 'ACE 10',          cls: 'ace10' },
];

// Order tiers by current price, highest first.
function orderedTiers(s) {
  return TIER_ORDER
    .filter((t) => s[t.key] != null)
    .sort((a, b) => (s[b.key] ?? 0) - (s[a.key] ?? 0));
}

function renderCardTierChips(s, opts = {}) {
  const small = opts.small;
  return orderedTiers(s)
    .map(
      (t) =>
        `<span class="pc-tier ${t.cls}${small ? ' small' : ''}"><span class="label">${t.label}</span><span class="value">${escapeHtml(fmtMoney(s[t.key]))}</span></span>`
    )
    .join(' ');
}

// Vertical table-like tier list — one tier per row, label left, price right.
function renderCardTierTable(s) {
  return `<div class="pop-tier-table">
    ${orderedTiers(s).map((t) => `
      <div class="tier-row ${t.cls}">
        <span class="tier-label">${t.label}</span>
        <span class="tier-price">${escapeHtml(fmtMoney(s[t.key]))}</span>
      </div>`).join('')}
  </div>`;
}

function renderCardTile(s, opts = {}) {
  const psa10 = s.pc_psa10_cents != null ? fmtMoney(s.pc_psa10_cents) : '';
  const imgHtml = s.pc_image_url
    ? `<img class="card-image" src="${escapeHtml(s.pc_image_url)}" alt="${escapeHtml(s.name)}" loading="lazy" onerror="this.classList.add('failed');this.replaceWith(Object.assign(document.createElement('div'),{className:'card-image placeholder',textContent:'🎴'}))">`
    : `<div class="card-image placeholder">🎴</div>`;
  const isFiltered = currentSearchFilters.has(s.id);
  const rank = opts.rank;
  const rankCls = rank === 1 ? 'top1' : rank === 2 ? 'top2' : rank === 3 ? 'top3' : '';
  const rankBadge = rank ? `<span class="card-rank ${rankCls}">#${rank}</span>` : '';
  const oddsLine = s.pack_odds
    ? `<div class="card-odds-line">1 : ${s.pack_odds.toLocaleString('en-US')} packs</div>`
    : '';

  // Trend snippet + sparkline (only if we have history)
  let trendBar = '';
  if (Array.isArray(s.psa10_history) && s.psa10_history.length >= 2) {
    const pts = s.psa10_history.filter((p) => p.price_cents > 0);
    if (pts.length >= 2) {
      const diff = pts[pts.length - 1].price_cents - pts[0].price_cents;
      const pct = Math.round((diff / pts[0].price_cents) * 100);
      const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
      const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
      trendBar = `<div class="card-trend ${cls}">
        ${renderMiniSparkline(s.psa10_history)}
        <span class="trend-text">${arrow} ${pct > 0 ? '+' : ''}${pct}% <span class="trend-period">6mo</span></span>
      </div>`;
    }
  }

  const pcLink = s.pricecharting_url
    ? `<a class="card-pc-link" href="${escapeHtml(s.pricecharting_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Open on PriceCharting">PC ↗</a>`
    : '';

  const popover = s.pc_psa10_cents != null ? renderCardPopover(s) : '';

  const tierMini = renderCardTierChips(s, { small: true });
  return `
    <div class="card-tile ${s.active ? '' : 'inactive'} ${isFiltered ? 'active-filter' : ''}" data-id="${s.id}">
      ${rankBadge}
      ${imgHtml}
      <div class="card-name">${escapeHtml(s.name)}</div>
      ${oddsLine}
      ${tierMini ? `<div class="card-tiers">${tierMini}</div>` : ''}
      ${trendBar}
      ${pcLink}
      <div class="card-controls">
        <button data-action="edit" title="Edit">✎</button>
        <button data-action="toggle" title="${s.active ? 'Pause' : 'Resume'}">${s.active ? '⏸' : '▶'}</button>
        <button data-action="delete" class="danger" title="Delete">✕</button>
      </div>
      ${popover}
    </div>`;
}

function renderCardPopover(s) {
  const spark = renderMultiSparkline({
    psa10: s.psa10_history || [],
    ace10: s.ace10_history || [],
    cgc_pristine_10: s.cgc_pristine_10_history || [],
  }, { W: 460, H: 200, padL: 52, padR: 60, padT: 18, padB: 34 });
  const table = renderCardTierTable(s);
  const updated = s.pc_updated_at ? fmtAgo(s.pc_updated_at) : 'not fetched';
  return `<div class="card-popover">
    <div class="pop-head">
      <div>
        <div class="pop-heading">PriceCharting</div>
        <div class="pop-product">${escapeHtml(s.pc_product_name || s.name)}</div>
      </div>
      <a class="pop-open" href="${escapeHtml(s.pricecharting_url || '')}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open ↗</a>
    </div>
    ${table}
    <div class="pop-chart">${spark}</div>
    <div class="pop-updated">Updated ${updated} · click card to filter auctions</div>
  </div>`;
}

function renderPcStrip(s) {
  if (!s.pricecharting_url) return '';
  const chips = `<span class="pc-tier psa10"><span class="label">PSA 10</span><span class="value">${escapeHtml(fmtMoney(s.pc_psa10_cents))}</span></span>`;
  const spark = renderSparkline(s.psa10_history, s.pc_psa10_cents);
  const updated = s.pc_updated_at
    ? `updated ${fmtAgo(s.pc_updated_at)}`
    : '<span class="pc-stale">not fetched</span>';
  return `<div class="pc-strip">
    <span class="pc-label">PriceCharting${s.pc_product_name ? ` · ${escapeHtml(s.pc_product_name)}` : ''}:</span>
    ${chips}
    <a class="pc-link" href="${escapeHtml(s.pricecharting_url)}" target="_blank" rel="noopener">${updated} ↗</a>
    <button class="secondary" data-action="refresh-pc" style="padding:2px 8px;font-size:11px">↻</button>
    ${spark}
  </div>`;
}

function safeParseJsonArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

const perSearchTagInputs = new Map(); // search id -> { required, forbidden }
let drawerTagInputs = null; // { required, forbidden } for the currently open drawer

function renderEditStrip(s) {
  if (!editingSearchId.has(s.id)) return '';
  return `<div class="edit-strip">
    <div class="edit-row"><label>Name</label>
      <input data-edit="name" value="${escapeHtml(s.name)}"></div>
    <div class="edit-row"><label>eBay URL</label>
      <input data-edit="url" value="${escapeHtml(s.url)}"></div>
    <div class="edit-row"><label>PriceCharting URL</label>
      <input data-edit="pricecharting_url" value="${escapeHtml(s.pricecharting_url || '')}" placeholder="optional"></div>
    <div class="edit-row"><label>Required (any-of)</label>
      <div class="tag-input" data-edit-tags="required_keywords"></div></div>
    <div class="edit-row"><label>Forbidden</label>
      <div class="tag-input forbidden" data-edit-tags="forbidden_keywords"></div></div>
    <div class="edit-actions">
      <button class="secondary" data-action="cancel">Cancel</button>
      <button class="primary" data-action="save">Save</button>
    </div>
  </div>`;
}

function initEditStripTags(row, s) {
  if (!editingSearchId.has(s.id)) return;
  const reqEl = row.querySelector('[data-edit-tags="required_keywords"]');
  const forEl = row.querySelector('[data-edit-tags="forbidden_keywords"]');
  const reqTags = safeParseJsonArray(s.required_keywords);
  const forTags = safeParseJsonArray(s.forbidden_keywords);
  const req = createTagInput(reqEl, reqTags, 'e.g. Charizard');
  const forb = createTagInput(forEl, forTags, 'e.g. proxy');
  perSearchTagInputs.set(s.id, { required: req, forbidden: forb });
}

function renderSearches() {
  const list = $('#searches-list');
  if (searches.length === 0) {
    list.innerHTML = '<div class="empty">No cards yet. Add one above.</div>';
    return;
  }
  // Split: cards with pack_odds ranked by rarity (highest odds first),
  // cards without pack_odds at the bottom in original order.
  const ranked = searches
    .filter((s) => s.pack_odds && s.pack_odds > 0)
    .sort((a, b) => b.pack_odds - a.pack_odds);
  const unranked = searches.filter((s) => !s.pack_odds || s.pack_odds <= 0);

  let html = '';
  if (ranked.length) {
    html += `<div class="rank-header">🏆 Ranked by rarity</div>`;
    html += ranked.map((s, i) => renderCardTile(s, { rank: i + 1 })).join('');
  }
  if (unranked.length) {
    html += `<div class="rank-header">Unranked · Add pack odds</div>`;
    html += unranked.map((s) => renderCardTile(s)).join('');
  }
  list.innerHTML = html;

  perSearchTagInputs.clear();
  // Wire up card tiles
  list.querySelectorAll('.card-tile').forEach((tile) => {
    const id = parseInt(tile.dataset.id);
    tile.addEventListener('click', (e) => {
      if (e.target.closest('.card-controls')) return;
      if (e.target.closest('.card-popover')) return; // popover has its own links
      if (e.target.closest('a')) return; // let PC ↗ do its thing
      // Multi-select: toggle this card in the filter Set
      if (currentSearchFilters.has(id)) currentSearchFilters.delete(id);
      else currentSearchFilters.add(id);
      syncFilterDropdown();
      renderSearches();
      renderListings();
      const auctions = document.getElementById('listings-section');
      if (auctions && window.innerWidth < 900) auctions.scrollIntoView({ behavior: 'smooth' });
    });
    tile.querySelector('[data-action="edit"]').onclick = (e) => {
      e.stopPropagation();
      openEditDrawer(id);
    };
    tile.querySelector('[data-action="toggle"]').onclick = async (e) => {
      e.stopPropagation();
      const s = searches.find((x) => x.id === id);
      await fetch(`/api/searches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !s.active }),
      });
      loadSearches();
    };
    tile.querySelector('[data-action="delete"]').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this search and all its listings?')) return;
      await fetch(`/api/searches/${id}`, { method: 'DELETE' });
      loadSearches();
      loadListings();
    };
  });

  list.querySelectorAll('.search-row').forEach((row) => {
    const id = parseInt(row.dataset.id);
    const s = searches.find((x) => x.id === id);
    if (s) initEditStripTags(row, s);
    const refreshBtn = row.querySelector('[data-action="refresh-pc"]');
    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '…';
        const res = await fetch(`/api/searches/${id}/refresh-prices`, { method: 'POST' });
        if (res.ok) {
          toast('Prices refreshed');
          loadSearches();
        } else {
          const err = await res.json();
          toast(err.error || 'Refresh failed');
        }
        refreshBtn.disabled = false;
        refreshBtn.textContent = '↻';
      };
    }
    const saveBtn = row.querySelector('[data-action="save"]');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const get = (k) => row.querySelector(`[data-edit="${k}"]`).value.trim();
        const tagInputs = perSearchTagInputs.get(id) || {};
        const body = {
          name: get('name'),
          url: get('url'),
          pricecharting_url: get('pricecharting_url') || null,
          required_keywords: tagInputs.required ? tagInputs.required.get() : [],
          forbidden_keywords: tagInputs.forbidden ? tagInputs.forbidden.get() : [],
        };
        const res = await fetch(`/api/searches/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          editingSearchId.delete(id);
          toast('Saved');
          await loadSearches();
          await loadListings();
        } else {
          const e = await res.json();
          toast(e.error || 'Save failed');
        }
      };
      row.querySelector('[data-action="cancel"]').onclick = () => {
        editingSearchId.delete(id);
        renderSearches();
      };
    }
  });
}

function renderSearchFilter() {
  const sel = $('#filter-search');
  sel.innerHTML = '<option value="">All searches</option>' +
    searches
      .map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
      .join('');
  syncFilterDropdown();
}

async function loadListings() {
  const res = await fetch('/api/listings');
  listings = await res.json();
  renderListings();
}

function renderListings() {
  const only24h = $('#filter-24h').checked;
  const belowMarketOnly = $('#filter-below-market').checked;
  const now = Math.floor(Date.now() / 1000);

  let filtered = listings;
  if (only24h) {
    filtered = filtered.filter((l) => l.ends_at && l.ends_at - now <= 86400);
  }
  if (belowMarketOnly) {
    filtered = filtered.filter(
      (l) =>
        l.price_usd_cents != null &&
        l.search_pc_psa10_cents != null &&
        l.price_usd_cents < l.search_pc_psa10_cents
    );
  }
  if (currentSearchFilters.size > 0) {
    filtered = filtered.filter((l) => currentSearchFilters.has(l.search_id));
  }
  const searchId = currentSearchFilters.size === 1 ? [...currentSearchFilters][0] : null;

  const container = $('#listings-list');

  let priceSummaryHtml = '';
  if (searchId) {
    const s = searches.find((x) => x.id === parseInt(searchId));
    if (s && s.pricecharting_url) {
      const chips = `<span class="pc-tier psa10"><span class="label">PSA 10</span><span class="value">${escapeHtml(fmtMoney(s.pc_psa10_cents))}</span></span>`;
      priceSummaryHtml = `<div class="price-summary">
        <span class="ps-name">${escapeHtml(s.pc_product_name || s.name)}</span>
        ${chips}
      </div>`;
    } else if (s) {
      priceSummaryHtml = `<div class="price-summary"><span class="ps-empty">No PriceCharting URL set for "${escapeHtml(s.name)}" — add one to see market prices.</span></div>`;
    }
  }

  if (filtered.length === 0) {
    container.innerHTML = priceSummaryHtml + '<div class="empty">No auctions matching the current filter. Hit "Run now" to scrape.</div>';
    return;
  }

  container.innerHTML = priceSummaryHtml + filtered
    .map((l) => renderListingRow(l))
    .join('');
}

// Look at a listing title and figure out which grading tier it's referring to.
// Order matters — check the most specific patterns first.
function detectTier(title) {
  if (!title) return 'psa10';
  const t = title.toUpperCase();
  if (/\bCGC\s*(?:GEM\s*MINT\s*)?(?:PRISTINE|PERFECT)\s*10\b/.test(t) ||
      /\bCGC\s*10\s*PRISTINE\b/.test(t) ||
      /\bPRISTINE\s*(?:GEM\s*MINT\s*)?10\b/.test(t))
    return 'cgc_pristine_10';
  if (/\bACE\s*10\b/.test(t) || /\bACE\s*(?:GEM\s*MINT\s*)?10\b/.test(t))
    return 'ace10';
  if (/\bPSA\s*10\b/.test(t)) return 'psa10';
  // Fallbacks — a card labeled just "CGC 10" or "BGS 10" isn't Pristine.
  // Compare it to PSA 10 as best-available reference.
  return 'psa10';
}

function marketCentsForTier(l, tier) {
  if (tier === 'cgc_pristine_10') return l.search_pc_cgc_pristine_10_cents ?? l.search_pc_psa10_cents ?? null;
  if (tier === 'ace10') return l.search_pc_ace10_cents ?? l.search_pc_psa10_cents ?? null;
  return l.search_pc_psa10_cents ?? null;
}

const TIER_LABELS = {
  psa10: 'PSA 10',
  ace10: 'ACE 10',
  cgc_pristine_10: 'CGC Pristine 10',
};

function renderMarketInline(bidCents, l) {
  const tier = detectTier(l.title);
  const marketCents = marketCentsForTier(l, tier);
  if (marketCents == null || marketCents === 0) return '';
  const marketStr = fmtUsd(marketCents);
  const tierLabel = TIER_LABELS[tier] || 'PSA 10';
  if (bidCents == null) {
    return `<div class="market-inline"><span class="market-label">${escapeHtml(tierLabel)} ${escapeHtml(marketStr)}</span></div>`;
  }
  const diff = bidCents - marketCents;
  const pct = Math.round((diff / marketCents) * 100);
  const cls = diff < 0 ? 'below' : (diff > 0 ? 'above' : 'even');
  const sign = diff > 0 ? '+' : (diff < 0 ? '−' : '');
  const abs = fmtUsd(Math.abs(diff));
  return `<div class="market-inline">
    <span class="market-label">${escapeHtml(tierLabel)} ${escapeHtml(marketStr)}</span>
    <span class="market-diff ${cls}">${sign}${escapeHtml(abs)} · ${sign}${Math.abs(pct)}%</span>
  </div>`;
}

const NOTIFY_LEADS = [
  { sec: 3600, label: '1h' },
  { sec: 1800, label: '30m' },
  { sec: 900, label: '15m' },
  { sec: 300, label: '5m' },
];

function renderNotifyBox(l) {
  const byRecipient = l.notify_by_recipient || {};
  const mine = new Set(byRecipient[currentRecipient] || []);
  const otherRecipientLeads = new Map();
  for (const [rec, leads] of Object.entries(byRecipient)) {
    if (rec !== currentRecipient) {
      for (const lead of leads) {
        if (!otherRecipientLeads.has(lead)) otherRecipientLeads.set(lead, []);
        otherRecipientLeads.get(lead).push(rec);
      }
    }
  }
  const recipientLabelMap = Object.fromEntries(recipients.map((r) => [r.key, r.label]));
  const boxes = NOTIFY_LEADS.map((opt) => {
    const others = otherRecipientLeads.get(opt.sec) || [];
    const otherBadge = others.length
      ? `<span class="notify-other-badge" title="${others.map(r=>recipientLabelMap[r]||r).join(', ')} also notified">${others.map(r=>(recipientLabelMap[r]||r).charAt(0)).join('')}</span>`
      : '';
    return `<label class="notify-opt">
      <input type="checkbox" data-notify data-lead="${opt.sec}" ${mine.has(opt.sec) ? 'checked' : ''}>
      <span>${opt.label}</span>${otherBadge}
    </label>`;
  }).join('');
  return `<div class="notify-box">
    <div class="notify-heading">🔔 Notify <span class="notify-me">${escapeHtml(recipientLabelMap[currentRecipient] || currentRecipient)}</span></div>
    ${boxes}
    <button type="button" class="hot-btn ${l.is_hot ? 'active' : ''}" data-hot title="Track this listing intensively">
      ${l.is_hot ? '🔥 Watching' : '🔥 Watch'}
    </button>
  </div>`;
}

function renderListingRow(l) {
  const bidCents = l.price_usd_cents;
  const marketCents = l.search_pc_psa10_cents;
  const inWindow = l.is_hot && l.ends_at && (l.ends_at - Math.floor(Date.now() / 1000)) <= 60;
  return `
    <div class="listing ${l.is_hot ? 'is-hot' : ''} ${inWindow ? 'in-window' : ''}" data-listing-id="${escapeHtml(l.listing_id)}" data-ends-at="${l.ends_at || ''}">
      <a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">
        ${l.image_url ? `<img src="${escapeHtml(l.image_url)}" alt="">` : '<div style="width:80px;height:80px;background:#f0f0f0;border-radius:6px"></div>'}
      </a>
      <div>
        <a class="title" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.title)}</a>
        <div class="meta">
          <span class="search-badge">${escapeHtml(l.search_name)}</span>
          ${escapeHtml(l.condition || '')}${l.location ? ' · ' + escapeHtml(l.location) : ''}
        </div>
      </div>
      ${renderNotifyBox(l)}
      <div class="price-block">
        <div class="price" title="${escapeHtml(l.price_text || '')}" data-role="bid">${escapeHtml(bidCents != null ? fmtUsd(bidCents) : l.price_text || '—')}</div>
        ${renderMarketInline(bidCents, l)}
        <div class="bids" data-role="bids">${l.bid_count ?? 0} bids</div>
        <div class="time-left" data-role="time-left">${fmtRelativeTime(l.ends_at)}</div>
        ${renderEndTimes(l.ends_at)}
        ${l.is_hot ? `<div class="live-status" data-role="live-status"></div>` : ''}
      </div>
    </div>`;
}

// ================== Live view for hot listings in the final window ==================
const liveTimelines = new Map(); // listing_id -> { lastTs, interval }

async function pollLiveTimeline(listingId, row) {
  const state = liveTimelines.get(listingId) || { lastTs: 0 };
  try {
    const res = await fetch(`/api/hot/${encodeURIComponent(listingId)}/timeline?since=${state.lastTs}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.polls && data.polls.length) {
      const latest = data.polls[data.polls.length - 1];
      state.lastTs = latest.ts_ms;
      liveTimelines.set(listingId, state);
      // Update the row's price and bid count with the freshest values
      const priceEl = row.querySelector('[data-role="bid"]');
      const bidsEl = row.querySelector('[data-role="bids"]');
      const timeLeftEl = row.querySelector('[data-role="time-left"]');
      const statusEl = row.querySelector('[data-role="live-status"]');
      if (priceEl && latest.bid_usd_cents != null) {
        const oldText = priceEl.textContent;
        priceEl.textContent = fmtUsd(latest.bid_usd_cents);
        if (oldText !== priceEl.textContent) {
          priceEl.classList.remove('flash');
          void priceEl.offsetWidth;
          priceEl.classList.add('flash');
        }
      }
      if (bidsEl && latest.bid_count != null) bidsEl.textContent = `${latest.bid_count} bids`;
      if (timeLeftEl && row.dataset.endsAt) {
        const endsAt = parseInt(row.dataset.endsAt);
        const remaining = endsAt - Math.floor(Date.now() / 1000);
        timeLeftEl.textContent = remaining > 0 ? fmtRelativeTime(endsAt) : 'ended';
      }
      if (statusEl) {
        const cadence = data.is_polling ? 'live' : 'idle';
        statusEl.textContent = `● ${cadence} · ${data.polls.length} pings`;
        statusEl.className = `live-status ${cadence}`;
      }
    } else if (data.is_polling) {
      const statusEl = row.querySelector('[data-role="live-status"]');
      if (statusEl) {
        statusEl.textContent = '● connecting…';
        statusEl.className = 'live-status live';
      }
    }
  } catch {}
}

function scanForWindowedListings() {
  const now = Math.floor(Date.now() / 1000);
  const rows = document.querySelectorAll('.listing.is-hot');
  const activeIds = new Set();
  rows.forEach((row) => {
    const endsAt = parseInt(row.dataset.endsAt);
    if (!endsAt) return;
    const remaining = endsAt - now;
    if (remaining <= 60 && remaining > -10) {
      row.classList.add('in-window');
      activeIds.add(row.dataset.listingId);
    } else {
      row.classList.remove('in-window');
    }
    // Live countdown for all hot rows so seconds tick down without a full re-render
    const timeLeftEl = row.querySelector('[data-role="time-left"]');
    if (timeLeftEl && remaining > -10) {
      if (remaining > 0) {
        const h = Math.floor(remaining / 3600);
        const m = Math.floor((remaining % 3600) / 60);
        const s = remaining % 60;
        timeLeftEl.textContent = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
      } else {
        timeLeftEl.textContent = 'ended';
      }
    }
  });

  // Start pollers for listings that entered the window
  for (const id of activeIds) {
    if (liveTimelines.has(id)) continue;
    const row = document.querySelector(`.listing[data-listing-id="${CSS.escape(id)}"]`);
    if (!row) continue;
    const state = { lastTs: 0, interval: null };
    state.interval = setInterval(() => pollLiveTimeline(id, row), 500);
    liveTimelines.set(id, state);
    pollLiveTimeline(id, row); // immediate first fetch
  }

  // Stop pollers for listings that left the window (ended)
  for (const [id, state] of liveTimelines) {
    if (!activeIds.has(id)) {
      clearInterval(state.interval);
      liveTimelines.delete(id);
    }
  }
}

// Scan every second — the "hot window" starts at 60s remaining
setInterval(scanForWindowedListings, 1000);

async function loadLastRun() {
  const res = await fetch('/api/last-run');
  const run = await res.json();
  if (!run) {
    $('#last-run').textContent = 'never run';
    return;
  }
  const ago = fmtAgo(run.finished_at || run.started_at);
  $('#last-run').textContent = `last run ${ago} · ${run.listings_found} listings`;
}

async function loadEbayUsage() {
  const el = $('#ebay-usage');
  if (!el) return;
  try {
    const res = await fetch('/api/ebay-usage');
    const u = await res.json();
    if (!u.enabled) {
      el.innerHTML = `<span class="dot"></span>scraper mode`;
      el.className = 'ebay-usage disabled';
      el.title = 'Not using eBay API — data source is HTML scraping';
      return;
    }
    const pct = u.limit > 0 ? Math.round((u.total / u.limit) * 100) : 0;
    const cls = pct >= 90 ? 'crit' : pct >= 60 ? 'warn' : '';
    const hours = Math.floor(u.seconds_to_reset / 3600);
    const mins = Math.floor((u.seconds_to_reset % 3600) / 60);
    el.className = 'ebay-usage ' + cls;
    el.innerHTML = `<span class="dot"></span>eBay ${u.total}/${u.limit}`;
    el.title = `${u.total} / ${u.limit} calls today\n` +
      `  · search: ${u.by_kind.search}\n` +
      `  · item: ${u.by_kind.item}\n` +
      `  · errors: ${u.by_kind.errors}\n` +
      `resets in ${hours}h ${mins}m (UTC midnight)`;
  } catch {}
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

$('#add-search-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#search-name').value.trim();
  const url = $('#search-url').value.trim();
  const pricecharting_url = $('#search-pc-url').value.trim() || null;
  const res = await fetch('/api/searches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url, pricecharting_url }),
  });
  if (res.ok) {
    $('#search-name').value = '';
    $('#search-url').value = '';
    $('#search-pc-url').value = '';
    toast(pricecharting_url ? 'Search added — fetching PriceCharting…' : 'Search added');
    setTimeout(loadSearches, pricecharting_url ? 1500 : 0);
  } else {
    const err = await res.json();
    toast(err.error || 'Failed');
  }
};

$('#run-now').onclick = async () => {
  const btn = $('#run-now');
  btn.disabled = true;
  btn.textContent = 'Running…';
  try {
    const res = await fetch('/api/run-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sendEmail: false }),
    });
    const data = await res.json();
    if (res.ok) {
      toast(`Scraped ${data.totalFound} listings (${data.totalNew} new)`);
      await loadListings();
      await loadLastRun();
    } else {
      toast(data.error || 'Run failed');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run now';
  }
};

$('#send-email').onclick = async () => {
  const btn = $('#send-email');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/send-email-now', { method: 'POST' });
    const data = await res.json();
    toast(res.ok ? 'Email sent' : data.error || 'Failed');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Email digest';
  }
};

$('#filter-24h').onchange = renderListings;
$('#filter-below-market').onchange = renderListings;
$('#filter-search').onchange = () => {
  const v = $('#filter-search').value;
  currentSearchFilters.clear();
  if (v === '__multi__') {
    // no-op — placeholder for existing multi-select from cards
  } else if (v) {
    currentSearchFilters.add(parseInt(v));
  }
  syncFilterDropdown();
  renderSearches();
  renderListings();
};

function syncFilterDropdown() {
  const sel = $('#filter-search');
  if (!sel) return;
  // Refresh options so the "Multiple" label reflects the current count
  const currentBase = [...sel.options]
    .filter((o) => o.value !== '__multi__')
    .map((o) => o.outerHTML)
    .join('');
  const count = currentSearchFilters.size;
  const multi = count >= 2
    ? `<option value="__multi__" selected>${count} cards selected</option>`
    : '';
  sel.innerHTML = multi + currentBase;
  if (count === 1) sel.value = String([...currentSearchFilters][0]);
  else if (count === 0) sel.value = '';
  else sel.value = '__multi__';
  // Show/hide clear button
  const clearBtn = $('#filter-clear');
  if (clearBtn) clearBtn.style.display = count > 0 ? 'inline-flex' : 'none';
}

// Delegate notify checkbox toggles for the whole listings list
$('#listings-list').addEventListener('change', async (e) => {
  const cb = e.target.closest('input[data-notify]');
  if (!cb) return;
  const row = cb.closest('.listing');
  const listingId = row?.dataset?.listingId;
  const lead = cb.dataset?.lead;
  if (!listingId || !lead) return;
  const method = cb.checked ? 'POST' : 'DELETE';
  cb.disabled = true;
  try {
    const res = await fetch(
      `/api/notify/${encodeURIComponent(listingId)}/${lead}?recipient=${encodeURIComponent(currentRecipient)}`,
      { method }
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast(j.error || 'Notify failed');
      cb.checked = !cb.checked;
    } else {
      const label = NOTIFY_LEADS.find((x) => x.sec === parseInt(lead))?.label;
      const me = recipients.find((r) => r.key === currentRecipient)?.label || currentRecipient;
      toast(cb.checked ? `Will notify ${me} ${label} before end` : `${label} notify off for ${me}`);
      await loadListings();
    }
  } catch (err) {
    toast('Network error');
    cb.checked = !cb.checked;
  } finally {
    cb.disabled = false;
  }
});

// 🔥 Watch button toggles hot listing state
$('#listings-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-hot]');
  if (!btn) return;
  const row = btn.closest('.listing');
  const listingId = row?.dataset?.listingId;
  if (!listingId) return;
  const currentlyHot = btn.classList.contains('active');
  const method = currentlyHot ? 'DELETE' : 'POST';
  btn.disabled = true;
  try {
    const res = await fetch(`/api/hot/${encodeURIComponent(listingId)}`, { method });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast(j.error || 'Watch toggle failed');
    } else {
      btn.classList.toggle('active');
      btn.textContent = currentlyHot ? '🔥 Watch' : '🔥 Watching';
      row.classList.toggle('is-hot');
      toast(currentlyHot ? 'Stopped watching' : 'Now watching intensively');
    }
  } catch (err) {
    toast('Network error');
  } finally {
    btn.disabled = false;
  }
});

let globalRequiredTags;
let globalForbiddenTags;

async function loadRecipients() {
  try {
    const res = await fetch('/api/recipients');
    recipients = await res.json();
  } catch {
    recipients = [{ key: 'daniel', label: 'Daniel' }];
  }
  if (!recipients.find((r) => r.key === currentRecipient) && recipients.length) {
    currentRecipient = recipients[0].key;
    localStorage.setItem('pokemon-recipient', currentRecipient);
  }
  renderRecipientPicker();
}

function renderRecipientPicker() {
  const el = $('#recipient-picker');
  if (!el) return;
  if (recipients.length <= 1) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<span class="rp-label">I'm:</span>` +
    recipients.map((r) => `
      <button type="button" class="rp-btn ${r.key === currentRecipient ? 'active' : ''}" data-recipient="${escapeHtml(r.key)}">${escapeHtml(r.label)}</button>
    `).join('');
  el.querySelectorAll('[data-recipient]').forEach((btn) => {
    btn.onclick = () => {
      currentRecipient = btn.dataset.recipient;
      localStorage.setItem('pokemon-recipient', currentRecipient);
      renderRecipientPicker();
      renderListings();
    };
  });
}

async function loadSettings() {
  const res = await fetch('/api/settings');
  settings = await res.json();
  if (!globalRequiredTags) {
    globalRequiredTags = createTagInput(
      $('#global-required'),
      settings.global_required_keywords || [],
      'e.g. PSA'
    );
    globalForbiddenTags = createTagInput(
      $('#global-forbidden'),
      settings.global_forbidden_keywords || [],
      'e.g. 9'
    );
  } else {
    globalRequiredTags.set(settings.global_required_keywords || []);
    globalForbiddenTags.set(settings.global_forbidden_keywords || []);
  }
}

$('#toggle-settings').onclick = () => {
  const p = $('#settings-panel');
  p.hidden = !p.hidden;
};

$('#save-settings').onclick = async () => {
  const body = {
    global_required_keywords: globalRequiredTags.get(),
    global_forbidden_keywords: globalForbiddenTags.get(),
  };
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    settings = await res.json();
    toast('Filters saved');
    await loadListings();
  } else {
    toast('Save failed');
  }
};

const clearBtn = document.getElementById('filter-clear');
if (clearBtn) {
  clearBtn.onclick = () => {
    currentSearchFilters.clear();
    syncFilterDropdown();
    renderSearches();
    renderListings();
  };
}

// ================== Edit drawer ==================
function openEditDrawer(id) {
  const s = searches.find((x) => x.id === id);
  if (!s) return;
  const reqTags = safeParseJsonArray(s.required_keywords);
  const forTags = safeParseJsonArray(s.forbidden_keywords);
  const body = document.getElementById('drawer-body');
  const title = document.getElementById('drawer-title');
  title.textContent = 'Edit · ' + s.name;
  body.innerHTML = `
    <div class="edit-row">
      <label>Card name</label>
      <input data-edit="name" value="${escapeHtml(s.name)}">
    </div>
    <div class="edit-row">
      <label>eBay search URL</label>
      <input data-edit="url" value="${escapeHtml(s.url)}">
    </div>
    <div class="edit-row">
      <label>PriceCharting URL <span class="hint">optional</span></label>
      <input data-edit="pricecharting_url" value="${escapeHtml(s.pricecharting_url || '')}" placeholder="https://www.pricecharting.com/game/...">
    </div>
    <div class="edit-row">
      <label>Pack odds <span class="hint">1 in N packs (manual research)</span></label>
      <div class="edit-row-inline">
        <span class="prefix">1 in</span>
        <input type="number" min="1" step="1" data-edit="pack_odds" value="${s.pack_odds ?? ''}" placeholder="e.g. 250">
        <span class="prefix">packs</span>
      </div>
    </div>
    <div class="edit-row">
      <label>Required keywords <span class="hint">any-of · title must contain at least one</span></label>
      <div class="tag-input" data-drawer-tags="required"></div>
    </div>
    <div class="edit-row">
      <label>Forbidden keywords <span class="hint">title must contain none</span></label>
      <div class="tag-input forbidden" data-drawer-tags="forbidden"></div>
    </div>
  `;
  const reqEl = body.querySelector('[data-drawer-tags="required"]');
  const forEl = body.querySelector('[data-drawer-tags="forbidden"]');
  drawerTagInputs = {
    required: createTagInput(reqEl, reqTags, 'e.g. Charizard'),
    forbidden: createTagInput(forEl, forTags, 'e.g. proxy'),
    id,
  };
  document.getElementById('edit-drawer').hidden = false;
}
function closeEditDrawer() {
  document.getElementById('edit-drawer').hidden = true;
  drawerTagInputs = null;
}
document.querySelectorAll('[data-drawer-close]').forEach((el) => {
  el.onclick = closeEditDrawer;
});
document.getElementById('drawer-save').onclick = async () => {
  const body = document.getElementById('drawer-body');
  const id = drawerTagInputs.id;
  const get = (k) => body.querySelector(`[data-edit="${k}"]`).value.trim();
  const packOddsRaw = get('pack_odds');
  const payload = {
    name: get('name'),
    url: get('url'),
    pricecharting_url: get('pricecharting_url') || null,
    pack_odds: packOddsRaw === '' ? null : parseInt(packOddsRaw),
    required_keywords: drawerTagInputs.required.get(),
    forbidden_keywords: drawerTagInputs.forbidden.get(),
  };
  const btn = document.getElementById('drawer-save');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Saving…';
  try {
    const res = await fetch(`/api/searches/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      toast('Saved');
      closeEditDrawer();
      await loadSearches();
      await loadListings();
    } else {
      const e = await res.json();
      toast(e.error || 'Save failed');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
};

loadRecipients();
loadSettings();
loadSearches();
loadListings();
loadLastRun();
loadEbayUsage();
setInterval(loadLastRun, 30000);
setInterval(loadEbayUsage, 30000);
