# Dashboard Search

A single-page search over a catalogue of dashboards. Type a query, get ranked
results with the matched terms highlighted, and narrow them down by division or
status. You can also browse the catalogue by division and category from the
chips under the search box, and star the dashboards you use so they sit in a
grid on the home screen. Everything runs in the browser: there is no backend, no
build step and no dependencies.

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

## Files

| File | What it is |
|---|---|
| `index.html` | Page skeleton. Two states - home and results - switched by a class on `<body>`. |
| `styles.css` | All styling, including the light/dark palettes. No framework. |
| `app.js` | Loading, searching, ranking, rendering, browse, filters, suggestions, stars. ~780 lines. |
| `data.json` | The catalogue. The only file you edit to change what is searchable. |
| `serve.js` | Local preview server. Development only - **never deployed**. |
| `jsconfig.json` | Turns on editor type-checking for `app.js`. Editor only - **never deployed**. |
| `README.md` | This file. |

Only the first four are deployed.

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

On load, `flatten()` walks that structure and produces a flat array of records,
each one carrying its `division` and `category` alongside its own fields, plus a
`haystack` string (name + id + division + category + description, lowercased)
used for fast rejection while scoring.

`status` is either `live` or `coming_soon`; anything else renders with its raw
value as the label.

**To change what is searchable, edit `data.json` and reload.** Adding a
dashboard, a category or a whole division needs no code change - the browse
chips, the filter bar and the count on the home screen are all derived from the
data at runtime.

### 2. Ranking

`tokenize()` splits the query on non-alphanumerics. `scoreItem()` then scores
each record, and **every token must match somewhere** for the record to appear.
Per token, the best single match wins:

| Match | Points |
|---|---|
| Name is exactly the token | 100 |
| Id is exactly the token | 100 |
| Name starts with it | 60 |
| Name starts a word with it | 45 |
| Id contains it | 40 |
| Name contains it | 30 |
| Category / division word start | 26 / 22 |
| Category / division substring | 18 / 14 |
| Description word start / substring | 9 / 5 |

Two bonuses are then added: +45 if the whole query appears in the name as a
phrase (+12 if it appears anywhere in the record), and +2 for a `live`
dashboard, so a live one edges out an identically-scored `coming_soon` one.
Ties break alphabetically.

**Partial-match fallback.** If a multi-word query matches nothing, the search
runs again accepting records that match *at least one* term, and the results
line says so rather than showing an empty page. A record matching no term at all
still scores zero and never appears.

### 3. Rendering and escaping

Results are built as an HTML string and assigned once to `innerHTML`. Every
value interpolated into that string passes through `escapeHtml()`, and query
terms are regex-escaped by `escapeRe()` before `highlight()` wraps matches in
`<mark>`. Result links pass through `safeUrl()`, which only ever emits `http:`
and `https:` URLs - see [Security](#security).

### 4. The two states

`<body>` carries either `state-home` or `state-results`, and CSS keys off that.
The search field is a single element that `moveSearchBox()` physically relocates
between the hero and the top bar, so it keeps its value, focus and event
listeners across the transition rather than being two separate fields.

### 5. Filters

The division and status filters are built from the current result set, not from
the whole catalogue, so counts always add up to what you are looking at. Toggling
one re-renders the list without re-running the search. Filters that no longer
apply are dropped automatically when a new query narrows things.

### 6. Browse chips

Under the search box is a chip strip built from the data by `buildTaxonomy()`:
one chip per division with its dashboard count, ordered largest first. Clicking
one opens it - `runBrowse()` lists every dashboard in that division, sorted by
name, with no query and so no scoring or highlighting - and a second row of
chips appears underneath with the categories inside it. Clicking a category
narrows the list further; clicking either chip again turns it off, and turning
the division off goes back home.

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

The dropdown offers matching categories and divisions first, then dashboard
names, capped at 8 and drawn from the top 12 hits (cached per query). Arrow keys
move through it, Enter accepts the highlighted one, Escape closes it, and a
click outside dismisses it.

### 9. URL and keyboard

The current query is mirrored into the URL as `?q=...` via `replaceState`, so a
search is linkable and survives a refresh. Loading a URL with `?q=` runs that
search immediately. Browsing is mirrored the same way as
`?division=...&category=...`, so a division or a category is linkable too;
either parameter is ignored if it is not in the current data.

| Key | Action |
|---|---|
| `/` | Focus the search field from anywhere |
| Up / Down | Move through suggestions |
| Enter | Search, accepting a highlighted suggestion |
| Escape | Close suggestions, then clear the query or leave a browse view |

Typing searches live, debounced at 120 ms.

---

## Deployment

The app is four static files with no build step: **`index.html`, `styles.css`,
`app.js`, `data.json`**. Upload those and you are done. Do not deploy
`serve.js`, `jsconfig.json` or this README - they are development aids.

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

- [ ] `data.json` contains only information the audience is allowed to see
- [ ] Every `hyperlink` is reachable from where users will open the page
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
  `data.json`, so tampering with the stored value cannot inject anything.
- **No third-party requests.** Fonts are the system stack; no CDN, no analytics,
  nothing phones home. Worth keeping that way.

This was tested by rendering a deliberately hostile record - script tags, an
`onerror` image, a `javascript:` link, an attribute-breakout status value - and
confirming it produced no script tags, no images, no inline handlers and no
anchor.

The one thing the page cannot defend against is the host serving `data.json` to
people who should not see it. See [Deployment](#deployment).

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
dependencies. `jsconfig.json` turns on `checkJs` and `strict` for `app.js`
(excluding `serve.js`, which is Node rather than browser code).

To check from the terminal:

```
npx -y -p typescript@5 tsc --project jsconfig.json
```

Silence means it passed. It currently passes clean under `strict`.

**Why not actual TypeScript?** It would add a compile step, a `package.json`,
`node_modules` and a decision about whether compiled output is committed - which
turns deployment from "upload four files" into a build pipeline, for a
single-file app with one author and one data shape. The JSDoc approach gets most
of the type safety at none of that cost. Switch to real TypeScript when the code
splits into modules, when other people start working on it, when the data starts
coming from an API rather than a static file, or when it lands in a repo that
already has a TypeScript toolchain - a house standard beats any of this
reasoning.

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
- **Light and dark** come from `prefers-color-scheme`; every colour is a token
  defined in both palettes.

## Known limitations

- Matching is substring-based, so it does not handle typos or stemming -
  "forecast" finds "Forecasting", but "forcast" finds nothing.
- The whole catalogue loads up front. Fine for hundreds of records; if it ever
  reaches tens of thousands, this needs a real index or a server.
- Sorting is by relevance only - there is no alphabetical or by-division sort.
- No pagination; every match renders at once.
- Stars are per browser and per device: they live in `localStorage`, so they do
  not follow a user to another machine, and clearing site data removes them.
  Sharing a list of favourites would need an account and a backend.
