// @ts-check
/* Dashboard Search - client-side search over data.json */

/**
 * One dashboard, flattened out of the division/category nesting in data.json.
 * @typedef {Object} Dashboard
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} hyperlink
 * @property {'live'|'coming_soon'} status
 * @property {string} division
 * @property {string} category
 * @property {string} haystack   all of the above lowercased, for cheap matching
 */

/**
 * A dashboard together with its relevance score for the current query.
 * @typedef {{ item: Dashboard, score: number }} Hit
 */

/**
 * A row in the suggestion dropdown.
 * @typedef {{ text: string, meta: string }} Suggestion
 */

/** @param {string} id @returns {HTMLElement} */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const form = /** @type {HTMLFormElement} */ (el('searchForm'));
const input = /** @type {HTMLInputElement} */ (el('q'));
const clearBtn = /** @type {HTMLButtonElement} */ (el('clearBtn'));
const suggestBox = /** @type {HTMLUListElement} */ (el('suggestions'));
const resultsArea = el('resultsArea');
const resultsList = el('results');
const statsEl = el('stats');
const emptyEl = el('empty');
const emptyTitle = /** @type {HTMLElement} */ (emptyEl.querySelector('h2'));
const emptyMsg = el('emptyMsg');
const divisionFilters = el('divisionFilters');
const statusFilters = el('statusFilters');
const browseEl = el('browse');
const divisionChips = el('divisionChips');
const categoryChips = el('categoryChips');
const examplesEl = el('examples');
const starredEl = el('starred');
const starGrid = el('starGrid');
const starredCount = el('starredN');

/** @type {Record<string, string>} */
const STATUS_LABEL = { live: 'Live', coming_soon: 'Coming soon' };

/** @type {Dashboard[]} */
let ITEMS = [];
/** @type {Set<string>} */
let activeDivisions = new Set();
/** @type {Set<string>} */
let activeStatuses = new Set();
/** @type {Hit[]} matches for the current query, before filters */
let lastMatches = [];
let suggestIndex = -1;
let isPartial = false;      // true when results only match some of the terms
let ready = false;          // false until data.json is in, or if it never arrives
/** @type {Map<string, Map<string, number>>} division -> category -> how many */
let TAXONOMY = new Map();
let browseDivision = '';    // '' when not browsing the taxonomy
let browseCategory = '';    // '' means the whole division
/** @type {Set<string>} ids of starred dashboards, mirrored into localStorage */
let starred = new Set();

/* ---------- data ---------- */

/**
 * @param {any} json  parsed data.json - untyped on purpose, it comes off the wire
 * @returns {Dashboard[]}
 */
function flatten(json) {
  /** @type {Dashboard[]} */
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
  ready = true;
  input.focus();
  buildTaxonomy();
  loadStars();
  renderChips();
  renderExamples();
  renderStarred();

  // the field is live from the first paint, so run anything typed while loading
  if (input.value.trim()) return runSearch(input.value);

  const params = new URLSearchParams(location.search);
  const initial = params.get('q');
  if (initial) {
    input.value = initial;
    runSearch(initial);
    return;
  }
  // ?division=...&category=... reopens a browse view
  const division = params.get('division');
  const cats = division ? TAXONOMY.get(division) : undefined;
  if (division && cats) {
    browseDivision = division;
    const category = params.get('category');
    if (category && cats.has(category)) browseCategory = category;
    runBrowse(false);
  }
}

/** @param {any} err */
function showLoadError(err) {
  document.body.className = 'state-results';
  resultsArea.hidden = false;
  resultsList.innerHTML = '';
  emptyEl.hidden = false;
  emptyTitle.textContent = 'Could not load data.json';
  emptyMsg.innerHTML =
    'Browsers block <code>fetch()</code> on <code>file://</code> pages. ' +
    'Serve this folder over HTTP, e.g. run <code>python -m http.server 8000</code> ' +
    'in this directory and open <code>http://localhost:8000</code>.' +
    '<br><br><small>' + String(err && err.message ? err.message : err) + '</small>';
}

/* ---------- search ---------- */

/** @param {string} s @returns {string[]} */
const tokenize = (s) => s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);

/**
 * Score one item against the query tokens. Every token must appear somewhere,
 * unless requireAll is false (the partial-match fallback).
 * @param {Dashboard} item
 * @param {string[]} tokens
 * @param {string} rawQuery
 * @param {boolean} [requireAll]
 * @returns {number} 0 means no match
 */
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

/** @param {string} text @param {string} token @returns {boolean} */
function wordStart(text, token) {
  const i = text.indexOf(token);
  if (i < 0) return false;
  return i === 0 || /[^a-z0-9]/i.test(text[i - 1]);
}

/**
 * @param {string} query
 * @param {boolean} [requireAll]
 * @returns {Hit[]} best match first
 */
function search(query, requireAll = true) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  /** @type {Hit[]} */
  const hits = [];
  for (const item of ITEMS) {
    const score = scoreItem(item, tokens, query, requireAll);
    if (score > 0) hits.push({ item, score });
  }
  hits.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return hits;
}

/* ---------- highlighting ---------- */

/** @param {string} s @returns {string} */
const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** @param {string} s @returns {string} */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @param {string} text @param {string[]} tokens @returns {string} html */
function highlight(text, tokens) {
  const safe = escapeHtml(text);
  if (!tokens.length) return safe;
  const re = new RegExp('(' + tokens.map(escapeRe).join('|') + ')', 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

/* ---------- rendering ---------- */

/** @param {string} query @param {boolean} [pushUrl] */
function runSearch(query, pushUrl = true) {
  if (!ready) return;   // still loading, or the load failed - keep what is on screen
  const q = query.trim();
  // an empty field is not a request to go anywhere - stay put and wait
  if (!q) return document.body.classList.contains('state-results') ? showBlank() : goHome();

  // a text search replaces any browse view
  browseDivision = '';
  browseCategory = '';
  renderChips();

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
  /** @type {Set<string>} */
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

/**
 * Show every dashboard in the open division, narrowed to one category if a
 * category chip is on. No query, so nothing is scored or highlighted.
 * @param {boolean} [pushUrl]
 */
function runBrowse(pushUrl = true) {
  if (!ready) return;
  if (!browseDivision) return goHome();

  input.value = '';
  clearBtn.hidden = true;
  isPartial = false;
  lastMatches = ITEMS
    .filter((i) => i.division === browseDivision && (!browseCategory || i.category === browseCategory))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => ({ item, score: 0 }));

  document.body.className = 'state-results browsing';
  moveSearchBox(true);
  resultsArea.hidden = false;
  hideSuggestions();

  // division is fixed here, so only the status filter still has anything to say
  /** @type {Set<string>} */
  const stats = new Set(lastMatches.map((m) => m.item.status));
  activeDivisions.clear();
  activeStatuses = new Set([...activeStatuses].filter((s) => stats.has(s)));

  renderChips();
  renderFilters();
  renderResults('');

  if (pushUrl) {
    history.replaceState(null, '', '?division=' + encodeURIComponent(browseDivision) +
      (browseCategory ? '&category=' + encodeURIComponent(browseCategory) : ''));
  }
}

/**
 * The query has been emptied while results were showing. Clear the list but
 * keep the docked search field, the caret and the scroll position where they
 * are - leaving for the home screen is the clear button's job, or Escape's.
 */
function showBlank() {
  lastMatches = [];
  isPartial = false;
  browseDivision = '';
  browseCategory = '';
  activeDivisions.clear();
  activeStatuses.clear();
  clearBtn.hidden = true;

  document.body.className = 'state-results browsing state-blank';   // chips and stars stay up
  resultsArea.hidden = false;
  renderChips();
  renderFilters();
  statsEl.innerHTML = '';
  resultsList.innerHTML = '';
  renderStarred();
  // with a starred grid on screen the page already says what to do next
  emptyEl.hidden = !starredEl.hidden;
  emptyTitle.textContent = '';
  emptyMsg.textContent =
    'Type to search ' + ITEMS.length + ' dashboards, or pick a division above.';
  history.replaceState(null, '', location.pathname);
}

function visibleMatches() {
  return lastMatches.filter(
    ({ item }) =>
      (!activeDivisions.size || activeDivisions.has(item.division)) &&
      (!activeStatuses.size || activeStatuses.has(item.status))
  );
}

/** @param {string} query */
function renderResults(query) {
  const tokens = tokenize(query);
  const shown = visibleMatches();

  const plural = shown.length === 1 ? '' : 's';
  statsEl.innerHTML = !shown.length
    ? ''
    : browseDivision
      ? `<b>${shown.length}</b> dashboard${plural} in <b>${escapeHtml(browseDivision)}</b>` +
        (browseCategory ? ' &middot; ' + escapeHtml(browseCategory) : '')
      : `<b>${shown.length}</b> result${plural} for <b>${escapeHtml(query)}</b>` +
        (isPartial ? ' &middot; no dashboard matches every term, showing partial matches' : '');

  resultsList.innerHTML = shown
    .map(({ item }) => card(item, tokens))
    .join('');

  const noResults = shown.length === 0;
  emptyEl.hidden = !noResults;
  if (noResults) {
    emptyTitle.textContent = 'No dashboards found';
    emptyMsg.textContent = lastMatches.length
      ? 'Your filters hid all ' + lastMatches.length + ' matches. Try clearing a filter.'
      : browseDivision
        ? 'This category is empty.'
        : 'Nothing matched "' + query + '". Check the spelling or try a broader term.';
  }
}

/** @param {Dashboard} item @param {string[]} tokens @returns {string} html */
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
    ${starButton(item)}
  </li>`;
}

/** @param {string} url @returns {string} an http(s) url, or '' if it is neither */
function safeUrl(url) {
  try {
    const u = new URL(url, location.href);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
  } catch { return ''; }
}

/** @param {string} url @returns {string} */
function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

/* ---------- filters ---------- */

function renderFilters() {
  /** @type {Map<string, number>} */
  const byDivision = new Map();
  /** @type {Map<string, number>} */
  const byStatus = new Map();
  for (const { item } of lastMatches) {
    byDivision.set(item.division, (byDivision.get(item.division) || 0) + 1);
    byStatus.set(item.status, (byStatus.get(item.status) || 0) + 1);
  }

  divisionFilters.innerHTML = browseDivision ? '' : [...byDivision.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => pill('division', name, name, n, activeDivisions.has(name)))
    .join('');

  statusFilters.innerHTML = [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => pill('status', s, STATUS_LABEL[s] || s, n, activeStatuses.has(s)))
    .join('');
}

/**
 * @param {string} kind
 * @param {string} value
 * @param {string} label
 * @param {number} count
 * @param {boolean} on
 * @returns {string} html
 */
function pill(kind, value, label, count, on) {
  return `<button type="button" class="pill" data-kind="${kind}" data-value="${escapeHtml(value)}"
    aria-pressed="${on}">${escapeHtml(label)}<span class="pill-n">${count}</span></button>`;
}

el('filters').addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('.pill') : null;
  if (!(btn instanceof HTMLElement)) return;
  const set = btn.dataset.kind === 'division' ? activeDivisions : activeStatuses;
  const value = btn.dataset.value;
  if (!value) return;
  set.has(value) ? set.delete(value) : set.add(value);
  renderFilters();
  renderResults(input.value.trim());
});

/* ---------- suggestions ---------- */

/** @param {string} query @returns {Suggestion[]} */
function buildSuggestions(query) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Suggestion[]} */
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

/** @type {{ q: string|null, hits: Hit[] }} */
let previewCache = { q: null, hits: [] };
/** @param {string} query @returns {Hit[]} */
function lastPreview(query) {
  if (previewCache.q !== query) previewCache = { q: query, hits: search(query).slice(0, 12) };
  return previewCache.hits;
}

/** @param {string} query */
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

/** @param {number} step +1 for down, -1 for up */
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
  const li = e.target instanceof Element ? e.target.closest('li') : null;
  if (!(li instanceof HTMLElement) || !li.dataset.value) return;
  e.preventDefault();
  input.value = li.dataset.value;
  runSearch(input.value);
});

/* ---------- state / events ---------- */

/**
 * Dock the search field into the topbar, or put it back in the hero.
 * Re-parenting detaches the field, and a detached input loses focus and its
 * caret - which would swallow the rest of whatever is being typed - so both
 * are restored afterwards.
 * @param {boolean} toTopbar
 */
function moveSearchBox(toTopbar) {
  const slot = toTopbar ? el('topbarSearchSlot') : el('searchboxHost');
  if (form.parentElement === slot) return;

  const hadFocus = document.activeElement === input;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  slot.insertBefore(form, slot.firstChild);
  if (!hadFocus) return;
  input.focus();
  if (typeof start === 'number' && typeof end === 'number') {
    try { input.setSelectionRange(start, end); } catch { /* not all inputs allow it */ }
  }
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
  browseDivision = '';
  browseCategory = '';
  renderChips();
  renderStarred();
  hideSuggestions();
  history.replaceState(null, '', location.pathname);
  input.focus();
}

/* ---------- browse chips ---------- */

function buildTaxonomy() {
  TAXONOMY = new Map();
  for (const item of ITEMS) {
    let cats = TAXONOMY.get(item.division);
    if (!cats) TAXONOMY.set(item.division, (cats = new Map()));
    cats.set(item.category, (cats.get(item.category) || 0) + 1);
  }
}

/** @param {Map<string, number>} cats @returns {number} */
const sizeOf = (cats) => [...cats.values()].reduce((a, b) => a + b, 0);

/** Divisions always; the open division's categories underneath it. */
function renderChips() {
  divisionChips.innerHTML = [...TAXONOMY.entries()]
    .sort((a, b) => sizeOf(b[1]) - sizeOf(a[1]) || a[0].localeCompare(b[0]))
    .map(([name, cats]) => chip('division', name, sizeOf(cats), browseDivision === name))
    .join('');

  const cats = TAXONOMY.get(browseDivision);
  if (!cats) {
    categoryChips.innerHTML = '';
    categoryChips.hidden = true;
    return;
  }
  categoryChips.innerHTML = [...cats.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => chip('category', name, n, browseCategory === name))
    .join('');
  categoryChips.hidden = false;
}

/**
 * @param {'division'|'category'} kind
 * @param {string} label
 * @param {number} count
 * @param {boolean} on
 * @returns {string} html
 */
function chip(kind, label, count, on) {
  return `<button type="button" class="chip" data-kind="${kind}" data-value="${escapeHtml(label)}"
    aria-pressed="${on}">${escapeHtml(label)}<span class="chip-n">${count}</span></button>`;
}

browseEl.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('.chip') : null;
  if (!(btn instanceof HTMLElement) || !btn.dataset.value) return;
  const value = btn.dataset.value;
  if (btn.dataset.kind === 'division') {
    // clicking the open division closes it and goes back home
    browseCategory = '';
    browseDivision = browseDivision === value ? '' : value;
  } else {
    browseCategory = browseCategory === value ? '' : value;
  }
  runBrowse();
});

/* ---------- example searches ---------- */

function renderExamples() {
  const picks = ['claims', 'ESG', 'portfolio', 'broker', 'profitability', 'forecasting'];
  examplesEl.innerHTML =
    '<span class="examples-label">Try</span>' +
    picks.map((p) => `<button type="button" class="chip chip-ghost">${escapeHtml(p)}</button>`).join('');
}

examplesEl.addEventListener('click', (e) => {
  const chip = e.target instanceof Element ? e.target.closest('.chip') : null;
  if (!chip) return;
  input.value = chip.textContent || '';
  runSearch(input.value);
});

/* ---------- starred dashboards ---------- */

const STAR_KEY = 'dashboardSearch.starred';

function loadStars() {
  try {
    const raw = localStorage.getItem(STAR_KEY);
    const list = raw ? JSON.parse(raw) : [];
    starred = new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
  } catch {
    starred = new Set();   // unreadable or disabled storage - start empty
  }
}

function saveStars() {
  try {
    localStorage.setItem(STAR_KEY, JSON.stringify([...starred]));
  } catch {
    /* private mode or a full quota: stars still work, they just do not persist */
  }
}

/** @param {string} id */
function toggleStar(id) {
  if (starred.has(id)) starred.delete(id);
  else starred.add(id);
  saveStars();
  renderStarred();
  syncStarButtons();
}

/** Keep every star button on the page matching the stored set. */
function syncStarButtons() {
  for (const btn of document.querySelectorAll('.star-btn')) {
    if (!(btn instanceof HTMLElement) || !btn.dataset.id) continue;
    const on = starred.has(btn.dataset.id);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', (on ? 'Unstar ' : 'Star ') + (btn.dataset.name || ''));
  }
}

/** @param {Dashboard} item @returns {string} html */
function starButton(item) {
  const on = starred.has(item.id);
  return `<button type="button" class="star-btn" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}"
    aria-pressed="${on}" aria-label="${on ? 'Unstar ' : 'Star '}${escapeHtml(item.name)}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.7l2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.2 5.9-.8z"/></svg>
  </button>`;
}

/** The home grid. Starred ids no longer present in data.json are skipped. */
function renderStarred() {
  const items = ITEMS.filter((i) => starred.has(i.id)).sort((a, b) => a.name.localeCompare(b.name));
  starredEl.hidden = items.length === 0;
  starredCount.textContent = items.length ? String(items.length) : '';
  starGrid.innerHTML = items.map(starCard).join('');
}

/** @param {Dashboard} item @returns {string} html */
function starCard(item) {
  const href = safeUrl(item.hyperlink);
  const name = escapeHtml(item.name);
  return `
  <div class="star-card">
    <div class="sc-crumbs"><span class="div">${escapeHtml(item.division)}</span><span class="sep">/</span>${escapeHtml(item.category)}</div>
    <h3>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${name}</a>` : name}</h3>
    <span class="sc-status ${escapeHtml(item.status)}">${escapeHtml(STATUS_LABEL[item.status] || item.status)}</span>
    ${starButton(item)}
  </div>`;
}

document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('.star-btn') : null;
  if (!(btn instanceof HTMLElement) || !btn.dataset.id) return;
  e.preventDefault();   // the row and the card are both covered by a link overlay
  toggleStar(btn.dataset.id);
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const picked = suggestIndex >= 0 ? suggestBox.children[suggestIndex] : null;
  if (picked instanceof HTMLElement && picked.dataset.value) {
    input.value = picked.dataset.value;
  }
  runSearch(input.value);
  hideSuggestions();
  // on a touch device the keyboard covers the results; on a desktop, dropping
  // focus just makes refining the query harder
  if (window.matchMedia('(hover: none)').matches) input.blur();
});

/** @type {ReturnType<typeof setTimeout>|undefined} */
let debounce;
input.addEventListener('input', () => {
  const q = input.value;
  clearBtn.hidden = !q;
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    if (!q.trim()) {
      hideSuggestions();
      if (document.body.classList.contains('state-results')) showBlank();
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
    // one step at a time: close the dropdown, then clear the query, then leave
    if (!suggestBox.hidden) hideSuggestions();
    else if (input.value) {
      input.value = '';
      clearBtn.hidden = true;
      if (document.body.classList.contains('state-results')) showBlank();
    } else goHome();
  }
});

input.addEventListener('focus', () => {
  if (input.value.trim()) showSuggestions(input.value);
});

document.addEventListener('click', (e) => {
  if (e.target instanceof Node && !form.contains(e.target)) hideSuggestions();
});

clearBtn.addEventListener('click', () => {
  input.value = '';
  clearBtn.hidden = true;
  hideSuggestions();
  if (document.body.classList.contains('state-results')) showBlank();
  input.focus();   // the point of clearing is to type something else
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
