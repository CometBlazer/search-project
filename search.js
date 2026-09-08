// @ts-check
'use strict';

/**
 * Matching and ranking, extracted from app.js so it can be tested in Node
 * (tools/test-search.js) as well as run in the browser.
 *
 * The original engine matched query substrings against name + id + division +
 * category + description. That is enough for a curated catalogue where every
 * record has a readable name and a hand-written description. It finds close to
 * nothing in a source-aligned catalogue, where two thirds of reports have no
 * description at all and the name is `SA_GLRE_MTR_GWP_v3`.
 *
 * Four changes carry the difference:
 *
 *   1. Sub-word tokenisation, so `SA_GLRE_MTR_GWP_v3` and `MotorNWPReport`
 *      break into words that a query can actually hit.
 *   2. A domain vocabulary (below), so `gwp` finds "Gross Written Premium",
 *      `motor` finds `MTR` and `Kraftfahrt`, and vice versa.
 *   3. Typo tolerance, because a misspelling gets made once and then copied
 *      into every derived report forever.
 *   4. Matching over harvested metadata - tables, columns, measures - which is
 *      often the only meaningful text a report has.
 *
 * Then quality signals demote the catalogue's dead weight, which on messy data
 * matters about as much as relevance does.
 */

const SearchEngine = (function () {

  /* ------------------------------------------------------------ tuning --- */

  /**
   * Points available per field when a query token matches it outright.
   * Roughly: what the report is called, then what it is about, then what is
   * inside it, then who owns it.
   * @type {Record<string, number>}
   */
  const FIELD_WEIGHT = {
    name: 100,
    id: 85,
    lineOfBusiness: 70,
    category: 58,
    measures: 58,
    tables: 48,
    columns: 46,
    division: 44,
    description: 40,
    workspace: 34,
    owner: 28,
  };

  /** How much of the field weight each kind of match earns. @type {Record<string, number>} */
  const MATCH_QUALITY = {
    exact: 1.0,     // token is the whole word
    prefix: 0.72,   // word starts with the token
    contains: 0.44, // word contains the token
    fuzzy1: 0.56,   // one edit away  - "exopsure" / "exposure"
    fuzzy2: 0.32,   // two edits away
  };

  /** A match found only through the vocabulary is worth less than a literal one. */
  const SYNONYM_FACTOR = 0.8;

  /**
   * Shortest query token allowed to match as a bare substring.
   *
   * Domain abbreviations are three or four letters, and at that length a
   * substring match is almost always an accident: `TRI` (claims triangle) is
   * inside "at*tri*tional", `CAS` inside "for*cas*t", `EXP` inside "*exp*ense".
   * Short tokens still match exactly, as a word prefix, through the vocabulary
   * and through spelling correction - all of which are anchored - so this costs
   * nothing real and removes a whole class of baffling result.
   */
  const MIN_CONTAINS_LEN = 4;

  /**
   * Fields that say what the report *is*, as opposed to what is inside it.
   * Rarity weighting is softened on these: `TREATY_ID` being in two thirds of
   * datasets makes it a poor search term, but a report actually *called*
   * "Treaty" is still the right answer for that query.
   */
  const IDENTITY_FIELDS = new Set(['name', 'id', 'lineOfBusiness', 'category', 'division']);
  const IDENTITY_IDF_FLOOR = 0.45;

  /**
   * Hits scoring below this fraction of the best hit are dropped.
   *
   * Harvested metadata makes almost everything match almost everything - every
   * dataset has a premium column - so without a floor a good query returns two
   * thirds of the catalogue and looks broken. The floor is on relative score,
   * not a fixed count, so a query with one clear answer returns one.
   */
  const SCORE_FLOOR = 0.14;

  /**
   * Below this top score, the query did not really match anything: it only
   * brushed against metadata that most datasets happen to share.
   *
   * `cedent` is the worked example. Half the datasets carry a CEDENT_NAME
   * column, so the query "matches" 128 reports - every one of them scoring 2,
   * because rarity weighting correctly judges the term worthless here. Ranking
   * cannot fix that; there is no better answer hiding in the tail. The honest
   * response is to hand the results over with a flag saying nothing is actually
   * *about* this, rather than to present noise in relevance order.
   *
   * Real queries in this catalogue top out between 60 and 300, so the gap is
   * wide and this threshold is not delicate.
   */
  const WEAK_TOP_SCORE = 25;

  const PHRASE_IN_NAME = 55;   // the whole query appears in the name
  const PHRASE_ANYWHERE = 14;  // ...or anywhere else in the record

  /**
   * Quality multipliers applied to the relevance total.
   *
   * These are the part that a curated catalogue never needs. In a messy one
   * roughly a quarter of reports are stale and two fifths were not opened by
   * anyone last month, so ranking on relevance alone puts abandoned copies
   * above the report people actually use. Deliberately multiplicative and
   * bounded, so they reorder near-ties without ever burying an exact hit.
   */
  const QUALITY = {
    fresh:   1.00,  // refreshed within 30 days
    recent:  0.97,  // within 90
    ageing:  0.90,  // within a year
    stale:   0.74,  // older than a year
    never:   0.68,  // never refreshed, or the refresh is broken
    /** Usage lift: 1 + USAGE_LIFT * log10(1 + views). ~1.30 at 320 views. */
    USAGE_LIFT: 0.125,
    /** Names that announce the report should not be used. */
    abandoned: 0.55,
    /** Working copies and scratch reports - noise, but occasionally the real one. */
    scratch: 0.75,
    comingSoon: 0.97,
  };

  /** Names that say "do not use me". */
  const ABANDONED_RE = /\b(old|do not use|deprecated|obsolete|delete me|archive[d]?)\b/i;
  /** Names that say "this was never meant to be found". */
  const SCRATCH_RE = /^(copy of |kopie von |untitled|report \d|test\d*|draft|wip|neues dashboard|temp\b)/i;

  /* -------------------------------------------------------- vocabulary --- */

  /**
   * Groups of terms that mean the same thing here. Every word in a group
   * expands to every single-word term in that group, in both directions, so
   * `gwp` finds "Gross Written Premium" and "premium" finds `..._GWP_v2`.
   *
   * This table is the cheapest quality lever in the project and the one a
   * domain expert can extend without touching any other code. Keep it flat and
   * keep it boring - it is meant to be edited by someone who does not read JS.
   */
  const VOCABULARY = [
    // Metrics
    ['gwp', 'gross written premium', 'gross premium', 'bruttopraemie'],
    ['nwp', 'net written premium', 'net premium', 'nettopraemie'],
    ['premium', 'praemie', 'pramie', 'beitrag'],
    ['lr', 'loss ratio', 'schadenquote'],
    ['cr', 'combined ratio', 'gesamtquote'],
    ['ibnr', 'incurred but not reported', 'spaetschaeden'],
    ['ult', 'ultimate', 'ultimate loss', 'endschaden'],
    ['resdev', 'reserve development', 'reserve movement', 'abwicklung'],
    ['reserve', 'reserves', 'reserven', 'rueckstellung'],
    ['exp', 'exposure', 'exponierung'],
    ['pml', 'probable maximum loss'],
    ['ren', 'renewal', 'renewals', 'erneuerung'],
    ['bdx', 'bordereau', 'bordereaux'],
    ['tri', 'triangle', 'triangles', 'claims triangle', 'dreieck'],
    ['sii', 'solvency', 'solvency ii', 'solvenz'],
    ['ifrs17', 'ifrs 17', 'ifrs'],
    ['cess', 'cession', 'ceded', 'zession'],
    ['rate', 'rates', 'rate change', 'ratenaenderung'],

    // Lines of business
    ['mtr', 'motor', 'kraftfahrt', 'kfz', 'auto'],
    ['prop', 'property', 'sach'],
    ['cas', 'casualty', 'liability', 'haftpflicht'],
    ['mar', 'marine', 'transport'],
    ['avi', 'aviation', 'luftfahrt'],
    ['eng', 'engineering', 'technische', 'technisch'],
    ['crd', 'credit', 'kredit'],
    ['life', 'leben', 'lebensversicherung'],
    ['hlth', 'health', 'kranken', 'krankenversicherung'],
    ['nc', 'natcat', 'nat cat', 'catastrophe', 'catastrophes', 'naturgefahren'],

    // Units and divisions
    ['glre', 'global reinsurance', 'reinsurance', 'rueckversicherung'],
    ['spec', 'specialty', 'speciality'],
    ['fac', 'facultative', 'fakultativ'],
    ['retro', 'retrocession', 'retro'],
    ['pi', 'primary insurance', 'erstversicherung'],
    ['rs', 'risk solutions'],
    ['gact', 'group actuarial', 'actuarial', 'aktuariat'],
    ['gfin', 'group finance', 'finance', 'finanzen'],
    ['clm', 'claims', 'claim', 'schaden', 'schaeden'],
    ['uw', 'underwriting', 'zeichnung'],
    ['sa', 'source aligned'],

    // Shape of the thing
    ['report', 'bericht', 'auswertung', 'uebersicht', 'ubersicht'],
    ['dashboard', 'dash'],
    ['kennzahlen', 'metrics', 'metric', 'kpi', 'kpis'],
    ['ptf', 'portfolio', 'bestand', 'book'],

    // Entities
    ['cedent', 'cedents', 'ceding company', 'zedent'],
    ['treaty', 'treaties', 'vertrag', 'vertraege', 'contract'],
    ['broker', 'brokers', 'makler'],
    ['policy', 'policies', 'police', 'vertragspolice'],
    ['ay', 'accident year', 'schadenjahr'],
    ['uy', 'underwriting year', 'zeichnungsjahr'],
  ];

  /**
   * word -> the single-word terms it is equivalent to.
   * Multi-word entries contribute each of their words as a key, which is what
   * makes "gross written premium" and "gwp" reach each other.
   * @type {Map<string, string[]>}
   */
  const SYNONYMS = (() => {
    /** @type {Map<string, Set<string>>} */
    const map = new Map();
    for (const group of VOCABULARY) {
      const singles = group.filter((t) => !t.includes(' '));
      for (const term of group) {
        for (const word of term.split(' ')) {
          if (!map.has(word)) map.set(word, new Set());
          const set = /** @type {Set<string>} */ (map.get(word));
          for (const s of singles) if (s !== word) set.add(s);
        }
      }
    }
    return new Map([...map].map(([k, v]) => [k, [...v]]));
  })();

  /* ------------------------------------------------------- tokenisation --- */

  /**
   * Split text into lowercase words, breaking on punctuation *and* on the two
   * boundaries a machine-generated name hides words behind: a case change and a
   * letter/digit change.
   *
   *   SA_GLRE_MTR_GWP_v3  -> sa glre mtr gwp v 3
   *   MotorNWPReport      -> motor nwp report
   *   IFRS17Dashboard     -> ifrs 17 dashboard
   *
   * Runs of capitals are kept whole up to the last one, so `NWPReport` yields
   * `nwp` + `report` rather than `n` + `w` + `preport`.
   *
   * @param {string} s
   * @returns {string[]}
   */
  function tokenize(s) {
    if (!s) return [];
    return String(s)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')        // motorNwp -> motor Nwp
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')      // NWPReport -> NWP Report
      .replace(/([a-zA-Z])(\d)/g, '$1 $2')            // ifrs17 -> ifrs 17
      .replace(/(\d)([a-zA-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  /**
   * The same text split on punctuation only, leaving run-together words whole.
   *
   * Sub-word splitting is what makes `SA_GLRE_MTR_GWP` searchable, but it also
   * takes `NatCat` apart into `nat` + `cat`, and then the query "natcat" matches
   * neither half. Indexing both forms costs a handful of tokens per record and
   * lets a compound name be found by its parts or whole.
   * @param {string} s @returns {string[]}
   */
  function rawTokens(s) {
    return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  /**
   * Query tokens: as above, minus single characters that only add noise.
   * @param {string} s @returns {string[]}
   */
  function tokenizeQuery(s) {
    return tokenize(s).filter((t) => t.length > 1 || /\d/.test(t));
  }

  /* --------------------------------------------------------- edit distance --- */

  /** @type {Map<string, number>} memo, cleared each search */
  let distCache = new Map();

  /**
   * Damerau-Levenshtein, bounded. Returns `max + 1` as soon as it is clear the
   * true distance exceeds `max`, so the common "nothing like it" case is cheap.
   * @param {string} a @param {string} b @param {number} max
   */
  function editDistance(a, b, max) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const key = a + '|' + b + '|' + max;
    const hit = distCache.get(key);
    if (hit !== undefined) return hit;

    const n = a.length;
    const m = b.length;
    let prev2 = /** @type {number[]} */ (new Array(m + 1));
    let prev = /** @type {number[]} */ (new Array(m + 1));
    let cur = /** @type {number[]} */ (new Array(m + 1));
    for (let j = 0; j <= m; j++) prev[j] = j;

    for (let i = 1; i <= n; i++) {
      cur[0] = i;
      let best = cur[0];
      for (let j = 1; j <= m; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          v = Math.min(v, prev2[j - 2] + 1); // transposition
        }
        cur[j] = v;
        if (v < best) best = v;
      }
      if (best > max) { distCache.set(key, max + 1); return max + 1; }
      const tmp = prev2; prev2 = prev; prev = cur; cur = tmp;
    }
    const out = prev[m];
    distCache.set(key, out);
    return out;
  }

  /** How many edits we will forgive on a token of this length. @param {number} len */
  const fuzzBudget = (len) => (len <= 3 ? 0 : len <= 6 ? 1 : 2);

  /**
   * Cheap pre-filter before paying for edit distance: a real typo almost always
   * leaves one of the first two characters intact.
   * @param {string} q @param {string} w @param {number} max
   */
  const fuzzCandidate = (q, w, max) =>
    Math.abs(q.length - w.length) <= max && (q[0] === w[0] || q[1] === w[1]);

  /* -------------------------------------------------------------- index --- */

  /**
   * Precompute the per-field token lists once per record. Called by flatten();
   * search() will do it lazily if it was skipped.
   * @param {any} rec
   */
  function indexRecord(rec) {
    /** @type {Record<string, string[]>} */
    const fields = {};
    /** @param {string} key @param {string|string[]|null|undefined} value */
    const put = (key, value) => {
      const text = Array.isArray(value) ? value.join(' ') : value;
      if (!text) return;
      const toks = [...new Set([...tokenize(text), ...rawTokens(text)])];
      if (toks.length) fields[key] = toks;
    };

    put('name', rec.name);
    put('id', rec.id);
    put('lineOfBusiness', rec.lineOfBusiness);
    put('category', rec.category);
    put('division', rec.division);
    put('description', rec.description);
    put('workspace', rec.workspace);
    put('owner', rec.owner);
    put('tables', rec.tables);
    put('columns', rec.columns);
    put('measures', rec.measures);

    rec._fields = fields;
    // Every token in the record, for the fuzzy pass and for cheap rejection.
    rec._tokens = [...new Set(Object.values(fields).flat())];
    rec._quality = qualityFactor(rec);
    rec.haystack = [
      rec.name, rec.id, rec.division, rec.category, rec.lineOfBusiness,
      rec.workspace, rec.owner, rec.description,
      (rec.tables || []).join(' '), (rec.columns || []).join(' '),
      (rec.measures || []).join(' '),
    ].filter(Boolean).join(' ').toLowerCase();
    return rec;
  }

  /* --------------------------------------------------------- rarity/idf --- */

  /**
   * How many records contain each token, and how many records there are.
   * @type {{records: any[]|null, n: number, df: Map<string, number>}}
   */
  let corpus = { records: null, n: 0, df: new Map() };

  /**
   * Document frequency over the catalogue. Rebuilt when the record set changes.
   * @param {any[]} records
   */
  function buildCorpus(records) {
    const df = new Map();
    for (const rec of records) {
      if (!rec._fields) indexRecord(rec);
      for (const token of rec._tokens) df.set(token, (df.get(token) || 0) + 1);
    }
    corpus = { records, n: records.length, df };
    return corpus;
  }

  /**
   * Selectivity of a term, in 0..1. A token unique to one report scores near 1;
   * one present in every report scores near 0.
   *
   * Squared, because the raw log ratio is too flat to separate "in 10% of the
   * catalogue" from "in 80% of it", which is exactly the distinction that
   * decides whether harvested column names help or drown everything.
   * @param {string} token
   */
  function idf(token) {
    if (!corpus.n) return 1;
    const df = corpus.df.get(token) || 0;
    const raw = Math.log(1 + corpus.n / (1 + df)) / Math.log(1 + corpus.n);
    return raw * raw;
  }

  /* ------------------------------------------------------------ quality --- */

  const DAY = 86400000;

  /**
   * One multiplier folding together freshness, usage and what the name admits
   * about itself. Exposed on the record as `_quality` so the UI can explain a
   * demotion rather than just applying it silently.
   * @param {any} rec
   */
  function qualityFactor(rec) {
    let age = QUALITY.fresh;
    /** @type {string|null} */
    let reason = null;

    if ('lastRefresh' in rec) {
      const t = rec.lastRefresh ? Date.parse(rec.lastRefresh) : NaN;
      if (!rec.lastRefresh || Number.isNaN(t)) { age = QUALITY.never; reason = 'never refreshed'; }
      else {
        const days = (Date.now() - t) / DAY;
        if (days > 365) { age = QUALITY.stale; reason = 'not refreshed in over a year'; }
        else if (days > 90) age = QUALITY.ageing;
        else if (days > 30) age = QUALITY.recent;
      }
    }

    const views = Number(rec.views30d) || 0;
    const usage = 1 + QUALITY.USAGE_LIFT * Math.log10(1 + views);

    let name = 1;
    if (ABANDONED_RE.test(rec.name || '')) { name = QUALITY.abandoned; reason = 'marked as not for use'; }
    else if (SCRATCH_RE.test(rec.name || '')) { name = QUALITY.scratch; reason = reason || 'looks like a working copy'; }

    const status = rec.status === 'coming_soon' ? QUALITY.comingSoon : 1;

    return { factor: age * usage * name * status, reason };
  }

  /* ------------------------------------------------------------ scoring --- */

  /**
   * Rarity multiplier for a word matched in a given field, softened on the
   * fields that identify the report rather than describe its contents.
   * @param {string} field @param {string} word
   */
  function rarity(field, word) {
    const r = idf(word);
    return IDENTITY_FIELDS.has(field)
      ? IDENTITY_IDF_FLOOR + (1 - IDENTITY_IDF_FLOOR) * r
      : r;
  }

  /**
   * Best score this one term can earn anywhere in the record, plus where it
   * came from.
   * @param {any} rec @param {string} term @param {boolean} allowFuzzy
   * @returns {{score: number, field: string|null, word: string|null, kind: string|null}}
   */
  function scoreTerm(rec, term, allowFuzzy) {
    let best = { score: 0, field: /** @type {string|null} */ (null), word: /** @type {string|null} */ (null), kind: /** @type {string|null} */ (null) };

    for (const field in rec._fields) {
      const weight = FIELD_WEIGHT[field];
      if (!weight) continue;
      // idf never exceeds 1, so this stays a valid upper bound on the field.
      if (weight * MATCH_QUALITY.exact <= best.score) continue;

      for (const word of rec._fields[field]) {
        /** @type {string|null} */
        let kind = null;
        if (word === term) kind = 'exact';
        else if (word.startsWith(term)) kind = 'prefix';
        else if (term.length >= MIN_CONTAINS_LEN && word.includes(term)) kind = 'contains';

        if (kind) {
          const s = weight * MATCH_QUALITY[kind] * rarity(field, word);
          if (s > best.score) best = { score: s, field, word, kind };
        }
      }
    }

    if (!allowFuzzy || best.score > 0) return best;

    // Only now, and only against tokens that could plausibly be a typo of this
    // one, do we pay for edit distance.
    const budget = fuzzBudget(term.length);
    if (budget === 0) return best;
    for (const field in rec._fields) {
      const weight = FIELD_WEIGHT[field];
      if (!weight) continue;
      for (const word of rec._fields[field]) {
        if (!fuzzCandidate(term, word, budget)) continue;
        const d = editDistance(term, word, budget);
        if (d === 0 || d > budget) continue;
        const q = d === 1 ? MATCH_QUALITY.fuzzy1 : MATCH_QUALITY.fuzzy2;
        const s = weight * q * rarity(field, word);
        if (s > best.score) best = { score: s, field, word, kind: 'fuzzy' + d };
      }
    }
    return best;
  }

  /**
   * Score one query token, trying the literal term first and the vocabulary
   * only if that fails to beat it.
   * @param {any} rec @param {string} token
   */
  function scoreToken(rec, token) {
    const direct = scoreTerm(rec, token, true);

    const alts = SYNONYMS.get(token);
    if (alts) {
      for (const alt of alts) {
        // Synonyms are checked literally: a fuzzy match on a synonym of a
        // typo is two guesses deep and produces nonsense.
        const hit = scoreTerm(rec, alt, false);
        const s = hit.score * SYNONYM_FACTOR;
        if (s > direct.score) {
          return { score: s, field: hit.field, word: hit.word, kind: hit.kind, via: alt };
        }
      }
    }
    return { ...direct, via: /** @type {string|null} */ (null) };
  }

  /**
   * @param {any} rec
   * @param {string[]} tokens
   * @param {string} rawQuery
   * @param {boolean} requireAll
   */
  function scoreItem(rec, tokens, rawQuery, requireAll = true) {
    if (!rec._fields) indexRecord(rec);

    let total = 0;
    let matched = 0;
    /** @type {Array<{token: string, field: string, word: string, kind: string, via: string|null}>} */
    const why = [];

    for (const token of tokens) {
      const hit = scoreToken(rec, token);
      if (hit.score <= 0) {
        if (requireAll) return null;
        continue;
      }
      matched++;
      total += hit.score;
      why.push({
        token,
        field: /** @type {string} */ (hit.field),
        word: /** @type {string} */ (hit.word),
        kind: /** @type {string} */ (hit.kind),
        via: hit.via,
      });
    }
    if (!matched) return null;

    const phrase = rawQuery.trim().toLowerCase();
    if (phrase.length > 2 && tokens.length > 1) {
      if ((rec.name || '').toLowerCase().includes(phrase)) total += PHRASE_IN_NAME;
      else if (rec.haystack.includes(phrase)) total += PHRASE_ANYWHERE;
    }

    const quality = rec._quality || qualityFactor(rec);
    return {
      item: rec,
      score: total * quality.factor,
      relevance: total,
      quality,
      matched,
      why,
    };
  }

  /**
   * @param {any[]} records
   * @param {string} query
   * @param {boolean} requireAll every token must match somewhere
   * @returns {{hits: any[], weak: boolean}} `weak` means the results are
   *   incidental metadata collisions rather than real matches - see
   *   WEAK_TOP_SCORE. Callers should say so rather than render them plainly.
   */
  function search(records, query, requireAll = true) {
    distCache = new Map();
    const tokens = tokenizeQuery(query);
    if (!tokens.length) return { hits: [], weak: false };
    if (corpus.records !== records) buildCorpus(records);

    const out = [];
    for (const rec of records) {
      const hit = scoreItem(rec, tokens, query, requireAll);
      if (hit) out.push(hit);
    }
    out.sort((a, b) =>
      b.score - a.score || String(a.item.name).localeCompare(String(b.item.name)));

    // Cut the long tail of incidental metadata matches. See SCORE_FLOOR.
    if (out.length) {
      const cut = out[0].score * SCORE_FLOOR;
      let end = out.length;
      while (end > 1 && out[end - 1].score < cut) end--;
      if (end < out.length) out.length = end;
    }
    return { hits: out, weak: out.length > 0 && out[0].score < WEAK_TOP_SCORE };
  }

  return {
    search, scoreItem, indexRecord, buildCorpus, idf, tokenize, tokenizeQuery,
    qualityFactor, editDistance,
    SYNONYMS, VOCABULARY, FIELD_WEIGHT, MATCH_QUALITY, QUALITY, WEAK_TOP_SCORE,
  };
})();

/*
 * No module system on purpose. search.js is a plain script so index.html can
 * load it with a <script> tag and app.js can see `SearchEngine` as a global -
 * the same reason the rest of this project has no build step. Node picks it up
 * by evaluating the file instead; see tools/test-search.js.
 */
