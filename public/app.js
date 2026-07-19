const $ = (s) => document.querySelector(s);

let searches = [];
let listings = [];
let settings = { global_required_keywords: [], global_forbidden_keywords: [] };
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

function renderSparkline(history, currentCents) {
  if (!Array.isArray(history) || history.length < 2) return '';
  const W = 320, H = 90;
  const PAD_L = 44, PAD_R = 52, PAD_T = 12, PAD_B = 22;
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
    list.innerHTML = '<div class="empty">No searches yet. Build one on eBay (with auction filter), copy the URL, and paste above.</div>';
    return;
  }
  list.innerHTML = searches
    .map(
      (s) => `
    <div class="search-row ${s.active ? '' : 'inactive'}" data-id="${s.id}">
      <span class="name">${escapeHtml(s.name)}</span>
      <span class="url-truncate" title="${escapeHtml(s.url)}">${escapeHtml(s.url)}</span>
      <button class="secondary" data-action="edit">${editingSearchId.has(s.id) ? 'Close' : 'Edit'}</button>
      <button class="secondary" data-action="toggle">${s.active ? 'Pause' : 'Resume'}</button>
      <button class="danger" data-action="delete">Delete</button>
      ${renderPcStrip(s)}
      ${renderEditStrip(s)}
    </div>`
    )
    .join('');

  perSearchTagInputs.clear();
  list.querySelectorAll('.search-row').forEach((row) => {
    const id = parseInt(row.dataset.id);
    const s = searches.find((x) => x.id === id);
    if (s) initEditStripTags(row, s);
    row.querySelector('[data-action="toggle"]').onclick = async () => {
      const s = searches.find((x) => x.id === id);
      await fetch(`/api/searches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !s.active }),
      });
      loadSearches();
    };
    row.querySelector('[data-action="delete"]').onclick = async () => {
      if (!confirm('Delete this search and all its listings?')) return;
      await fetch(`/api/searches/${id}`, { method: 'DELETE' });
      loadSearches();
      loadListings();
    };
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
          const e = await res.json();
          toast(e.error || 'Refresh failed');
        }
        refreshBtn.disabled = false;
        refreshBtn.textContent = '↻';
      };
    }
    row.querySelector('[data-action="edit"]').onclick = () => {
      if (editingSearchId.has(id)) editingSearchId.delete(id);
      else editingSearchId.add(id);
      renderSearches();
    };
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
  const current = sel.value;
  sel.innerHTML = '<option value="">All searches</option>' +
    searches
      .map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
      .join('');
  sel.value = current;
}

async function loadListings() {
  const res = await fetch('/api/listings');
  listings = await res.json();
  renderListings();
}

function renderListings() {
  const only24h = $('#filter-24h').checked;
  const belowMarketOnly = $('#filter-below-market').checked;
  const searchId = $('#filter-search').value;
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
  if (searchId) {
    filtered = filtered.filter((l) => l.search_id === parseInt(searchId));
  }

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

function renderMarketInline(bidCents, marketCents) {
  if (marketCents == null || marketCents === 0) return '';
  const marketStr = fmtUsd(marketCents);
  if (bidCents == null) {
    return `<div class="market-inline"><span class="market-label">Market ${escapeHtml(marketStr)}</span></div>`;
  }
  const diff = bidCents - marketCents;
  const pct = Math.round((diff / marketCents) * 100);
  const cls = diff < 0 ? 'below' : (diff > 0 ? 'above' : 'even');
  const sign = diff > 0 ? '+' : (diff < 0 ? '−' : '');
  const abs = fmtUsd(Math.abs(diff));
  return `<div class="market-inline">
    <span class="market-label">Market ${escapeHtml(marketStr)}</span>
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
  const active = new Set(l.notify_leads || []);
  const boxes = NOTIFY_LEADS.map((opt) => `
    <label class="notify-opt">
      <input type="checkbox" data-notify data-lead="${opt.sec}" ${active.has(opt.sec) ? 'checked' : ''}>
      <span>${opt.label}</span>
    </label>`).join('');
  return `<div class="notify-box">
    <div class="notify-heading">🔔 Notify</div>
    ${boxes}
  </div>`;
}

function renderListingRow(l) {
  const bidCents = l.price_usd_cents;
  const marketCents = l.search_pc_psa10_cents;
  return `
    <div class="listing" data-listing-id="${escapeHtml(l.listing_id)}">
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
        <div class="price" title="${escapeHtml(l.price_text || '')}">${escapeHtml(bidCents != null ? fmtUsd(bidCents) : l.price_text || '—')}</div>
        ${renderMarketInline(bidCents, marketCents)}
        <div class="bids">${l.bid_count ?? 0} bids</div>
        <div class="time-left">${fmtRelativeTime(l.ends_at)}</div>
        ${renderEndTimes(l.ends_at)}
      </div>
    </div>`;
}

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
$('#filter-search').onchange = renderListings;

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
    const res = await fetch(`/api/notify/${encodeURIComponent(listingId)}/${lead}`, { method });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast(j.error || 'Notify failed');
      cb.checked = !cb.checked;
    } else {
      const label = NOTIFY_LEADS.find((x) => x.sec === parseInt(lead))?.label;
      toast(cb.checked ? `Will notify ${label} before end` : `${label} notify off`);
    }
  } catch (err) {
    toast('Network error');
    cb.checked = !cb.checked;
  } finally {
    cb.disabled = false;
  }
});

let globalRequiredTags;
let globalForbiddenTags;

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

loadSettings();
loadSearches();
loadListings();
loadLastRun();
setInterval(loadLastRun, 30000);
