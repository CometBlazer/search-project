/* Dashboard Search - client-side search over data.json */

const el = (id) => document.getElementById(id);
const form = el('searchForm');
const input = el('q');
const clearBtn = el('clearBtn');
const suggestBox = el('suggestions');
const resultsArea = el('resultsArea');
const resultsList = el('results');
const statsEl = el('stats');
const emptyEl = el('empty');
const emptyMsg = el('emptyMsg');
const divisionFilters = el('divisionFilters');
const statusFilters = el('statusFilters');

const STATUS_LABEL = { live: 'Live', coming_soon: 'Coming soon' };

let ITEMS = [];              // flattened dashboards
let activeDivisions = new Set();
let activeStatuses = new Set();
let lastMatches = [];        // matches for the current query, before filters
let suggestIndex = -1;
let isPartial = false;      // true when results only match some of the terms

/* ---------- data ---------- */

function flatten(json) {
  const out = [];
  const groups = (json && json.dashboards) || {};
  for (const [division, categories] of Object.entries(groups)) {
    for (const [category, list] of Object.entries(categories || {})) {
      for (const item of list || []) {
        out.push({
          id: item.id || '',
          name: item.name || '',
          description: item.description || '',
          hyperlink: item.hyperlink || '',
          status: item.status || 'live',
          division,
          category,
          haystack: [item.name, item.id, division, category, item.description]
            .join(' ').toLowerCase()
        });
      }
    }
  }
  return out;
}

async function load() {
  try {
    const res = await fetch('data.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    ITEMS = flatten(await res.json());
  } catch (err) {
    showLoadError(err);
    return;
  }
  const divisions = new Set(ITEMS.map((i) => i.division)).size;
  el('heroSub').textContent =
    'Search ' + ITEMS.length + ' dashboards across ' + divisions + ' divisions';
  input.disabled = false;
  input.focus();
  buildChips();
  const initial = new URLSearchParams(location.search).get('q');
  if (initial) {
    input.value = initial;
    runSearch(initial);
  }
}

function showLoadError(err) {
  document.body.className = 'state-results';
  resultsArea.hidden = false;
  resultsList.innerHTML = '';
  emptyEl.hidden = false;
  emptyEl.querySelector('h2').textContent = 'Could not load data.json';
  emptyMsg.innerHTML =
    'Browsers block <code>fetch()</code> on <code>file://</code> pages. ' +
    'Serve this folder over HTTP, e.g. run <code>python -m http.server 8000</code> ' +
    'in this directory and open <code>http://localhost:8000</code>.' +
    '<br><br><small>' + String(err && err.message ? err.message : err) + '</small>';
}

/* ---------- search ---------- */

const tokenize = (s) => s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);

// Score one item against the query tokens. Every token must appear somewhere.
function scoreItem(item, tokens, rawQuery, requireAll = true) {
  let score = 0;
  let matched = 0;
  const name = item.name.toLowerCase();
  const id = item.id.toLowerCase();
  const category = item.category.toLowerCase();
  const division = item.division.toLowerCase();
  const description = item.description.toLowerCase();

  for (const t of tokens) {
    if (!item.haystack.includes(t)) {
      if (requireAll) return 0;
      continue;
    }
    matched++;
    let best = 0;
    if (name === t) best = 100;
    else if (name.startsWith(t)) best = 60;
    else if (wordStart(name, t)) best = 45;
    else if (name.includes(t)) best = 30;
    if (id.includes(t)) best = Math.max(best, id === t ? 100 : 40);
    if (wordStart(category, t)) best = Math.max(best, 26);
    else if (category.includes(t)) best = Math.max(best, 18);
    if (wordStart(division, t)) best = Math.max(best, 22);
    else if (division.includes(t)) best = Math.max(best, 14);
    if (wordStart(description, t)) best = Math.max(best, 9);
    else if (description.includes(t)) best = Math.max(best, 5);
    score += best;
  }

  if (!matched) return 0;

  // bonus for matching the whole query as a phrase, and for live dashboards
  const phrase = rawQuery.trim().toLowerCase();
  if (phrase.length > 2) {
    if (name.includes(phrase)) score += 45;
    else if (item.haystack.includes(phrase)) score += 12;
  }
  if (item.status === 'live') score += 2;
  return score;
}

function wordStart(text, token) {
  const i = text.indexOf(token);
  if (i < 0) return false;
  return i === 0 || /[^a-z0-9]/i.test(text[i - 1]);
}

function search(query, requireAll = true) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const hits = [];
  for (const item of ITEMS) {
    const score = scoreItem(item, tokens, query, requireAll);
    if (score > 0) hits.push({ item, score });
  }
  hits.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return hits;
}

/* ---------- highlighting ---------- */

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function highlight(text, tokens) {
  const safe = escapeHtml(text);
  if (!tokens.length) return safe;
  const re = new RegExp('(' + tokens.map(escapeRe).join('|') + ')', 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

/* ---------- rendering ---------- */

function runSearch(query, pushUrl = true) {
  const q = query.trim();
  if (!q) return goHome();

  lastMatches = search(q);
  isPartial = false;
  if (!lastMatches.length && tokenize(q).length > 1) {
    // nothing matched every term - fall back to anything matching at least one
    lastMatches = search(q, false);
    isPartial = lastMatches.length > 0;
  }

  document.body.className = 'state-results';
  clearBtn.hidden = false;
  moveSearchBox(true);
  resultsArea.hidden = false;
  hideSuggestions();

  // drop filters that no longer apply to this result set
  const divs = new Set(lastMatches.map((m) => m.item.division));
  const stats = new Set(lastMatches.map((m) => m.item.status));
  activeDivisions = new Set([...activeDivisions].filter((d) => divs.has(d)));
  activeStatuses = new Set([...activeStatuses].filter((s) => stats.has(s)));

  renderFilters();
  renderResults(q);

  if (pushUrl) {
    const url = q ? '?q=' + encodeURIComponent(q) : location.pathname;
    history.replaceState(null, '', url);
  }
}

function visibleMatches() {
  return lastMatches.filter(
    ({ item }) =>
      (!activeDivisions.size || activeDivisions.has(item.division)) &&
      (!activeStatuses.size || activeStatuses.has(item.status))
  );
}

function renderResults(query) {
  const tokens = tokenize(query);
  const shown = visibleMatches();

  statsEl.innerHTML = shown.length
    ? `<b>${shown.length}</b> result${shown.length === 1 ? '' : 's'} for <b>${escapeHtml(query)}</b>` +
      (isPartial ? ' &middot; no dashboard matches every term, showing partial matches' : '')
    : '';

  resultsList.innerHTML = shown
    .map(({ item }) => card(item, tokens))
    .join('');

  const noResults = shown.length === 0;
  emptyEl.hidden = !noResults;
  if (noResults) {
    emptyEl.querySelector('h2').textContent = 'No dashboards found';
    emptyMsg.textContent = lastMatches.length
      ? 'Your filters hid all ' + lastMatches.length + ' matches. Try clearing a filter.'
      : 'Nothing matched "' + query + '". Check the spelling or try a broader term.';
  }
}

function card(item, tokens) {
  const href = safeUrl(item.hyperlink);
  const host = safeHost(href);
  const title = highlight(item.name, tokens);
  return `
  <li class="row">
    <div class="crumbs"><span class="div">${highlight(item.division, tokens)}</span><span class="sep">/</span>${highlight(item.category, tokens)}</div>
    <h3>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title}</h3>
    <p>${highlight(item.description, tokens)}</p>
    <div class="row-meta">
      <span class="status ${escapeHtml(item.status)}">${escapeHtml(STATUS_LABEL[item.status] || item.status)}</span>
      <span class="row-id">${highlight(item.id, tokens)}</span>
      ${host ? `<span class="row-host">${escapeHtml(host)}</span>` : ''}
    </div>
  </li>`;
}

function safeUrl(url) {
  try {
    const u = new URL(url, location.href);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
  } catch { return ''; }
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

/* ---------- filters ---------- */

function renderFilters() {
  const byDivision = new Map();
  const byStatus = new Map();
  for (const { item } of lastMatches) {
    byDivision.set(item.division, (byDivision.get(item.division) || 0) + 1);
    byStatus.set(item.status, (byStatus.get(item.status) || 0) + 1);
  }

  divisionFilters.innerHTML = [...byDivision.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => pill('division', name, name, n, activeDivisions.has(name)))
    .join('');

  statusFilters.innerHTML = [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => pill('status', s, STATUS_LABEL[s] || s, n, activeStatuses.has(s)))
    .join('');
}

function pill(kind, value, label, count, on) {
  return `<button type="button" class="pill" data-kind="${kind}" data-value="${escapeHtml(value)}"
    aria-pressed="${on}">${escapeHtml(label)}<span class="pill-n">${count}</span></button>`;
}

el('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.pill');
  if (!btn) return;
  const set = btn.dataset.kind === 'division' ? activeDivisions : activeStatuses;
  const value = btn.dataset.value;
  set.has(value) ? set.delete(value) : set.add(value);
  renderFilters();
  renderResults(input.value.trim());
});

/* ---------- suggestions ---------- */

function buildSuggestions(query) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const seen = new Set();
  const out = [];

  // matching categories and divisions first, then the top dashboards
  for (const { item } of lastPreview(query)) {
    for (const [text, meta] of [[item.category, 'category'], [item.division, 'division']]) {
      const key = meta + ':' + text;
      if (!seen.has(key) && tokens.every((t) => text.toLowerCase().includes(t))) {
        seen.add(key);
        out.push({ text, meta });
      }
    }
  }
  for (const { item } of lastPreview(query)) {
    if (out.length >= 8) break;
    if (seen.has('name:' + item.name)) continue;
    seen.add('name:' + item.name);
    out.push({ text: item.name, meta: item.division });
  }
  return out.slice(0, 8);
}

let previewCache = { q: null, hits: [] };
function lastPreview(query) {
  if (previewCache.q !== query) previewCache = { q: query, hits: search(query).slice(0, 12) };
  return previewCache.hits;
}

function showSuggestions(query) {
  const items = buildSuggestions(query);
  suggestIndex = -1;
  if (!items.length) return hideSuggestions();
  suggestBox.innerHTML = items
    .map(
      (s, i) => `<li role="option" id="sg-${i}" data-value="${escapeHtml(s.text)}">
        <svg class="sg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.4 15.4 21 21"/></svg>
        <span class="sg-text">${highlight(s.text, tokenize(query))}</span>
        <span class="sg-meta">${escapeHtml(s.meta)}</span>
      </li>`
    )
    .join('');
  suggestBox.hidden = false;
}

function hideSuggestions() {
  suggestBox.hidden = true;
  suggestBox.innerHTML = '';
  suggestIndex = -1;
}

function moveSuggestion(step) {
  const options = [...suggestBox.children];
  if (!options.length) return;
  options.forEach((o) => o.setAttribute('aria-selected', 'false'));
  const cycle = options.length + 1; // options plus the "nothing selected" slot
  suggestIndex = (((suggestIndex + 1 + step) % cycle) + cycle) % cycle - 1;
  if (suggestIndex >= 0) {
    const opt = options[suggestIndex];
    opt.setAttribute('aria-selected', 'true');
    opt.scrollIntoView({ block: 'nearest' });
  }
}

suggestBox.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  input.value = li.dataset.value;
  runSearch(input.value);
});

/* ---------- state / events ---------- */

function moveSearchBox(toTopbar) {
  const slot = toTopbar ? el('topbarSearchSlot') : el('searchboxHost');
  if (form.parentElement !== slot) slot.insertBefore(form, slot.firstChild);
}

function goHome() {
  document.body.className = 'state-home';
  moveSearchBox(false);
  resultsArea.hidden = true;
  resultsList.innerHTML = '';
  emptyEl.hidden = true;
  lastMatches = [];
  activeDivisions.clear();
  activeStatuses.clear();
  hideSuggestions();
  history.replaceState(null, '', location.pathname);
  input.focus();
}

function buildChips() {
  const picks = ['claims', 'ESG', 'portfolio', 'broker', 'profitability', 'forecasting'];
  el('heroChips').innerHTML = picks
    .map((p) => `<button type="button" class="chip">${escapeHtml(p)}</button>`)
    .join('');
}

el('heroChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  input.value = chip.textContent;
  runSearch(input.value);
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (suggestIndex >= 0 && suggestBox.children[suggestIndex]) {
    input.value = suggestBox.children[suggestIndex].dataset.value;
  }
  runSearch(input.value);
  input.blur();
});

let debounce;
input.addEventListener('input', () => {
  const q = input.value;
  clearBtn.hidden = !q;
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    if (!q.trim()) {
      hideSuggestions();
      if (document.body.classList.contains('state-results')) goHome();
      return;
    }
    // live results, plus the suggestion dropdown while the field has focus
    runSearch(q, true);
    if (document.activeElement === input) showSuggestions(q);
  }, 120);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (suggestBox.hidden) return;
    e.preventDefault();
    moveSuggestion(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Escape') {
    if (!suggestBox.hidden) hideSuggestions();
    else if (input.value) { input.value = ''; clearBtn.hidden = true; goHome(); }
  }
});

input.addEventListener('focus', () => {
  if (input.value.trim()) showSuggestions(input.value);
});

document.addEventListener('click', (e) => {
  if (!form.contains(e.target)) hideSuggestions();
});

clearBtn.addEventListener('click', () => {
  input.value = '';
  clearBtn.hidden = true;
  goHome();
});

el('brandHome').addEventListener('click', (e) => {
  e.preventDefault();
  input.value = '';
  clearBtn.hidden = true;
  goHome();
});

// "/" anywhere focuses the search field, like most search UIs
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input) {
    e.preventDefault();
    input.focus();
    input.select();
  }
});

load();
