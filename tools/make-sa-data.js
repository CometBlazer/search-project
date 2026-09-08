// Generates a synthetic *source-aligned* report catalogue.
//
// The point of this file is not the data - it is the shape. Real source-aligned
// reports are messy in specific, repeatable ways: cryptic machine names, missing
// descriptions, near-duplicate copies, abandoned drafts, dead refreshes and no
// reliable folder taxonomy. Search that only works on tidy names and hand-written
// descriptions falls over on all of it, so the demo catalogue has to contain it.
//
// When the Power BI scanner API becomes available this file is what gets
// replaced: same output shape, real input. Everything downstream survives.
//
//   node tools/make-sa-data.js         # writes data-sa.json
//   node tools/make-sa-data.js 500     # ...with a different record count

'use strict';
const fs = require('fs');
const path = require('path');

// Deterministic, so regenerating does not churn the diff.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260907);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

/** Lines of business, with the abbreviations people actually type into a name. */
const LOB = [
  { name: 'Motor',       code: 'MTR',  de: 'Kraftfahrt' },
  { name: 'Property',    code: 'PROP', de: 'Sach' },
  { name: 'Casualty',    code: 'CAS',  de: 'Haftpflicht' },
  { name: 'Marine',      code: 'MAR',  de: 'Transport' },
  { name: 'Aviation',    code: 'AVI',  de: 'Luftfahrt' },
  { name: 'Engineering', code: 'ENG',  de: 'Technische' },
  { name: 'Credit',      code: 'CRD',  de: 'Kredit' },
  { name: 'Life',        code: 'LIFE', de: 'Leben' },
  { name: 'Health',      code: 'HLTH', de: 'Kranken' },
  { name: 'NatCat',      code: 'NC',   de: 'Naturgefahren' },
];

/** Business units, again with the codes that end up embedded in report names. */
const UNIT = [
  { name: 'Global Reinsurance', code: 'GLRE',  division: 'Reinsurance' },
  { name: 'Specialty',          code: 'SPEC',  division: 'Reinsurance' },
  { name: 'Facultative',        code: 'FAC',   division: 'Reinsurance' },
  { name: 'Retrocession',       code: 'RETRO', division: 'Reinsurance' },
  { name: 'Primary Insurance',  code: 'PI',    division: 'Primary Insurance' },
  { name: 'Risk Solutions',     code: 'RS',    division: 'Risk Solutions' },
  { name: 'Group Actuarial',    code: 'GACT',  division: 'Actuarial' },
  { name: 'Group Finance',      code: 'GFIN',  division: 'Finance' },
  { name: 'Claims',             code: 'CLM',   division: 'Claims' },
  { name: 'Underwriting',       code: 'UW',    division: 'Underwriting' },
];

/** Metrics, the third fragment of a typical machine name. */
const METRIC = [
  { name: 'Gross Written Premium', code: 'GWP',    topic: 'Premium' },
  { name: 'Net Written Premium',   code: 'NWP',    topic: 'Premium' },
  { name: 'Loss Ratio',            code: 'LR',     topic: 'Performance' },
  { name: 'Combined Ratio',        code: 'CR',     topic: 'Performance' },
  { name: 'Ultimate Loss',         code: 'ULT',    topic: 'Reserving' },
  { name: 'IBNR',                  code: 'IBNR',   topic: 'Reserving' },
  { name: 'Reserve Development',   code: 'RESDEV', topic: 'Reserving' },
  { name: 'Exposure',              code: 'EXP',    topic: 'Exposure' },
  { name: 'Probable Maximum Loss', code: 'PML',    topic: 'Exposure' },
  { name: 'Renewal',               code: 'REN',    topic: 'Renewal' },
  { name: 'Bordereaux',            code: 'BDX',    topic: 'Operations' },
  { name: 'Claims Triangle',       code: 'TRI',    topic: 'Reserving' },
  { name: 'Solvency II',           code: 'SII',    topic: 'Regulatory' },
  { name: 'IFRS 17',               code: 'IFRS17', topic: 'Regulatory' },
  { name: 'Cession',               code: 'CESS',   topic: 'Operations' },
];

const OWNERS = [
  'A. Weber', 'M. Schneider', 'J. Fischer', 'S. Braun', 'T. Hoffmann',
  'K. Richter', 'L. Zimmermann', 'P. Krause', 'N. Vogel', 'C. Baumann',
  'D. Keller', 'R. Lehmann',
];
// People who have left - their reports are still there, unowned and unrefreshed.
const DEPARTED = ['H. Neumann', 'B. Ostermann'];

const REGION = ['EMEA', 'APAC', 'NA', 'LATAM', 'DACH', 'UK', 'Nordics'];

/* ---------------------------------------------------------------- names --- */

/** Machine name: SA_GLRE_MTR_GWP_v2 - the dominant shape, unsearchable by word. */
const machineName = (u, l, m) =>
  `SA_${u.code}_${l.code}_${m.code}${chance(0.45) ? `_v${int(1, 4)}` : ''}`;

/** Human name: "Motor Loss Ratio EMEA" - readable, but a minority of the set. */
const humanName = (u, l, m) =>
  [l.name, m.name, chance(0.4) ? pick(REGION) : ''].filter(Boolean).join(' ');

/** camelCase run-together name, common from self-service authors. */
const camelName = (u, l, m) =>
  `${l.name}${m.code}${chance(0.5) ? 'Dashboard' : 'Report'}${chance(0.3) ? int(2, 4) : ''}`;

/** German name - a bilingual catalogue where neither side searches the other. */
const germanName = (u, l, m) =>
  `${l.de} ${pick(['Auswertung', 'Bericht', 'Uebersicht', 'Kennzahlen'])}` +
  `${chance(0.3) ? ' ' + int(2023, 2026) : ''}`;

/** The junk tail of any real workspace. */
const junkName = () => pick([
  'Untitled', 'Untitled 1', 'Report 1', 'Test', 'test2', 'Neues Dashboard',
  'TEMP - delete me', 'Kopie von Report', 'Draft', 'wip',
]);

/** Typos happen once and then get copied forever. */
function typo(s) {
  if (s.length < 6) return s;
  const i = int(2, s.length - 3);
  return chance(0.5)
    ? s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2)   // transposition
    : s.slice(0, i) + s.slice(i + 1);                    // dropped letter
}

/* ------------------------------------------------------------- metadata --- */

const TABLE_PREFIX = ['FACT', 'DIM', 'STG', 'VW', 'AGG'];
const TABLE_ENTITY = [
  'CLAIM', 'POLICY', 'TREATY', 'CEDENT', 'BROKER', 'PREMIUM', 'RESERVE',
  'EXPOSURE', 'CONTRACT', 'PARTNER', 'CURRENCY', 'CALENDAR', 'LAYER',
  'SECTION', 'ACCOUNT', 'PORTFOLIO',
];
const COLUMN_POOL = [
  'TREATY_ID', 'CEDENT_NAME', 'BROKER_NAME', 'UW_YEAR', 'ACCIDENT_YEAR',
  'BOOKING_DATE', 'LOSS_DATE', 'CURRENCY_CODE', 'GWP_ORIG', 'GWP_EUR',
  'NWP_EUR', 'PAID_LOSS', 'OS_RESERVE', 'IBNR_AMOUNT', 'ULT_LOSS',
  'ATTACHMENT_POINT', 'LAYER_LIMIT', 'CESSION_PCT', 'LINE_OF_BUSINESS',
  'COUNTRY_CODE', 'RISK_REGION', 'PERIL', 'SUM_INSURED', 'PML_AMOUNT',
  'COMMISSION_PCT', 'BROKERAGE', 'SEGMENT', 'PROFIT_CENTRE',
];
const MEASURE_POOL = [
  'Loss Ratio %', 'Combined Ratio %', 'GWP (EUR)', 'NWP (EUR)',
  'Ultimate Loss', 'IBNR', 'Reserve Movement', 'Premium Growth YoY',
  'Cession Rate', 'Expense Ratio %', 'Attritional Loss Ratio',
  'Large Loss Count', 'NatCat Load', 'Rate Change %', 'Retention %',
];

const WORKSPACES = [
  'SA - Global Reinsurance', 'SA_P&C_Reporting', 'SA - Actuarial',
  'SA Claims Analytics', 'Source Aligned - Finance', 'SA_Underwriting',
  'SA - Risk Solutions', 'Reporting (old)', 'Test', 'Sandbox',
];

const DESCRIPTIONS = [
  'Monthly view of {m} for the {l} portfolio, split by cedent and underwriting year.',
  '{m} tracking across {r}. Sourced from the treaty data mart.',
  'Operational report supporting the {l} {t} process.',
  '{l} {m} with drill-through to policy level detail.',
];

/** n distinct picks from a pool. */
const some = (pool, n) => {
  const out = new Set();
  const want = Math.min(n, pool.length);
  while (out.size < want) out.add(pick(pool));
  return [...out];
};

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000));
const YEAR_MS = 365 * 86400000;

/* ------------------------------------------------------------ generation --- */

function makeReport(i, existingNames) {
  const u = pick(UNIT);
  const l = pick(LOB);
  const m = pick(METRIC);

  // Name archetype. Machine names dominate a real source-aligned catalogue.
  const r = rnd();
  let name;
  if (r < 0.42) name = machineName(u, l, m);
  else if (r < 0.62) name = humanName(u, l, m);
  else if (r < 0.74) name = camelName(u, l, m);
  else if (r < 0.84) name = germanName(u, l, m);
  else if (r < 0.90) name = junkName();
  else name = typo(humanName(u, l, m));

  // Copies and abandoned versions - the biggest single source of catalogue noise.
  let abandoned = false;
  if (existingNames.length && chance(0.10)) {
    const base = pick(existingNames);
    name = pick([
      `Copy of ${base}`,
      `${base} (OLD)`,
      `${base} - DO NOT USE`,
      `${base}_final_FINAL`,
      `${base} v2`,
    ]);
    abandoned = /OLD|DO NOT USE/.test(name);
  }

  // Refresh state. A third of the catalogue is stale or outright broken.
  const rr = rnd();
  const lastRefresh =
    rr < 0.05 ? null                       // never refreshed / broken gateway
      : rr < 0.20 ? daysAgo(int(400, 1100)) // long dead
        : rr < 0.35 ? daysAgo(int(90, 400)) // stale
          : daysAgo(int(0, 30));            // healthy

  const dead = !lastRefresh || abandoned || Date.parse(lastRefresh) < Date.now() - YEAR_MS;

  // Usage is heavily zero-inflated: most of a messy catalogue is read by nobody.
  const views30d = dead ? int(0, 2) : chance(0.45) ? 0 : int(1, 320);

  const owner = chance(0.12) ? null : chance(0.08) ? pick(DEPARTED) : pick(OWNERS);

  // Descriptions are the exception, not the rule. This is exactly why
  // name-and-description search cannot work here.
  const description = chance(0.35)
    ? pick(DESCRIPTIONS)
      .replace('{m}', m.name).replace('{l}', l.name)
      .replace('{t}', m.topic.toLowerCase()).replace('{r}', pick(REGION))
    : '';

  return {
    id: `sa-${String(i).padStart(4, '0')}`,
    name,
    status: chance(0.08) ? 'coming_soon' : 'live',
    description,
    hyperlink: `https://app.powerbi.com/groups/me/reports/sa-${String(i).padStart(4, '0')}`,
    workspace: chance(0.03) ? '' : pick(WORKSPACES),
    owner,
    lastRefresh,
    views30d,
    // Only a minority carry a usable folder taxonomy. The rest have to be
    // found by what is inside them.
    division: chance(0.4) ? u.division : '',
    category: chance(0.2) ? m.topic : '',
    lineOfBusiness: chance(0.55) ? l.name : '',
    // The harvested guts of the dataset. On a report with no description and a
    // machine name, this is the only searchable text that exists.
    tables: [...new Set(
      Array.from({ length: int(2, 6) }, () => `${pick(TABLE_PREFIX)}_${pick(TABLE_ENTITY)}`)
    )],
    columns: some(COLUMN_POOL, int(4, 10)),
    measures: some(MEASURE_POOL, int(2, 6)),
  };
}

function main() {
  const count = Number(process.argv[2]) || 260;
  const reports = [];
  const names = [];
  for (let i = 1; i <= count; i++) {
    const rep = makeReport(i, names);
    reports.push(rep);
    // Only sane names are eligible to be copied, so copies stay believable.
    if (rep.name.length > 8 && !/^Copy of|OLD|DO NOT USE/.test(rep.name)) names.push(rep.name);
  }

  const dest = path.join(__dirname, '..', 'data-sa.json');
  fs.writeFileSync(dest, JSON.stringify({
    source: 'source-aligned',
    generated: iso(new Date()),
    note: 'Synthetic stand-in for the harvested source-aligned catalogue. See tools/make-sa-data.js.',
    reports,
  }, null, 2) + '\n');

  const pct = (n) => `${n} (${Math.round((100 * n) / count)}%)`;
  const noDesc = reports.filter((r) => !r.description).length;
  const noTax = reports.filter((r) => !r.division && !r.category).length;
  const stale = reports.filter(
    (r) => !r.lastRefresh || Date.parse(r.lastRefresh) < Date.now() - YEAR_MS
  ).length;
  const unread = reports.filter((r) => r.views30d === 0).length;
  process.stderr.write(
    `${dest}\n` +
    `  ${reports.length} reports\n` +
    `  ${pct(noDesc)} with no description\n` +
    `  ${pct(noTax)} with no taxonomy at all\n` +
    `  ${pct(stale)} stale or never refreshed\n` +
    `  ${pct(unread)} unopened in the last 30 days\n`
  );
}

main();
