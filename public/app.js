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

function renderPcStrip(s) {
  if (!s.pricecharting_url) return '';
  const tiers = [
    { key: 'pc_loose_cents', label: 'Raw', cls: '' },
    { key: 'pc_grade9_cents', label: 'PSA 9', cls: '' },
    { key: 'pc_psa10_cents', label: 'PSA 10', cls: 'psa10' },
  ];
  const chips = tiers
    .map(
      (t) =>
        `<span class="pc-tier ${t.cls}"><span class="label">${t.label}</span><span class="value">${escapeHtml(fmtMoney(s[t.key]))}</span></span>`
    )
    .join('');
  const updated = s.pc_updated_at
    ? `updated ${fmtAgo(s.pc_updated_at)}`
    : '<span class="pc-stale">not fetched</span>';
  return `<div class="pc-strip">
    <span class="pc-label">PriceCharting${s.pc_product_name ? ` · ${escapeHtml(s.pc_product_name)}` : ''}:</span>
    ${chips}
    <a class="pc-link" href="${escapeHtml(s.pricecharting_url)}" target="_blank" rel="noopener">${updated} ↗</a>
    <button class="secondary" data-action="refresh-pc" style="padding:2px 8px;font-size:11px">↻</button>
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
  const searchId = $('#filter-search').value;
  const now = Math.floor(Date.now() / 1000);

  let filtered = listings;
  if (only24h) {
    filtered = filtered.filter((l) => l.ends_at && l.ends_at - now <= 86400);
  }
  if (searchId) {
    filtered = filtered.filter((l) => l.search_id === parseInt(searchId));
  }

  const container = $('#listings-list');

  let priceSummaryHtml = '';
  if (searchId) {
    const s = searches.find((x) => x.id === parseInt(searchId));
    if (s && s.pricecharting_url) {
      const tiers = [
        ['Raw', s.pc_loose_cents, ''],
        ['PSA 9', s.pc_grade9_cents, ''],
        ['PSA 10', s.pc_psa10_cents, 'psa10'],
      ];
      const chips = tiers
        .map(
          ([label, cents, cls]) =>
            `<span class="pc-tier ${cls}"><span class="label">${label}</span><span class="value">${escapeHtml(fmtMoney(cents))}</span></span>`
        )
        .join(' ');
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
    .map(
      (l) => `
    <div class="listing">
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
      <div class="price-block">
        <div class="price" title="${escapeHtml(l.price_text || '')}">${escapeHtml(l.price_usd_cents != null ? fmtUsd(l.price_usd_cents) : l.price_text || '—')}</div>
        <div class="bids">${l.bid_count ?? 0} bids</div>
        <div class="time-left">${fmtRelativeTime(l.ends_at)}</div>
      </div>
    </div>`
    )
    .join('');
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
$('#filter-search').onchange = renderListings;

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
