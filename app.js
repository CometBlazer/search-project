// @ts-check
/* Dashboard Search - client-side search over data.json */

/**
 * One report, flattened out of whichever shape the catalogue arrived in.
 *
 * The fields after `category` come from harvested Power BI metadata and are
 * absent from the hand-curated catalogue. Everything reads them defensively:
 * a record with none of them still searches, ranks and renders correctly.
 *
 * @typedef {Object} Dashboard
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} hyperlink
 * @property {'live'|'coming_soon'} status
 * @property {string} division
 * @property {string} category
 * @property {string} [lineOfBusiness]
 * @property {string} [workspace]
 * @property {string} [owner]
 * @property {string|null} [lastRefresh]  ISO date; null means the refresh is broken
 * @property {number} [views30d]
 * @property {string[]} [tables]
 * @property {string[]} [columns]
 * @property {string[]} [measures]
 * @property {string} haystack             all of the above lowercased
 * @property {Record<string, string[]>} [_fields]  per-field tokens, built by search.js
 * @property {string[]} [_tokens]
 * @property {{factor: number, reason: string|null}} [_quality]
 */

/**
 * Why one query token matched: which field, which word in it, and whether it
 * took the vocabulary or a spelling correction to get there.
 * @typedef {{token: string, field: string, word: string, kind: string, via: string|null}} Why
 */

/**
 * A report together with its score for the current query.
 * @typedef {{ item: Dashboard, score: number, relevance?: number,
 *             quality?: {factor: number, reason: string|null},
 *             matched?: number, why?: Why[] }} Hit
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
const qualityFilters = el('qualityFilters');
const starredEl = el('starred');
const starGrid = el('starGrid');
const starredCount = el('starredN');

/** @type {Record<string, string>} */
const STATUS_LABEL = { live: 'Live', coming_soon: 'Coming soon' };

/**
 * Whether a `coming_soon` dashboard's `hyperlink` is a place you can actually
 * go. It is not in this catalogue - every record carries the same generated
 * URL whatever its status - so those titles render as plain text and the host
 * label is left off, rather than offering a link that leads nowhere.
 *
 * Set this to true if `coming_soon` entries start pointing at something real,
 * a preview or a spec page; nothing else needs to change.
 */
const LINK_COMING_SOON = false;

/** @param {Dashboard} item @returns {string} the url to link to, '' for none */
function linkFor(item) {
  if (item.status === 'coming_soon' && !LINK_COMING_SOON) return '';
  return safeUrl(item.hyperlink);
}

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
let ready = false;          // false until the catalogue is in, or if it never arrives
/**
 * Only the records that carry one. A harvested catalogue is about half
 * untaxonomised, so this is a navigation aid over part of the data rather than
 * a complete index of it - hence the separate `total`, which counts records in
 * the division whether or not they also have a category.
 * @type {Map<string, {total: number, cats: Map<string, number>}>}
 */
let TAXONOMY = new Map();

/** True when the catalogue carries harvested usage figures worth showing. */
let HAS_USAGE = false;
/** True when it carries refresh timestamps. */
let HAS_REFRESH = false;
/** Hide stale, abandoned and scratch reports. Off by default - they are still real. */
let hideDeadwood = false;
/** The query matched only incidental metadata. See SearchEngine.WEAK_TOP_SCORE. */
let isWeak = false;
let browseDivision = '';    // '' when not browsing the taxonomy
let browseCategory = '';    // '' means the whole division
/** @type {Set<string>} ids of starred dashboards, mirrored into localStorage */
let starred = new Set();

/* ---------- data ---------- */

/**
 * Which catalogue to load. `?src=` lets the curated demo set and the
 * source-aligned set be shown side by side without a rebuild; it is matched
 * against a strict filename pattern so it can only ever name a JSON file
 * sitting next to index.html, never a path or another origin.
 */
const DATA_URL = (() => {
  const src = new URLSearchParams(location.search).get('src');
  return src && /^[\w-]+\.json$/.test(src) ? src : 'data.json';
})();

/** The `src` actually in use, or '' when it is the default catalogue. */
const SRC_PARAM = DATA_URL === 'data.json' ? '' : DATA_URL;

/**
 * Replace the URL's query string, preserving `?src=`.
 *
 * Without this the first search rewrites the URL to `?q=...` alone, and a
 * reload or a shared link quietly drops back to the default catalogue - so a
 * link to a source-aligned result would open the curated demo instead.
 *
 * @param {string} qs query string body, with no leading '?'
 */
function setUrl(qs) {
  const parts = [qs, SRC_PARAM ? 'src=' + encodeURIComponent(SRC_PARAM) : ''].filter(Boolean);
  history.replaceState(null, '', parts.length ? '?' + parts.join('&') : location.pathname);
}

/**
 * Accepts both catalogue shapes.
 *
 * The curated set nests division -> category -> dashboards, because someone
 * filed every entry by hand. Harvested source-aligned data has no such tree:
 * it is a flat list where division and category are per-record fields that are
 * frequently blank. Reading both from one function is what lets the same UI
 * demo the tidy catalogue and the real mess.
 *
 * @param {any} json  parsed catalogue - untyped on purpose, it comes off the wire
 * @returns {Dashboard[]}
 */
function flatten(json) {
  /** @type {Dashboard[]} */
  const out = [];

  /** @param {any} raw @param {string} division @param {string} category */
  const push = (raw, division, category) => {
    /** @type {any} */
    const rec = {
      id: raw.id || '',
      name: raw.name || '',
      description: raw.description || '',
      hyperlink: raw.hyperlink || '',
      status: raw.status || 'live',
      division: raw.division || division || '',
      category: raw.category || category || '',
      lineOfBusiness: raw.lineOfBusiness || '',
      workspace: raw.workspace || '',
      owner: raw.owner || '',
      views30d: Number(raw.views30d) || 0,
      tables: Array.isArray(raw.tables) ? raw.tables : [],
      columns: Array.isArray(raw.columns) ? raw.columns : [],
      measures: Array.isArray(raw.measures) ? raw.measures : [],
      haystack: ''
    };
    // Only set when the catalogue actually tracks it. `null` is a real value
    // here - it means the refresh is broken - so a curated record must be left
    // without the key rather than given a null, or every one of them would be
    // demoted as never-refreshed.
    if (raw.lastRefresh !== undefined) rec.lastRefresh = raw.lastRefresh;
    out.push(SearchEngine.indexRecord(rec));
  };

  if (Array.isArray(json && json.reports)) {
    for (const raw of json.reports) push(raw, '', '');
    return out;
  }
  const groups = (json && json.dashboards) || {};
  for (const [division, categories] of Object.entries(groups)) {
    for (const [category, list] of Object.entries(categories || {})) {
      for (const raw of list || []) push(raw, division, category);
    }
  }
  return out;
}

async function load() {
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    ITEMS = flatten(await res.json());
  } catch (err) {
    showLoadError(err);
    return;
  }
  HAS_USAGE = ITEMS.some((i) => (i.views30d || 0) > 0);
  HAS_REFRESH = ITEMS.some((i) => 'lastRefresh' in i);
  const divisions = new Set(ITEMS.map((i) => i.division).filter(Boolean)).size;
  const untaxonomised = ITEMS.filter((i) => !i.division).length;
  el('heroSub').textContent = HAS_REFRESH
    // The harvested catalogue: say up front how much of it is unfiled, because
    // that is the reason searching it is hard and browsing it is not enough.
    ? 'Search ' + ITEMS.length + ' source-aligned reports' +
      (untaxonomised ? ' \u00b7 ' + untaxonomised + ' of them filed under nothing' : '')
    : 'Search ' + ITEMS.length + ' dashboards across ' + divisions + ' divisions';
  if (HAS_REFRESH) input.placeholder = 'Search source-aligned reports';
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
  const entry = division ? TAXONOMY.get(division) : undefined;
  if (division && entry) {
    browseDivision = division;
    const category = params.get('category');
    if (category && entry.cats.has(category)) browseCategory = category;
    runBrowse(false);
  }
}

/** @param {any} err */
function showLoadError(err) {
  document.body.className = 'state-results';
  resultsArea.hidden = false;
  resultsList.innerHTML = '';
  emptyEl.hidden = false;
  emptyTitle.textContent = 'Could not load ' + DATA_URL;
  emptyMsg.innerHTML =
    'Browsers block <code>fetch()</code> on <code>file://</code> pages. ' +
    'Serve this folder over HTTP, e.g. run <code>python -m http.server 8000</code> ' +
    'in this directory and open <code>http://localhost:8000</code>.' +
    '<br><br><small>' + String(err && err.message ? err.message : err) + '</small>';
}

/* ---------- search ---------- */

/**
 * Query tokens, as the engine splits them. Used here only for highlighting and
 * for the "did the user type more than one word" checks; the matching itself
 * lives in search.js.
 * @param {string} s @returns {string[]}
 */
const tokenize = (s) => SearchEngine.tokenizeQuery(s);

/**
 * @param {string} query
 * @param {boolean} [requireAll]
 * @returns {{hits: Hit[], weak: boolean}} best match first
 */
const search = (query, requireAll = true) => SearchEngine.search(ITEMS, query, requireAll);

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

  let res = search(q);
  isPartial = false;
  if (!res.hits.length && tokenize(q).length > 1) {
    // nothing matched every term - fall back to anything matching at least one
    res = search(q, false);
    isPartial = res.hits.length > 0;
  }
  lastMatches = res.hits;
  isWeak = res.weak;

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

  if (pushUrl) setUrl(q ? 'q=' + encodeURIComponent(q) : '');
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
  isWeak = false;
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
    setUrl('division=' + encodeURIComponent(browseDivision) +
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
  isWeak = false;
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
  emptyMsg.textContent = 'Type to search ' + ITEMS.length +
    (HAS_REFRESH ? ' reports.' : ' dashboards, or pick a division above.');
  setUrl('');
}

function visibleMatches() {
  return lastMatches.filter(
    ({ item }) =>
      (!activeDivisions.size || activeDivisions.has(item.division)) &&
      (!activeStatuses.size || activeStatuses.has(item.status)) &&
      (!hideDeadwood || !deadwoodReason(item))
  );
}

/**
 * Why this report is dead weight, or '' if it is not. Stale, never refreshed,
 * named "(OLD)", or an obvious working copy - the engine works this out while
 * ranking, and the UI reuses its verdict so the two can never disagree.
 * @param {Dashboard} item @returns {string}
 */
const deadwoodReason = (item) => (item._quality && item._quality.reason) || '';

/** @param {string} query */
function renderResults(query) {
  const tokens = tokenize(query);
  const shown = visibleMatches();

  const plural = shown.length === 1 ? '' : 's';
  const hidden = hideDeadwood ? lastMatches.length - shown.length : 0;
  statsEl.innerHTML = !shown.length
    ? ''
    : browseDivision
      ? `<b>${shown.length}</b> report${plural} in <b>${escapeHtml(browseDivision)}</b>` +
        (browseCategory ? ' &middot; ' + escapeHtml(browseCategory) : '')
      : isWeak
        // Nothing is named for this. Say so, rather than presenting a long tail
        // of datasets that merely happen to contain a field of that name in
        // relevance order, which reads as a working search and is not one.
        ? `Nothing is named for <b>${escapeHtml(query)}</b>. ` +
          `<b>${shown.length}</b> report${plural} contain a matching field or column.`
        : `<b>${shown.length}</b> result${plural} for <b>${escapeHtml(query)}</b>` +
          (isPartial ? ' &middot; no report matches every term, showing partial matches' : '') +
          (hidden ? ` &middot; ${hidden} stale or abandoned hidden` : '');

  resultsList.innerHTML = shown.map((hit) => card(hit, tokens)).join('');

  const noResults = shown.length === 0;
  emptyEl.hidden = !noResults;
  if (noResults) {
    emptyTitle.textContent = 'No dashboards found';
    emptyMsg.textContent = lastMatches.length
      ? 'Your filters hid all ' + lastMatches.length + ' matches. Try clearing a filter.'
      : browseDivision
        ? 'This category is empty.'
        : 'Nothing matched "' + query + '". Spelling is forgiven and abbreviations ' +
          'are expanded, so this term is probably not in the catalogue at all.';
  }
}

/**
 * A title marked as an outbound link. The arrow is glued to the last word so
 * a wrapping title can never leave it stranded on a line of its own; the only
 * spaces in `html` are real ones, `highlight` adds no space inside its tags.
 * @param {string} html a title, already escaped and possibly marked up
 * @returns {string} html
 */
function withArrow(html) {
  const i = html.lastIndexOf(' ');
  const last = html.slice(i + 1);
  return html.slice(0, i + 1) +
    `<span class="nb">${last}<span class="ext" aria-hidden="true"></span></span>`;
}

/** Fields the result row already renders, so a match in one is self-evident. */
const VISIBLE_FIELDS = new Set(['name', 'id', 'division', 'category', 'lineOfBusiness']);

/** What to call each searchable field when explaining a match. */
/** @type {Record<string, string>} */
const FIELD_LABEL = {
  name: 'name', id: 'id', lineOfBusiness: 'line of business', category: 'category',
  division: 'division', description: 'description', workspace: 'workspace',
  owner: 'owner', tables: 'table', columns: 'column', measures: 'measure',
};

/**
 * "matched column IBNR_AMOUNT" - shown only when the match is not self-evident
 * from the title.
 *
 * On a curated catalogue this would be noise: you can see why "Motor Claims"
 * matched "motor". On harvested data it is the difference between a result that
 * looks arbitrary and one the user can trust, because a report called
 * `SA_GLRE_MTR_GWP_v3` matching "gross written premium" is otherwise
 * inexplicable.
 *
 * @param {Hit} hit @returns {string} html
 */
function whyLine(hit) {
  if (!hit.why || !hit.why.length) return '';
  // The title and the crumb line are already on screen with the match
  // highlighted in them, so repeating those in words says nothing. What needs
  // explaining is a match the row does not show: a column, a measure, a table -
  // or a term that only matched through the vocabulary or a spelling fix.
  const notable = hit.why.filter(
    (w) => w.via || w.kind.startsWith('fuzzy') || !VISIBLE_FIELDS.has(w.field)
  );
  if (!notable.length) return '';

  // Several query tokens routinely land on the same word - every term of
  // "gross written premium" resolves to the one `GWP` in the name - so group
  // by what was matched, not by what was typed, or the line repeats itself
  // once per token.
  /** @type {Map<string, {tokens: string[], w: Why}>} */
  const groups = new Map();
  for (const w of notable) {
    const key = w.field + '|' + w.word;
    const g = groups.get(key);
    if (g) g.tokens.push(w.token);
    else groups.set(key, { tokens: [w.token], w });
  }

  const parts = [...groups.values()].slice(0, 3).map(({ tokens, w }) => {
    const where = FIELD_LABEL[w.field] || w.field;
    const word = `<i>${escapeHtml(w.word)}</i>`;
    const typed = escapeHtml(tokens.join(' '));
    // The via term is usually the matched word itself, and naming it twice
    // ("gross written premium -> gwp in name gwp") reads as a stutter.
    if (w.via && w.via !== w.word) return `${typed} &rarr; ${escapeHtml(w.via)} in ${where} ${word}`;
    if (w.via) return `${typed} &rarr; ${where} ${word}`;
    if (w.kind.startsWith('fuzzy')) return `${typed} &asymp; ${where} ${word}`;
    return `${where} ${word}`;
  });
  return `<p class="why">matched ${parts.join(' &middot; ')}</p>`;
}

/**
 * How long ago the dataset refreshed, and whether that is a problem.
 * @param {Dashboard} item @returns {string} html
 */
function freshness(item) {
  if (!('lastRefresh' in item)) return '';
  if (!item.lastRefresh) return '<span class="fresh bad">never refreshed</span>';
  const t = Date.parse(item.lastRefresh);
  if (Number.isNaN(t)) return '';
  const days = Math.max(0, Math.round((Date.now() - t) / 86400000));
  const cls = days > 365 ? 'bad' : days > 90 ? 'warn' : 'ok';
  const ago =
    days === 0 ? 'today'
      : days === 1 ? 'yesterday'
        : days < 60 ? days + ' days ago'
          : days < 365 ? Math.round(days / 30) + ' months ago'
            : Math.floor(days / 365) + 'y ago';
  return `<span class="fresh ${cls}">refreshed ${ago}</span>`;
}

/** @param {Hit} hit @param {string[]} tokens @returns {string} html */
function card(hit, tokens) {
  const item = hit.item;
  const href = linkFor(item);
  const host = safeHost(href);
  // Mark the words that actually matched as well as the words that were typed,
  // so a vocabulary or spelling hit is visible in the title rather than
  // leaving it looking untouched.
  const marks = [...new Set(tokens.concat((hit.why || []).map((w) => w.word)))];
  const title = highlight(item.name, marks);
  /** @type {string[]} */
  const crumbs = [item.division, item.category, item.lineOfBusiness || ''].filter(Boolean);
  const dead = deadwoodReason(item);

  return `
  <li class="row${href ? '' : ' is-soon'}${dead ? ' is-deadwood' : ''}">
    ${crumbs.length ? `<div class="crumbs">${
      crumbs.map((c, i) => (i ? '<span class="sep">/</span>' : '') +
        `<span class="${i ? '' : 'div'}">${highlight(c, marks)}</span>`).join('')
    }</div>` : ''}
    <h3>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${withArrow(title)}</a>` : title}</h3>
    ${item.description ? `<p>${highlight(item.description, marks)}</p>` : ''}
    ${whyLine(hit)}
    <div class="row-meta">
      <span class="status ${escapeHtml(item.status)}">${escapeHtml(STATUS_LABEL[item.status] || item.status)}</span>
      <span class="row-id">${highlight(item.id, marks)}</span>
      ${freshness(item)}
      ${HAS_USAGE ? `<span class="views${item.views30d ? '' : ' none'}">${
        item.views30d ? item.views30d + ' opens / 30d' : 'unopened'
      }</span>` : ''}
      ${item.owner ? `<span class="owner">${highlight(item.owner, marks)}</span>` : ''}
      ${dead && !/refresh/.test(dead) ? `<span class="deadwood">${escapeHtml(dead)}</span>` : ''}
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
    .filter(([name]) => name)   // half a harvested catalogue has no division
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => pill('division', name, name, n, activeDivisions.has(name)))
    .join('');

  statusFilters.innerHTML = [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => pill('status', s, STATUS_LABEL[s] || s, n, activeStatuses.has(s)))
    .join('');

  // One toggle for the whole of the catalogue's dead weight. On messy data this
  // is the most-used control on the page, so it gets to be a single click
  // rather than a set of facets the user has to assemble.
  const dead = lastMatches.filter(({ item }) => deadwoodReason(item)).length;
  qualityFilters.innerHTML = dead
    ? pill('quality', 'deadwood', 'Hide stale & abandoned', dead, hideDeadwood)
    : '';
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
  const value = btn.dataset.value;
  if (!value) return;
  if (btn.dataset.kind === 'quality') {
    hideDeadwood = !hideDeadwood;
  } else {
    const set = btn.dataset.kind === 'division' ? activeDivisions : activeStatuses;
    set.has(value) ? set.delete(value) : set.add(value);
  }
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

  // matching facets first, then the top reports
  for (const { item } of lastPreview(query)) {
    for (const [text, meta] of [
      [item.category, 'category'],
      [item.division, 'division'],
      [item.lineOfBusiness || '', 'line of business'],
    ]) {
      const key = meta + ':' + text;
      if (!text) continue;
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
    out.push({ text: item.name, meta: item.division || item.lineOfBusiness || item.workspace || '' });
  }
  return out.slice(0, 8);
}

/** @type {{ q: string|null, hits: Hit[] }} */
let previewCache = { q: null, hits: [] };
/** @param {string} query @returns {Hit[]} */
function lastPreview(query) {
  if (previewCache.q !== query) {
    previewCache = { q: query, hits: search(query).hits.slice(0, 12) };
  }
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
  setUrl('');
  input.focus();
}

/* ---------- browse chips ---------- */

/**
 * Build the browse tree from whatever taxonomy the records carry.
 *
 * Blank divisions and categories are skipped rather than becoming an empty-named
 * chip. That is not a tidy-up: on harvested data roughly half the catalogue has
 * no division at all, so browsing is a shortcut into the filed part and search
 * is the only way to reach the rest. The counts have to say the filed part only,
 * or the chips promise coverage the tree does not have.
 */
function buildTaxonomy() {
  TAXONOMY = new Map();
  for (const item of ITEMS) {
    if (!item.division) continue;
    let entry = TAXONOMY.get(item.division);
    if (!entry) TAXONOMY.set(item.division, (entry = { total: 0, cats: new Map() }));
    entry.total++;
    if (item.category) entry.cats.set(item.category, (entry.cats.get(item.category) || 0) + 1);
  }
}

/** Divisions always; the open division's categories underneath it. */
function renderChips() {
  divisionChips.innerHTML = [...TAXONOMY.entries()]
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([name, entry]) => chip('division', name, entry.total, browseDivision === name))
    .join('');

  const entry = TAXONOMY.get(browseDivision);
  if (!entry || !entry.cats.size) {
    categoryChips.innerHTML = '';
    categoryChips.hidden = true;
    return;
  }
  categoryChips.innerHTML = [...entry.cats.entries()]
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

/**
 * Every source-aligned example is chosen to fail on a plain substring search
 * and succeed here: an abbreviation the catalogue spells out, a spelled-out
 * term it abbreviates, a German name searched in English, a typo, and a concept
 * that only exists inside a dataset. They are the demo.
 */
const SA_EXAMPLES =
  ['gross written premium', 'motor loss ratio', 'natcat exposure', 'ibnr', 'retrocession', 'kraftfahrt'];
const CURATED_EXAMPLES =
  ['claims', 'ESG', 'portfolio', 'broker', 'profitability', 'forecasting'];

function renderExamples() {
  const picks = HAS_REFRESH ? SA_EXAMPLES : CURATED_EXAMPLES;
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
  const href = linkFor(item);
  const name = escapeHtml(item.name);
  return `
  <div class="star-card${href ? '' : ' is-soon'}">
    <div class="sc-crumbs"><span class="div">${escapeHtml(item.division)}</span><span class="sep">/</span>${escapeHtml(item.category)}</div>
    <h3>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${withArrow(name)}</a>` : name}</h3>
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
