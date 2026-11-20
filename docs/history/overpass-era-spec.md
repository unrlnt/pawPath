# Overpass-era architecture (superseded 2026-11-20)

Verbatim copy of CLAUDE.md §2–§5 and §8 as they stood before the switch to
build-time vector tiles. Kept for the lessons (CORS shape, 406, retry policy).
Not current. See CLAUDE.md §3 for the live architecture.

## 2. Non-negotiable constraints

1. **€0 running cost.** Cloudflare free tier only. No paid Workers plan, no paid
   database, no paid tile provider. Any design that requires a paid tier is wrong.
2. **No login, no registration, no accounts.** All user state in `localStorage`.
3. **Equal quality worldwide.** No feature may depend on a Netherlands-only data
   source unless there is a globally available fallback that is used by default.
   Country-specific sources are enrichment only.
4. **Minimal server load.** The owner's VPS must not be in the request path. It
   runs only an n8n cron/webhook for water-warning scraping (Phase 6).
5. **Map is the landing view.** Not a list, not a dashboard. The map renders
   immediately and fills in progressively.
6. **Show only what exists.** If there is no record for something, nothing is
   drawn. No "unknown" pins, no empty states per feature. The one exception is
   water (see §6).

## 3. Architecture decision

**Static frontend, client-side data fetching, no backend until Phase 6.**

The browser queries Overpass and Open-Meteo directly. Nothing is proxied.

Rationale:
- Cloudflare free Workers allow 10 ms CPU per invocation. Parsing multi-MB
  Overpass responses exceeds that by orders of magnitude. Server-side extraction
  would require the paid plan (ruled out) or the VPS (ruled out).
- Overpass rate limits are per client IP (~2 concurrent slots). Client-side
  queries spread load across all users' IPs instead of funnelling everything
  through one server IP.
- No seeding step means no NL-vs-elsewhere quality gap.

**Critical: the data layer must be swappable.** All remote fetching goes through
`src/data/sources/` behind a single interface. A future `WorkerTileSource` must
be droppable in place of `OverpassTileSource` without touching UI code. This is
the migration path if traffic ever justifies a shared server-side cache.

```
Browser (Cloudflare Pages, static)
  ├── MapLibre GL JS            viewport → tile grid
  ├── OverpassTileSource        OSM features, CORS, direct
  ├── OpenMeteoSource           conditions, direct
  ├── IndexedDB                 tile cache, long TTL
  └── localStorage              filter prefs, favourites
        │
        └── (Phase 6 only) Cloudflare Worker + D1 → water warnings
```

### Known trade-offs of the client-side approach

Accepted deliberately; do not "fix" these without discussion:
- No shared cache — every user pays the cold cost for the same area.
- Mobile data usage of a few MB per new area.
- JSON parsing cost on low-end phones.
- Overpass availability is outside our control (mitigated by fallback instances).
- No server-side enrichment or cross-user analytics.

## 4. Stack

- Vite + React 18 + TypeScript
- MapLibre GL JS (**not** Mapbox GL — licensing)
- Tailwind CSS
- `idb-keyval` for IndexedDB
- Deployed to Cloudflare Pages (static build output)
- Phase 6 only: Cloudflare Worker (Hono) + D1

No server framework, no SSR, no Next.js. This is a static SPA.

### Tiles

Base map tiles must come from a provider whose free tier permits public apps.
**Never point at OpenStreetMap's standard tile servers** (`tile.openstreetmap.org`) —
their usage policy forbids it.

**Decided in Phase 2: MapTiler free tier**, key in `VITE_MAPTILER_KEY`. The
allowance is finite (free-tier map loads per month), so watch it before any
public posting — see §12. Switching provider is an env-var change, not a code
change: components read `MAP_STYLE_URL` and `MAP_ATTRIBUTION` from `config.ts`
and know nothing about MapTiler. `VITE_MAP_STYLE_URL` overrides everything, so
Stadia or Protomaps drop in directly. With no key configured the app says so
plainly rather than falling back to OSM's tile servers.

## 5. Data sources

| Data | Source | Coverage | Notes |
|---|---|---|---|
| OSM features | Overpass API | Global | Primary source for all map symbols |
| Weather, UV, radiation, rain | Open-Meteo Forecast | Global | No key required |
| Air quality | Open-Meteo Air Quality | Global | European AQI + PM2.5/PM10/O₃ |
| Bathing water locations | EEA WISE | EU | Phase 6 |
| Live algae warnings | zwemwater.nl (NL), Länder portals (DE) | Fragmented | Phase 6, via n8n |
| Place search | Nominatim (public) | Global | Added in Phase 2, never recorded here. Its policy forbids client-side autocomplete — see §12 audit |

### Overpass instances and retry policy

Instances live in `OVERPASS_INSTANCE_CONFIGS` (`src/config.ts`), tried in this
order. Expand the list from the
[OSM wiki instance table](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances);
entries marked `candidate` are declared but excluded from rotation until the
connectivity tester confirms planet coverage and CORS.

1. `https://overpass.kumi.systems/api/interpreter` — primary; its wiki entry
   permits any purpose, and it has the largest public capacity.
2. `https://overpass-api.de/api/interpreter` — the reference instance, at
   **normal priority**. It was once demoted for "filtering programmatic
   requests"; that was wrong (see "HTTP 406" below).
3. `https://overpass.private.coffee/api/interpreter`

**Retry before rotating.** Rotating on the first error was the Phase 1/2 bug:
it burned every instance in seconds and gave up in 10–18 s having never really
retried. The policy now is:

- Retry 429, 500, 502, 503, 504, timeouts and pre-HTTP `fetch` rejections.
- At least 3 attempts on the *same* instance before rotating; 5 attempts total.
- Exponential backoff **with jitter** (~1 s, 2 s, 4 s, 8 s, capped at 30 s).
  Jitter is required: without it every client retries in lockstep and rebuilds
  the burst that caused the failure.
- Never retry 400 (our own bad QL) or 406 (a policy refusal).
- Per-instance circuit breaker: 3 consecutive failures parks an instance for
  5 minutes, after which it is probed again. One success resets it.
- **On 429, do not guess.** Overpass sends no `Retry-After` and its 429 body is
  HTML. Fetch `/api/status` — plain text — and wait until it says a slot frees.

### Request shape — CORS

Every Overpass request MUST stay a "simple" CORS request, meaning no preflight:

- **POST**, body `data=<urlencoded QL>`;
- `Content-Type: application/x-www-form-urlencoded` — one of only three
  safelisted values. **Never `application/json`**: that turns every request into
  a preflighted one, and a failed `OPTIONS` preflight surfaces as a bare
  `TypeError` with no status and no response, indistinguishable from the
  servers being down. (Run 2's `TypeError`s were *not* this — the shape was
  already correct then. And the reverse also holds: on 2026-11-20 a connection
  reset by a network proxy showed up in Chrome as "blocked by CORS policy". A
  CORS message in the console does not prove a CORS problem.)
- `Accept: application/json, */*;q=0.8` (safelisted, see above);
- no other headers, and never `User-Agent` — browsers forbid it.

`src/data/sources/overpassRequestShape.test.ts` pins all of this, including an
assertion that no header outside the CORS safelist is ever sent.

### Batching

One Overpass query covers a whole viewport's uncached tiles, per output group —
not one request per tile. Nine tiles × two groups was up to eighteen serialised
requests for a single pan. The tiles' bounding boxes are unioned into one
rectangle; the response is split back into per-`(tile, layer)` cache entries
client-side, so cache reuse on pan is exactly as it was.

**Do not widen the area to "save requests".** A 20 km radius is ~1,250 km²,
which at Run 1's measured densities (surface alone: 700–780 features/km²) is
tens of megabytes: it blows the server-side timeout and fails *after* consuming
a slot, which is worse for the instance than not asking. `MAX_TILES_PER_VIEWPORT`
now bounds query **size**, not request **count** — that is why it stays.

**Usage policy compliance:**

- **Never run requests in parallel** from one client. Slots are shared across an
  IP block, so parallelism crowds out other users. `OVERPASS_MAX_CONCURRENCY`
  is pinned to 1; raising it is a violation, not a tuning knob.
- **`User-Agent` cannot be set from a browser** — it is a forbidden header. The
  app identifies itself in the query comment via `APP_CONTACT_URL`, and the
  browser sends `Origin` and `Referer` automatically, which tell an operator the
  app's domain.
- **Session request budget** (`OVERPASS_SESSION_REQUEST_BUDGET`,
  `OVERPASS_SESSION_BYTE_BUDGET`) sits well inside the policy's documented
  safety margin of ~10,000 requests / ~1 GB per user per day. Requests stop when
  spent rather than degrading quietly; usage is shown in the dev inspector.
- Keep queries as narrow as the active filters allow.

### HTTP 406 — resolved, and it was never bot filtering

**In one line:** the 406 was `Accept`-header content negotiation. A browser
address bar sends `Accept: text/html,…` and gets 406; `fetch()` and curl send a
wildcard `Accept` and get 200. Verified from a real browser. Every Overpass
request therefore sends an explicit `Accept: application/json, */*;q=0.8`
(`OVERPASS_ACCEPT_HEADER`), and `overpass-api.de` is at normal priority.

**The earlier conclusion in this file — that instances filter "programmatic
requests" — was WRONG.** It came from a Node experiment whose `User-Agent`
happened to be refused, and it cost `overpass-api.de` an unjustified demotion.
Do not revive it.

`fetch()` to `overpass-api.de` from a browser on localhost returns **200 with
valid JSON**. 406 appears when a request advertises an `Accept` the server
cannot satisfy — which is what a browser **address bar** sends
(`Accept: text/html,…`). Overpass returns JSON and refuses that negotiation.
`fetch` and curl both default to a wildcard `Accept` and get 200.

Measured against `overpass-api.de`, 2026-09-07, same query, same endpoint:

| Client | Accept | Result |
|---|---|---|
| browser `fetch`, localhost | wildcard | **200** |
| browser address bar | `text/html,…` | **406** |
| curl, default UA | `application/json` | 200 |
| curl, default UA | `text/html,…` | 200 |
| curl, browser UA string | any of the above | 406 |

The last two rows are why `OVERPASS_ACCEPT_HEADER` is
`application/json, */*;q=0.8` rather than a bare `application/json`: the
discriminator is **not the same everywhere**. From a browser it is `Accept`;
from the development machine it is the `User-Agent`, and `Accept` changes
nothing. `.de` balances across backends whose configuration differs, so both
observations are real and neither is the whole rule. The wildcard fallback makes
the request robust to either, and to an instance that labels its JSON
`application/osm3s+json`.

Consequences, all implemented:
- `overpass-api.de` is back at **normal priority**.
- Every Overpass request sends an explicit `Accept` (CORS-safelisted, so no
  preflight).
- A 406 is **still never retried**, but it is now classified as a **client
  bug**: it means our own request shape is wrong. It is logged with
  `console.error`, fails fast without rotating — every instance would answer
  identically — and does **not** mark the instance unhealthy. There is no
  "instance refuses us" state any more.


## 8. Query strategy

- Snap the viewport to a fixed **~2 km tile grid**; query whole tiles, never raw
  bounding boxes.
- **Cache one IndexedDB entry per `(tileId, layerKey)`, never per layer set.**
  The key is `v{schemaVersion}|{tileId}|{layerKey}` (`tileCacheKey()` in
  `src/data/sources/overpassTileSource.ts`). A layer set describes the filter
  panel at one moment, not the data: keying by it means every toggle produces a
  key never seen before, missing tiles already held and storing the same
  features repeatedly. The schema version invalidates old entries when
  normalisation, a level derivation or a layer's selectors change.
  - A read partitions the request into cached layers and missing ones, and
    fetches only what is missing.
  - A response covering several layers is **split on write**, one entry per
    layer, including layers that produced no features — an empty array is a
    real answer, and omitting it makes empty tiles re-query forever.
- **Minimum zoom z13** for amenity layers. Below that, show a "zoom in" hint
  rather than querying. **Surface has its own floor of z16** (`LAYER_MIN_ZOOM`):
  at 700–780 features/km² it is an order of magnitude denser than every other
  layer and must not load at the same zoom as benches.
- **Cap total wall time per user action**, not per request
  (`USER_ACTION_LATENCY_BUDGET_MS`, 50 s). Past the cap the UI stops blocking
  and shows what has arrived; the retries continue in the **background** and
  paint tiles as they land. Cancelling at the cap would just be the old
  give-up-early bug again; blocking past it is indistinguishable from a crash
  on a phone.
- **Timeouts are split by output group** (`OVERPASS_TIMEOUT_MS`): amenity
  queries answer in 1–3 s when healthy, so they get 12 s; polygon queries
  legitimately take tens of seconds and get 45 s. Sharing one budget means
  every failed amenity query costs 45 s of the user's attention.
- **Debounce ~500 ms** after the map settles before issuing queries.
- **Query only enabled filters.** The user picks active layers; disabled layers
  are never requested. Default on first visit: a lightweight subset (shade,
  off-leash, water) — not everything.
- **Progressive render.** Amenity nodes first (fast), area polygons after (slow).
- Cache TTL: 30 days for OSM tiles, 1 hour for conditions.


### Phase 2 — Map shell
MapLibre map, geolocation, tile provider decision, tile grid, IndexedDB cache
layer, zoom gating, debounce, attribution footer, disclaimer.

**Proxy-ready seam (built as a stub; the proxy is NOT built).**
`ProxyTileSource` implements `TileSource`, is switched by
`VITE_OVERPASS_PROXY_ENABLED`, and defaults off. It forwards the same generated
Overpass QL to a configurable endpoint and parses the response client-side —
there is no server-side extraction, because the Cloudflare free tier's 10 ms CPU
limit rules it out (§3).

A Cloudflare Worker pass-through proxy is the **preferred pre-launch
configuration**, for two reasons a browser cannot achieve on its own:
- it can set a proper `User-Agent`, which is how instance operators identify and
  contact a client — a browser forbids the header entirely;
- an edge cache collapses duplicate requests, so far less traffic reaches
  Overpass than every client querying directly.

**Open question, unresolved:** a proxy concentrates all users behind a small set
of Cloudflare IPs, and the usage policy's language on cloud workers disfavours
exactly that. Resolve by asking the instance operator before launch.
Client-direct remains the default and the fallback.

### Phase 3 — Conditions engine
Open-Meteo integration, paw temperature model, walk window, rain window, air
quality, UV, seasonal rules. Collapsible conditions card. Pure functions + tests.

### Phase 4 — Symbol layers and filters
All amenity layers, filter panel with persistence, level-encoded symbols,
popups, progressive rendering.

### Phase 5 — Area layers
Shade polygons, surface rendering with live paw-heat recolouring, off-leash areas.

### Phase 6 — Water warnings
Cloudflare Worker + D1, EEA bathing water locations, n8n webhook trigger for
on-demand refresh, three-state water rendering.

### Phase 7 — Public launch
Ad slot component, rate limiting, error and offline states, performance pass,
share links, favourites, Cloudflare Pages deployment.

**Launch checklist — all blocking:**

1. **Set `APP_CONTACT_URL`** in `src/config.ts` to a real, reachable public URL.
   Until it is, every Overpass query tells instance operators the contact is
   unset — honest, but it leaves them no way to reach us before blocking us.
2. **Email the primary instance operator before any public posting.** Describe
   the app, the expected request volume per user and in total, the caching and
   retry policy, and explicitly note the `User-Agent` limitation: browsers
   forbid the header, so the app identifies itself in the query comment and via
   `Origin`/`Referer`. Ask whether they would prefer a proxied deployment (see
   Phase 2's proxy seam) or client-direct traffic. Their answer decides the
   open question above; record it here.
3. **Check the MapTiler free-tier allowance** against expected traffic (§4).
4. **Confirm the instance order** in `OVERPASS_INSTANCE_CONFIGS` with the
   connectivity tester from a real browser (§5).

