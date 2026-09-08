// Runs a set of deliberately awkward queries against the source-aligned
// catalogue, and compares the old substring engine with the new one.
//
// Every query here is a real failure mode of the original: an abbreviation the
// name spells out, a spelled-out term the name abbreviates, a typo, a German
// name searched in English, and a concept that only appears in a column name.
//
//   node tools/test-search.js          # summary table
//   node tools/test-search.js -v       # ...plus the top hits and why they matched

'use strict';
const fs = require('fs');
const path = require('path');

// search.js is a plain browser script with no module system - that is what lets
// index.html load it with a <script> tag and keeps the project build-free. So
// it is evaluated rather than required.
const SearchEngine = new Function(
  fs.readFileSync(path.join(__dirname, '..', 'search.js'), 'utf8') + ';return SearchEngine;'
)();

const data = require(path.join(__dirname, '..', 'data-sa.json'));

const verbose = process.argv.includes('-v');
const records = data.reports.map((r) => SearchEngine.indexRecord({ ...r }));

/* ---- the engine as it was, for comparison ------------------------------- */

const oldTokenize = (s) => s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
function oldSearch(query) {
  const tokens = oldTokenize(query);
  if (!tokens.length) return [];
  return records.filter((r) => {
    // name + id + division + category + description, as app.js built it
    const hay = [r.name, r.id, r.division, r.category, r.description]
      .filter(Boolean).join(' ').toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

/* ---- what each query is meant to prove ---------------------------------- */

const CASES = [
  { q: 'gross written premium', why: 'spelled out; the names say GWP' },
  { q: 'gwp',                   why: 'abbreviated; some names spell it out' },
  { q: 'motor loss ratio',      why: 'names say MTR / LR / Kraftfahrt' },
  { q: 'kraftfahrt',            why: 'German name searched in German' },
  { q: 'motor',                 why: 'English query, German + coded names' },
  { q: 'exposure',              why: 'one report has the typo "Exopsure"' },
  { q: 'natcat',               why: 'appears as NC, NatCat and "NatCt"' },
  { q: 'ibnr',                  why: 'a metric, a measure and a column name' },
  { q: 'cedent',                why: 'only ever appears in a column name' },
  { q: 'treaty id',             why: 'column-level match, never in a title' },
  { q: 'retrocession',          why: 'names carry only the code RETRO' },
  { q: 'solvency',              why: 'names carry only SII' },
  { q: 'claims triangle',       why: 'names carry only TRI' },
  { q: 'ultimate loss',         why: 'ULT in names, spelled out in measures' },
  { q: 'schaden',               why: 'German for claims; catalogue says CLM' },
  { q: 'facultative property',  why: 'two codes, FAC and PROP' },
];

/* ---- run ---------------------------------------------------------------- */

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

console.log(`\n${records.length} source-aligned reports\n`);
console.log(pad('query', 22) + lpad('old', 5) + lpad('new', 6) + '   what it tests');
console.log('-'.repeat(78));

let oldFound = 0;
let newFound = 0;
let rescued = 0;

for (const { q, why } of CASES) {
  const before = oldSearch(q).length;
  let res = SearchEngine.search(records, q, true);
  if (!res.hits.length) res = SearchEngine.search(records, q, false); // partial fallback
  const after = res.hits;
  if (before) oldFound++;
  if (after.length && !res.weak) newFound++;
  if (!before && after.length && !res.weak) rescued++;

  const flag = res.weak ? ' ~' : (!before && after.length ? ' *' : '  ');
  console.log(pad(q, 22) + lpad(before, 5) + lpad(after.length, 6) + flag + ' ' + why);

  if (verbose && after.length) {
    for (const hit of after.slice(0, 3)) {
      const w = hit.why[0];
      const via = w && w.via ? ` via "${w.via}"` : '';
      const how = w ? `${w.kind} on ${w.field} "${w.word}"${via}` : '';
      const dq = hit.quality.reason ? `  [${hit.quality.reason}]` : '';
      console.log(`      ${lpad(Math.round(hit.score), 4)}  ${pad(hit.item.name, 34)} ${how}${dq}`);
    }
    console.log('');
  }
}

console.log('-'.repeat(78));
console.log(
  `old engine returned results for ${oldFound}/${CASES.length} queries, ` +
  `new engine ${newFound}/${CASES.length}  ` +
  `(* = ${rescued} rescued from zero, ~ = flagged weak and not counted)\n`
);

/* ---- ranking sanity: dead weight must not outrank the live report ------- */

const probe = SearchEngine.search(records, 'premium', true).hits;
const zombies = probe.filter((h) => h.quality.reason).length;
const topTenZombies = probe.slice(0, 10).filter((h) => h.quality.reason).length;
console.log(
  `ranking check - "premium": ${probe.length} hits, ${zombies} stale/abandoned overall, ` +
  `${topTenZombies} in the top 10\n`
);

/* ---- speed -------------------------------------------------------------- */

const t0 = Date.now();
const RUNS = 200;
for (let i = 0; i < RUNS; i++) SearchEngine.search(records, CASES[i % CASES.length].q, true);
console.log(`${RUNS} searches over ${records.length} records in ${Date.now() - t0}ms\n`);
