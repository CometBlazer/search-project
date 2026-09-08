# Dashboard Search

A single-page search over a catalogue of reports. Type a query, get ranked
results with the matched terms highlighted and an explanation of why each one
matched, and narrow them down by division, status or freshness. You can also
browse by division and category from the chips under the search box, and star
the reports you use so they sit in a grid on the home screen. Everything runs in
the browser: there is no backend, no build step and no dependencies.

It ships with two catalogues, and the difference between them is the point:

| | `data.json` | `data-sa.json` |
|---|---|---|
| What it is | 83 curated dashboards | 260 harvested source-aligned reports |
| Names | `Sample Dashboard 055` | `SA_GLRE_MTR_GWP_v3`, `Kraftfahrt Auswertung`, `Untitled 1` |
| Descriptions | every record | a third of them |
| Taxonomy | every record, two levels | half of them, unreliably |
| Freshness | n/a | a quarter stale or never refreshed |

A substring search over names and descriptions is entirely adequate for the
first and close to useless for the second, which is what
[the search engine](#2-the-search-engine) exists to fix. Open
`?src=data-sa.json` to search the messy one.

---

## Quick start

The page reads `data.json` with `fetch()`, and browsers block `fetch()` on
`file://` URLs. **Opening `index.html` by double-clicking it will not work** -
you will get a "Could not load data.json" message instead of results. Serve the
folder over HTTP instead. Any of these will do:

```
node serve.js              # included, no dependencies, http://localhost:8000
node serve.js 3000         # ...on a different port
npx serve                  # if you would rather not keep serve.js
python -m http.server 8000 # if Python is what you have
```

Or open the folder in VS Code and use the **Live Server** extension.

Then:

```
http://localhost:8000                      # the curated catalogue
http://localhost:8000/?src=data-sa.json    # the source-aligned one
```

`?src=` accepts a bare `*.json` filename sitting next to `index.html` and
nothing else - no paths, no other origins. It is carried through every URL the
page writes, so a link to a source-aligned result reopens that catalogue.

To regenerate the source-aligned catalogue or check the engine:

```
node tools/make-sa-data.js     # rewrites data-sa.json (deterministic)
node tools/test-search.js      # old engine vs new, on 16 awkward queries
node tools/test-search.js -v   # ...with top hits and why they matched
```

## Files

| File | What it is |
|---|---|
| `index.html` | Page skeleton. Two states - home and results - switched by a class on `<body>`. |
| `styles.css` | All styling, including the light/dark palettes. No framework. |
| `search.js` | Matching and ranking: tokenising, vocabulary, typo tolerance, rarity weighting, quality signals. |
| `app.js` | Loading, rendering, browse, filters, suggestions, stars. Calls into `search.js`. |
| `data.json` | The curated catalogue. |
| `data-sa.json` | The source-aligned catalogue. Generated - see `tools/make-sa-data.js`. |
| `serve.js` | Local preview server. Development only - **never deployed**. |
| `jsconfig.json` | Editor type-checking for `app.js` and `search.js`. Editor only - **never deployed**. |
| `tools/make-sa-data.js` | Generates `data-sa.json`. Development only. |
| `tools/test-search.js` | Runs awkward queries against the catalogue and compares old engine with new. Development only. |
| `README.md` | This file. |

The first six are deployed. `search.js` is a plain script, not a module - that is
what keeps the whole thing loadable from a `<script>` tag with no build step, and
it is why `tools/test-search.js` evaluates the file rather than `require`-ing it.

---

## How it works

### 1. The data

`data.json` nests dashboards two levels deep - division, then category:

```json
{
  "dashboards": {
    "Claims": {
      "Claims Operations": [
        {
          "id": "mock-dashboard-055",
          "name": "Sample Dashboard 055",
          "status": "live",
          "description": "...",
          "hyperlink": "https://example.com/mock-dashboards/055"
        }
      ]
    }
  }
}
```

`data-sa.json` uses the other accepted shape - a flat `reports` array, where
`division` and `category` are per-record fields that are frequently blank,
because a harvested catalogue has no reliable folder tree to nest into:

```json
{
  "reports": [
    {
      "id": "sa-0035",
      "name": "SA_GFIN_ENG_GWP",
      "status": "live",
      "description": "",
      "hyperlink": "https://app.powerbi.com/...",
      "workspace": "SA - Global Reinsurance",
      "owner": "K. Richter",
      "lastRefresh": "2026-08-23",
      "views30d": 247,
      "division": "", "category": "", "lineOfBusiness": "Engineering",
      "tables":   ["FACT_PREMIUM", "DIM_CEDENT"],
      "columns":  ["GWP_EUR", "UW_YEAR", "TREATY_ID"],
      "measures": ["GWP (EUR)", "Premium Growth YoY"]
    }
  ]
}
```

`flatten()` reads both shapes into the same flat array. The fields after
`category` come from harvested Power BI metadata; everything downstream treats
them as optional, so a curated record with none of them searches, ranks and
renders correctly.

`lastRefresh` is the one field where absent and `null` mean different things.
Absent means the catalogue does not track refreshes at all, and nothing is
inferred. `null` means it does track them and this one is broken - so the record
is demoted. A curated record must therefore be left without the key rather than
given a `null`, or the entire curated catalogue would rank as never-refreshed.

`indexRecord()` in `search.js` then precomputes each record's per-field token
lists, its quality multiplier, and a `haystack` string used for phrase matching.

`status` is either `live` or `coming_soon`; anything else renders with its raw
value as the label.

**`coming_soon` records are not linked.** Every record in this catalogue carries
a `hyperlink` whatever its status, and the coming-soon ones point at the same
generated URL shape as the live ones - so they are placeholders, not preview
pages, and offering them as links would send people somewhere that is not there
yet. Those rows render the name as plain text with no host label; the amber
"Coming soon" marker is the explanation, and they can still be starred so they
are waiting for you when they land. Everything else - matching, ranking,
filtering, browsing - treats them exactly like live records.

The decision is one line in `app.js`:

```js
const LINK_COMING_SOON = false;
```

Set it to `true` if `coming_soon` entries start pointing at something real, a
preview or a spec page. `linkFor()` is the only place that reads it, and both
the result rows and the starred cards go through it.

**To change what is searchable, edit `data.json` and reload.** Adding a
dashboard, a category or a whole division needs no code change - the browse
chips, the filter bar and the count on the home screen are all derived from the
data at runtime.

### 2. The search engine

All of this lives in `search.js`. The short version: **five layers, each one
answering a specific way that harvested metadata defeats substring matching.**

Run `node tools/test-search.js` to see the difference on the source-aligned
catalogue, or `-v` to see the top hits and why each matched.

#### Sub-word tokenising

`tokenize()` splits on punctuation *and* on the two boundaries a machine name
hides words behind - a case change and a letter/digit change:

```
SA_GLRE_MTR_GWP_v3  ->  sa glre mtr gwp v 3
MotorNWPReport      ->  motor nwp report
IFRS17Dashboard     ->  ifrs 17 dashboard
```

Runs of capitals stay whole up to the last one, so `NWPReport` gives `nwp` +
`report` rather than `n w preport`. Records are *also* indexed with punctuation-
only splitting (`rawTokens()`), because sub-word splitting takes `NatCat` apart
into `nat` + `cat` and then the query "natcat" matches neither half.

#### A domain vocabulary

`VOCABULARY` is a flat list of groups of equivalent terms. Every word in a group
reaches every single-word term in it, both directions, so `gwp` finds "Gross
Written Premium", "premium" finds `..._GWP_v2`, and `motor`, `MTR` and
`Kraftfahrt` all find each other. A vocabulary match scores 80% of a literal one.

This table is the cheapest quality lever in the project and the only part a
domain expert can extend without reading any JavaScript. **When search misses
something, add a row here first.**

#### Typo tolerance

Bounded Damerau-Levenshtein, one edit forgiven on tokens of 4-6 characters and
two above that, tried only after literal matching has failed and only against
tokens that could plausibly be a misspelling (length within budget, one of the
first two characters intact). Distances are memoised per search, which matters
because harvested column names repeat heavily across records.

This is not a nicety. A misspelling gets made once and then copied into every
derived report forever - the generated catalogue contains `Propery`, `Writen`,
`Exopsure` and `NatCt` for exactly that reason.

#### Rarity weighting

Matching over tables, columns and measures is what lets a report with no
description be found at all. It also, on its own, makes almost everything match
almost everything: every dataset has a premium column, so "gross written
premium" returned 157 of 260 records before this layer existed.

So each match is scaled by how *selective* the matched word is across the
catalogue - a squared inverse document frequency, squared because the raw log
ratio is too flat to separate "in 10% of the catalogue" from "in 80% of it",
which is the distinction that decides whether column names help or drown
everything. Identity fields (name, id, line of business, category, division) get
a softened version: `TREATY_ID` appearing in two thirds of datasets makes it a
poor search term, but a report actually *called* "Treaty" is still the right
answer.

Two cutoffs follow from this:

- **`SCORE_FLOOR`** drops hits below 14% of the best hit, cutting the long tail
  of incidental metadata collisions. It is relative, so a query with one clear
  answer returns one.
- **`WEAK_TOP_SCORE`** catches the case the floor cannot. Search `cedent`: half
  the datasets carry a `CEDENT_NAME` column, so 128 reports "match", every one
  of them scoring 2, because rarity weighting has correctly judged the term
  worthless here. There is no better answer hiding in the tail and ranking
  cannot manufacture one. Below a top score of 25 the results are handed over
  flagged `weak`, and the UI says *"Nothing is named for cedent. 128 reports
  contain a matching field or column"* rather than presenting noise in relevance
  order and looking like a working search. Real queries in this catalogue top
  out between 60 and 300, so the threshold is not delicate.

#### Field weights and match quality

Score for one term = field weight x match quality x rarity.

| Field | Weight | | Match | Quality |
|---|---|---|---|---|
| name | 100 | | is the whole word | 1.00 |
| id | 85 | | word starts with it | 0.72 |
| line of business | 70 | | word contains it | 0.44 |
| category / measure | 58 | | one edit away | 0.56 |
| table | 48 | | two edits away | 0.32 |
| column | 46 | | | |
| division | 44 | | via the vocabulary | x 0.80 |
| description | 40 | | | |
| workspace | 34 | | | |
| owner | 28 | | | |

Substring matching is refused below `MIN_CONTAINS_LEN` (4 characters). Domain
abbreviations are three or four letters, and at that length a bare substring
match is nearly always an accident - `TRI` sits inside "at**tri**tional", `CAS`
inside "for**cas**t", `EXP` inside "**exp**ense". Short tokens still match
exactly, as a word prefix, through the vocabulary and through spelling
correction, all of which are anchored, so this costs nothing real.

Every token must match somewhere for a record to appear. A phrase bonus adds 55
if the whole query appears in the name and 14 if it appears anywhere else.

**Partial-match fallback.** If a multi-word query matches nothing, the search
runs again accepting records that match *at least one* term, and the results
line says so rather than showing an empty page.

#### Quality signals

The relevance total is then multiplied by one bounded factor combining how fresh
the dataset is, how much it is used, and what its own name admits about itself:

| Signal | Effect |
|---|---|
| Refreshed within 30 / 90 / 365 days | x 1.00 / 0.97 / 0.90 |
| Older than a year | x 0.74 |
| Never refreshed, or refresh broken | x 0.68 |
| Usage | x (1 + 0.125 x log10(1 + opens in 30 days)), so ~1.30 at 320 opens |
| Name says `(OLD)` / `DO NOT USE` / `deprecated` | x 0.55 |
| Name says `Copy of` / `Untitled` / `Test` / `Draft` | x 0.75 |

A curated catalogue never needs any of this. A messy one does: a quarter of the
source-aligned reports are stale and two fifths were not opened by anyone last
month, so ranking on relevance alone puts abandoned copies above the report
people actually use. The multipliers are deliberately bounded - they reorder
near-ties, they never bury an exact hit - and nothing is ever hidden by them.
`deadwoodReason()` reuses the engine's own verdict for the **Hide stale &
abandoned** toggle and the dimmed rows, so ranking and UI cannot disagree.

#### Explaining the match

`scoreItem()` returns a `why` array saying which field and which word each query
token landed on, and whether it took the vocabulary or a spelling correction to
get there. `whyLine()` renders it as *"matched gross written premium -> name
GWP"* or *"matched column IBNR_AMOUNT"*.

It appears only when the row does not already show the answer: matches in the
title and the crumb line are highlighted in place, so restating them in words
says nothing. On a curated catalogue this line almost never appears, and that is
correct - you can see why "Motor Claims" matched "motor". On harvested data it is
the difference between a result that looks arbitrary and one the user can trust,
because `SA_GLRE_MTR_GWP_v3` matching "gross written premium" is otherwise
inexplicable.

### 3. Rendering and escaping

Results are built as an HTML string and assigned once to `innerHTML`. Every
value interpolated into that string passes through `escapeHtml()`, and query
terms are regex-escaped by `escapeRe()` before `highlight()` wraps matches in
`<mark>`. Result links pass through `safeUrl()`, which only ever emits `http:`
and `https:` URLs - see [Security](#security).

A row shows only what the record can support. The crumb line collapses to
whichever of division, category and line of business exist; the description
paragraph is dropped entirely when there is none; and freshness, opens and owner
appear only when the catalogue tracks them (`HAS_REFRESH`, `HAS_USAGE`, both
derived from the data at load). So the curated catalogue renders exactly as it
did before any of this existed.

**Highlighting marks what matched, not only what was typed.** `card()` builds
its mark list from the query tokens *plus* every word in the hit's `why` array.
Without that, `SA_GFIN_ENG_GWP` would sit under the query "gross written
premium" with nothing marked at all, looking like a result the engine could not
justify - when in fact `GWP` is precisely the word it matched.

### 4. The two states

`<body>` carries either `state-home` or `state-results`, and CSS keys off that.
The search field is a single element that `moveSearchBox()` physically relocates
between the hero and the top bar, so it keeps its value and its event listeners
across the transition rather than being two separate fields.

Re-parenting a focused input detaches it, and a detached input loses focus and
its caret - which silently swallowed the rest of whatever was being typed when
the field docked. `moveSearchBox()` records both before the move and restores
them after, so typing runs straight through the transition.

**Nothing navigates on its own.** Emptying the field - by backspacing, by the
clear button, or by Escape - does *not* return to the home screen. `showBlank()`
keeps the docked field, the focus and the caret exactly where they are, clears
the list, drops `?q=` from the URL and leaves the browse chips and the starred
grid on screen (`<body>` gains `state-blank`). Going home is an explicit act:
the brand link, or Escape on an already-empty field.

The field also works before `data.json` arrives. It is never `disabled`; a query
typed during loading is kept and run as soon as the catalogue lands, and
`runSearch()`/`runBrowse()` no-op until then, so a failed load keeps its error
message on screen instead of being overwritten by an empty result list.

### 5. Filters

The division and status filters are built from the current result set, not from
the whole catalogue, so counts always add up to what you are looking at. Toggling
one re-renders the list without re-running the search. Filters that no longer
apply are dropped automatically when a new query narrows things. Blank divisions
are skipped rather than becoming an empty-named pill.

A third pill, **Hide stale & abandoned**, appears whenever the result set
contains any, and hides everything `deadwoodReason()` flags - stale, never
refreshed, `(OLD)`, or an obvious working copy. It is one toggle rather than a
set of facets because on messy data it is the most-used control on the page, and
it is off by default because a dead report is still a real report: the one time
someone needs the 2019 copy, they need to be able to find it. Those rows are
dimmed rather than removed, and brighten on hover.

### 6. Browse chips

Under the search box is a chip strip built from the data by `buildTaxonomy()`:
one chip per division with its report count, ordered largest first. Clicking
one opens it - `runBrowse()` lists every dashboard in that division, sorted by
name, with no query and so no scoring or highlighting - and a second row of
chips appears underneath with the categories inside it. Clicking a category
narrows the list further; clicking either chip again turns it off, and turning
the division off goes back home.

**Browsing only reaches the filed part of the catalogue.** Records with no
division are skipped, and the chip counts say so - on `data-sa.json` they add up
to 105 of 260, and the home screen states the remainder outright ("155 of them
filed under nothing"). That is not a defect to paper over: it is the reason
search has to work, and hiding it behind chips that imply full coverage would
misrepresent what the tree can do.

The strip stays on screen while browsing, so the taxonomy is always one click
away. It hides during a text search, which has its own filter row. While
browsing, the division filter is left out of that row - the division is already
fixed by the chip - so only the status filter renders.

A third, quieter row holds a handful of example queries. Those are plain
searches, not filters.

### 7. Starred dashboards

Any result row or starred card carries a star button. Starring writes the
dashboard's `id` into a `Set` that is mirrored to `localStorage` under
`dashboardSearch.starred` as a JSON array of ids, and the home screen shows the
starred dashboards as a grid of cards beneath the search box.

- **Ids only.** Names, links and descriptions are re-read from `data.json` on
  every load, so edits to the catalogue show up in the grid immediately, and a
  starred id that no longer exists is skipped rather than rendered stale.
- **Every copy stays in sync.** `syncStarButtons()` updates the button on the
  result row and the one on the card together, so starring from either place
  looks the same everywhere.
- **Storage can fail.** Private windows and full quotas make `localStorage`
  throw; both the read and the write are wrapped, so stars still work for the
  session and simply do not persist.

Stars live in one browser on one machine. There is no account and nothing is
sent anywhere - see [Known limitations](#known-limitations).

### 8. Suggestions

The dropdown offers matching categories, divisions and lines of business first,
then report names, capped at 8 and drawn from the top 12 hits (cached per
query). Blank facets are skipped, and a name's meta column falls back through
division, line of business and workspace, so a record with no taxonomy still
shows something that places it. Arrow keys move through it, Enter accepts the
highlighted one, Escape closes it, and a click outside dismisses it.

**Known quirk:** the dropdown reopens whenever the field regains focus with a
value in it, which after following a `?q=` link can briefly cover the toolbar.
The handler is one line at the bottom of `app.js`; it predates the engine work
and is not fixed here.

### 9. URL and keyboard

The current query is mirrored into the URL as `?q=...` via `replaceState`, so a
search is linkable and survives a refresh. Loading a URL with `?q=` runs that
search immediately. Browsing is mirrored the same way as
`?division=...&category=...`, so a division or a category is linkable too;
either parameter is ignored if it is not in the current data.

Every rewrite goes through `setUrl()`, which preserves `?src=`. Without that the
first search would drop the parameter, and a reload or a shared link would
quietly open the curated catalogue instead of the one being looked at.

| Key | Action |
|---|---|
| `/` | Focus the search field from anywhere |
| Up / Down | Move through suggestions |
| Enter | Search, accepting a highlighted suggestion |
| Escape | One step per press: close suggestions, clear the query, go home |

Typing searches live, debounced at 120 ms. Submitting keeps focus in the field
on a mouse-and-keyboard machine, so the query is easy to refine; on a touch
device it blurs instead, to get the on-screen keyboard out of the way of the
results.

---

## Deployment

The app is six static files with no build step: **`index.html`, `styles.css`,
`search.js`, `app.js`, `data.json`, `data-sa.json`**. Upload those and you are
done. Do not deploy `serve.js`, `jsconfig.json`, `tools/` or this README - they
are development aids.

`search.js` must be loaded before `app.js`; `index.html` already orders them.

The only requirement is that the files are served over HTTP(S) from the same
folder, so that `data.json` resolves next to `index.html`.

### Choosing a host

| If the catalogue is... | Host it on |
|---|---|
| Public or throwaway | GitHub Pages, Netlify, Cloudflare Pages, Vercel |
| Internal company data | Azure Static Web Apps with Entra ID sign-in, or an internal IIS/nginx site behind the VPN |

**This matters more than it looks.** A static host applies no access control:
`data.json` is downloaded in full by every visitor, including every dashboard
name, description, internal URL and every `coming_soon` entry. If any of that is
not public information, the hosting choice *is* the security control - nothing
in the page can protect it.

### Azure Static Web Apps + Entra ID

The appeal here is that authentication is configuration rather than code. Azure
sits in front of the files and refuses to serve them to anyone who has not
signed in with a company account.

1. Create a Static Web App in the Azure portal (the Free tier is enough) and
   point it at a Git repo, or push the folder with
   `npx @azure/static-web-apps-cli deploy`. Set the app location to `/` and
   leave the build command **empty** - there is nothing to build.
2. Add `staticwebapp.config.json` next to `index.html`:

```json
{
  "routes": [{ "route": "/*", "allowedRoles": ["authenticated"] }],
  "responseOverrides": { "401": { "redirect": "/.auth/login/aad", "statusCode": 302 } }
}
```

   That one rule is the security boundary: every request, `data.json` included,
   requires a signed-in user. `/.auth/login/aad` is Entra ID, so it is the normal
   corporate sign-in with MFA and conditional access, and Azure manages the
   session cookie. You write no authentication code.
3. Optionally tighten further: restrict to specific Entra groups with a custom
   role, and add security headers (including a CSP) in the same config file.

Two caveats worth raising before proposing it: the app runs on Azure's public
edge, so the data leaves the corporate network even though it is login-gated -
for genuinely sensitive material infosec may insist on the on-premises option.
And creating a Static Web App requires a subscription you are allowed to deploy
into, which usually means going through whoever owns the Azure landing zone.

### Internal IIS or nginx

Copy the four files into a folder on an existing internal web server and point a
site at it. IIS with Windows Authentication gives single sign-on for domain
machines with no configuration in the app; nginx needs a `location` block
serving the directory. The data never leaves the network and there is no cloud
subscription to negotiate. The trade-off is depending on someone else's server
and change process. If the data is internal, this is usually the shorter path to
approval; Azure is the better answer when it also has to be reachable from
outside the VPN.

### Pre-deployment checklist

- [ ] `data.json` and `data-sa.json` contain only information the audience is
      allowed to see - harvested table, column and measure names disclose more
      about the underlying data model than a report title does
- [ ] Every `live` `hyperlink` is reachable from where users will open the page
- [ ] `coming_soon` links are placeholders, or `LINK_COMING_SOON` is turned on
- [ ] Access control matches the sensitivity of the data (see above)
- [ ] Optionally, a CSP header:
      `default-src 'self'; script-src 'self'; style-src 'self'`
      (the page loads no third-party resources at all, so this is easy)

---

## Security

There is no backend, no cookies and no accounts, and the only storage is a list
of starred ids in `localStorage`, so the usual server-side attack surface does
not exist. The one real risk is rendering
`data.json` into HTML, which is handled as follows:

- **Everything interpolated into HTML is escaped** by `escapeHtml()`, including
  values that end up inside attributes.
- **Links are scheme-checked.** `safeUrl()` only emits `http:` and `https:`
  URLs. Escaping an `href` does *not* stop a `javascript:` URL from running on
  click, so a record with a hostile link renders as plain text with no anchor.
- **Query terms are regex-escaped** before being compiled into the highlighting
  pattern.
- **External links** carry `target="_blank" rel="noopener noreferrer"`.
- **Stored stars are ids, never markup.** They are read back as a JSON array,
  filtered to strings, and only ever used to look up records that came from
  the catalogue, so tampering with the stored value cannot inject anything.
- **Harvested metadata is escaped like everything else.** `whyLine()` prints
  field names and matched words - table, column, measure and owner values that
  came straight off the wire - and every one of them goes through
  `escapeHtml()`. The only unescaped strings in that function are the literal
  entities it writes itself.
- **`?src=` is pattern-restricted**, not just trusted. It is matched against
  `/^[\w-]+\.json$/`, so it can only ever name a JSON file sitting next to
  `index.html` - no `../`, no absolute path, no other origin.
- **The one pill that takes HTML is fed a literal.** `pill()` escapes its label;
  the quality toggle passes a plain string with a real `&` in it, which escapes
  correctly. Division names, which come from the data, are escaped by the same
  call.
- **No third-party requests.** Fonts are the system stack; no CDN, no analytics,
  nothing phones home. Worth keeping that way.

This was tested by rendering a deliberately hostile record - script tags, an
`onerror` image, a `javascript:` link, an attribute-breakout status value - and
confirming it produced no script tags, no images, no inline handlers and no
anchor.

The one thing the page cannot defend against is the host serving the catalogue
to people who should not see it - and `data-sa.json` raises those stakes, because
harvested table, column and measure names describe the shape of the underlying
data model, not just the existence of a report. See [Deployment](#deployment).

---

## Types without TypeScript

`app.js` starts with `// @ts-check` and describes its data with JSDoc:

```js
/**
 * @typedef {Object} Dashboard
 * @property {string} id
 * @property {'live'|'coming_soon'} status
 * ...
 */
```

VS Code checks the file live from this - autocomplete on `item.`, an error if
you write `item.url` instead of `item.hyperlink` - with no build step and no
dependencies. `jsconfig.json` turns on `checkJs` and `strict` for `app.js` and `search.js`
(excluding `serve.js` and `tools/`, which are Node rather than browser code).

To check from the terminal:

```
npx -y -p typescript@5 tsc --project jsconfig.json
```

Silence means it passed. It currently passes clean under `strict`.

**Why not actual TypeScript?** It would add a compile step, a `package.json`,
`node_modules` and a decision about whether compiled output is committed - which
turns deployment from "upload six files" into a build pipeline, for a two-file
app with one author. The JSDoc approach gets most of the type safety at none of
that cost.

Two of the original reasons to switch have now half arrived, so it is worth
restating the trigger: the code has split into two files, and one of them has
real logic worth testing. That is still not enough on its own. Switch when other
people start working on it, when the catalogue starts coming from an API rather
than a static file, or when it lands in a repo that already has a TypeScript
toolchain - a house standard beats any of this reasoning.

---

## Design notes

The home screen and the results view are deliberately different in density, and
a few things are shared so they still read as one product:

- **One accent colour**, defined once per theme. It appears on the home screen
  (wordmark, Search button, chip hover) and in the results (division
  breadcrumbs, the active filter, hovered titles, the suggestion dropdown).
- **One search component.** The same pill-shaped field is used in both states;
  docking into the top bar just drops its shadow and its Search button and
  shrinks it from 54px to 42px.
- **One column.** Both states use a 680px column, so the docked search field
  lines up exactly with the result text beneath it - chips and the starred grid
  included.
- **One chip.** Divisions, categories and the example queries are the same
  component at three weights: outlined, filled-soft and ghost. The open division
  is the only solid accent object on the screen.
- **Results stay quiet:** hairline rows rather than cards, plain-text filters,
  a small status dot, and matches marked with weight and a faint tint rather
  than a highlighter.
- **The meta line carries the judgement, not the layout.** Freshness, opens and
  owner all sit in the same 11.5px muted row as the status and the id, and only
  the two colours below lift anything out of it. Nothing about a stale report is
  bigger or bolder than anything about a fresh one; it is one shade of amber or
  red and no other change.
- **Two warning colours, used sparingly.** `--warn` for over 90 days, `--bad`
  for over a year or never - defined in both palettes alongside everything else.
  Dead rows drop to 62% opacity and return to full on hover, so they recede
  without disappearing.
- **The match explanation is subordinate to the result.** Smaller than the
  description, muted, with the matched word in mono so it reads as data rather
  than prose - it is a footnote on the row, not a second title.
- **Light and dark** come from `prefers-color-scheme`; every colour is a token
  defined in both palettes.

## What is not built yet

Three things stand between this and being the search on the source-aligned
landing page. They are listed in the order they unblock each other, not in the
order they are interesting.

### The harvest step

`data-sa.json` is generated by `tools/make-sa-data.js`, which invents its
records. Everything downstream of that file is real; the file itself is not.

Replacing it means calling the Power BI REST API - or the admin scanner API,
which returns workspace, dataset, table, column and measure metadata in one
sweep - and writing the same shape out. The fields the engine wants are already
the fields the scanner returns, which is why they were chosen. `views30d` comes
from a different place (activity events, or a usage-metrics dataset), and is the
one signal that needs its own plumbing.

**This is the scalability argument, made concrete.** A catalogue that is
harvested on a schedule needs no one to file anything, which is the whole
difference from the curated set - so this is the piece to build first, and the
piece to demo.

Two things to decide when the real data arrives:

- Whether to generate the missing descriptions offline from the harvested column
  and measure names. Two thirds of records have none, and a generated sentence
  would give the ranker something to work with and the reader something to read.
  It belongs in the pipeline, not the browser: the front end stays static, which
  is what keeps deployment to "upload six files".
- Whether `VOCABULARY` should move out to its own JSON file. It is inline while
  it is small and while one person edits it. The moment a domain team wants to
  extend it without touching a `.js` file, it should move.

### The Munich Re redesign

Every colour is already a token defined once per palette in `styles.css`, so the
retheme is a contained change - the tokens, the type stack, and the wordmark.
The wordmark is the real question: "Dashboard**Search**" as a standalone brand
is unlikely to survive inside a Munich Re surface, and what replaces it depends
on whether this reads as a product or as a piece of the landing page.

This needs the brand guide or the internal design system to start. Do not guess
the values.

### The embedding

The open question is what the source-aligned landing page *is* technically - a
Power BI report page, an app, or a SharePoint page - because that decides which
of these is available:

| Route | Result |
|---|---|
| Certified Power BI custom visual | Best experience, heaviest build, needs certification |
| Hosted separately, linked from the landing page | Easiest, slightly seamed |
| SharePoint page hosting the report web part and this app | Usually the pragmatic middle |

Power BI Service report pages do not host arbitrary iframes, so "seamless"
should not be promised before that question is answered.

---

## Known limitations

- Typos are forgiven but stemming is not: "forecast" finds "Forecasting"
  by prefix, and "forcast" by spelling correction, but genuine morphology
  ("reserving" vs "reserves") only works where the vocabulary lists it.
- The vocabulary is hand-maintained. It covers the reinsurance terms in this
  catalogue and nothing else; a new line of business needs a new row.
- Rarity weighting is computed over whichever catalogue is loaded, so a term's
  value shifts as the catalogue grows. This is correct behaviour, but it means
  score numbers are not comparable between catalogues.
- Quality signals assume `lastRefresh` and `views30d` are trustworthy. Neither
  is verified, and a report that is refreshed on a schedule but abandoned by its
  users will still look healthy on the first signal.
- The whole catalogue loads up front and is scored on every keystroke. 260
  records take about 3 ms per search, so this is fine into the low thousands; at
  tens of thousands it needs an inverted index or a server.
- Sorting is by relevance only - there is no alphabetical or by-division sort.
- No pagination; every match renders at once.
- Stars are per browser and per device: they live in `localStorage`, so they do
  not follow a user to another machine, and clearing site data removes them.
  Sharing a list of favourites would need an account and a backend.
