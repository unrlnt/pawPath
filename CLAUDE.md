# CLAUDE.md — Dog Walk Map

Working name: **PawPath** (change freely; used as package name and page title).

This file is the persistent context for the project. Read it fully at the start of
every session. Update the "Status" section at the end of each phase.

---

## 1. What this is

A public, no-login web app that shows a map of the user's surroundings with
information relevant to walking a dog: shade, off-leash areas, water warnings,
benches, waste bins, poop bag dispensers, drinking water, path surface, plus
live conditions (UV, air quality, paw-burn temperature, rain and walk windows,
seasonal hazards).

Primary users: the owner and his partner (Netherlands, frequently Germany).
Secondary: anyone, anywhere — the app will be posted publicly and must not
degrade outside the Netherlands.

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

### Overpass instances and retry policy

Instances live in `OVERPASS_INSTANCE_CONFIGS` (`src/config.ts`), tried in this
order. Expand the list from the
[OSM wiki instance table](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances);
entries marked `candidate` are declared but excluded from rotation until the
connectivity tester confirms planet coverage and CORS.

1. `https://overpass.kumi.systems/api/interpreter` — primary; its wiki entry
   permits any purpose, and it has the largest public capacity.
2. `https://overpass.private.coffee/api/interpreter`
3. `https://overpass-api.de/api/interpreter` — **last**, see below.

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
  `TypeError` with no status and no response. That is exactly the "pre-HTTP
  fetch rejection on all three instances at once" from Run 2, and it is
  indistinguishable from the servers being down.
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

## 6. Layers and level indicators

Every layer is a toggle. **Symbols are not binary — most encode a level.** The
level must be visible at a glance through colour and/or icon variant, with the
exact value in the popup.

| Layer | OSM tags | Level encoding |
|---|---|---|
| Shade | `natural=wood`, `landuse=forest`, `natural=tree_row`, `natural=scrub` | Polygon opacity by canopy type: dense forest > scrub > tree row |
| Off-leash | `dog=unleashed`, `dog=designated`, `leisure=dog_park`, `dog=leashed`, `dog=no`, `dog=yes` | Green = off-leash (`unleashed`/`designated`), green + fence icon = `dog_park`, amber = leashed required, red = dogs prohibited, **neutral grey = `dog=yes`** (permitted, leash status unstated — never green, off by default) |
| Surface | `surface=*` on ways whose `highway=*` is in `WALKABLE_HIGHWAY_TYPES` | Colour ramp by paw-heat risk: asphalt/concrete (high) → gravel/compacted (mid) → grass/dirt/sand (low). Recoloured live by current paw temperature |
| Water | see below | Three-state, see below |
| Benches | `amenity=bench` | Flat |
| Waste bins | `amenity=waste_basket` (+ `waste=dog_excrement`), `vending=excrement_bags` (any element, no `amenity` required), `amenity~dog_waste.*\|dog_excrement` | Three levels with distinct symbols: general bin, dog bin, bag dispenser |
| Drinking water | `amenity=drinking_water`, `amenity=water_point` | Flat; note that NL coverage is sparse |
| Seasonal | Derived | Severity ramp: low / moderate / high |
| You | Geolocation | — |

### Off-leash: `dog=yes` is not off-leash

`dog=yes` means dogs are permitted. It says **nothing** about leashes: the OSM
default is that local leash law applies, and in NL/DE that means leashed.
Rendering it as off-leash would tell someone their dog may run free where it
legally may not — the worst failure this app can produce. It therefore has its
own level (`allowed_leash_unknown`), renders neutrally, is never green, and is
off by default (`DEFAULT_DISABLED_LEVELS`). Do not "simplify" this away.

Note also that `dog=off_leash` **is not a valid OSM value** and must not be
queried — it was in Run 1, which is why that row read 0 everywhere.

Expect this layer to be sparse regardless: `dog=unleashed` had roughly 200 uses
worldwide as of 2020, and in the Netherlands off-leash areas are municipal data
largely absent from OSM (see Phase 8). Sparse is a finding, not a bug.

### Water: three states, deliberately

- **Red — active warning.** Official warning published today for this location.
- **White/grey — monitored, no record.** An official bathing location with no
  current warning. This is **not** a safety endorsement and the popup must say so.
- **Nothing drawn.** Unmonitored water. Most ditches, ponds and canals fall here.

Never render a green "safe" state for water. Only official bathing locations are
monitored anywhere; the water a dog actually enters usually is not.

## 7. Conditions engine

A collapsible card floating over the map. Collapsed: one line
(`Good to walk · UV 4 · paw 38 °C`). Expanded: full breakdown.

### Paw surface temperature model

```
T_surface ≈ T_air + k_surface × (shortwave_radiation / 1000) × wind_factor × shade_factor

k_asphalt = 28   k_concrete = 20   k_sand = 18   k_gravel = 14   k_grass = 8
wind_factor  = 1 / (1 + 0.06 × wind_speed_kmh)
shade_factor = 1 − 0.7 × canopy_fraction
```

Thresholds: `< 45 °C` fine · `45–52 °C` caution · `> 52 °C` danger (contact burns
within about a minute). Present as a range, never a single false-precision value.
Label clearly as an estimate.

### Walk window

Compute hour-by-hour for the next 24 h from UV, paw temperature and precipitation
probability; surface the next contiguous block scoring "good". Use Open-Meteo
`minutely_15` precipitation for the short-range rain window where available.

### Seasonal warnings

Date-and-temperature rules, no external data:
- Grass seeds (*grasaren*): roughly June–August
- Ticks: temperature above ~7 °C for several consecutive days, peak spring/autumn
- Oak processionary caterpillar: roughly April–July, NL/DE/BE
- Breeding-season leash obligation: 1 March – 15 July (NL nature areas)

All of these are advisory. Word them as such.

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

## 9. Monetisation

A single unobtrusive ad slot is included from Phase 7. Build it as a component
with a feature flag so it can be enabled, swapped or removed without touching
layout code. Reserve the space in the layout so enabling it causes no shift.

Caveats to keep in mind, recorded so they are not rediscovered later:
- Overpass public instances are volunteer-funded infrastructure. Heavy
  ad-monetised traffic against them is poor form and risks being blocked. If the
  app becomes popular, move to a self-hosted or paid Overpass tier — or to the
  `WorkerTileSource` path — before scaling ad revenue.
- Ad networks in the EU require a consent banner, which conflicts with the
  "dead simple, no friction" goal. Prefer a non-tracking ad provider that does
  not require consent, or a plain donation link.
- OSM data is ODbL: commercial use is fine, **attribution is mandatory**.

## 10. Conventions

- TypeScript strict mode. No `any` in committed code.
- All remote calls behind `src/data/sources/`. UI never fetches directly.
- All tunables (thresholds, tile size, TTLs, zoom levels, `k` values) in
  `src/config.ts`. No magic numbers in components.
- Pure functions in `src/lib/` for anything computable (paw model, scoring,
  seasonal rules) so they are unit-testable without a browser.
- Mobile-first. The primary use case is one-handed, outdoors, in sunlight —
  favour high contrast and large tap targets.
- Attribution ("© OpenStreetMap contributors", tile provider, Open-Meteo) is
  always visible on the map. This is a licence requirement, not a nicety.
- A visible disclaimer: guidance only, not a safety guarantee.

---

## 11. Phases

Each phase is one Claude Code session. Do not start the next phase in the same
session. At the end of a phase, update §12 Status.

### Phase 1 — Scaffold and Overpass reconnaissance
Project setup, data-source abstraction, and a `/recon` page that runs Overpass
queries for a given coordinate and reports feature counts per tag. Purpose:
verify empirically that OSM coverage is good enough per layer in the
Netherlands, Germany and one other country before building UI on top of it.

**Reaching the recon page.** There is no router, but the page is
URL-addressable and needs no code change to open. Run `npm run dev`, then:

```
http://localhost:5173/recon      # path form, via Vite's SPA fallback
http://localhost:5173/#/recon    # hash form, equivalent; works on any host
```

The home page also links to it in dev builds. It is gated on
`import.meta.env.DEV`, so in a production build both URLs render a
"not available" notice instead.

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

### Phase 8 — Regional enrichment (post-launch)
Official municipal/national sources added **on top of** OSM via build-time
static GeoJSON. OSM remains the default and only source everywhere until then.

The motivating gap: Dutch off-leash areas (*losloopgebieden*) are municipal open
data and largely absent from OSM, so `dog=*` coverage is thin exactly where the
primary users walk. Enrichment appends to a layer rather than replacing it.

Constraints that keep this compatible with §2:
- **Additive only.** A region with no official source shows OSM data and is not
  degraded. No feature may depend on a regional source being present.
- **Build-time static files**, served from Pages alongside the bundle. No
  runtime fetching of third-party portals, no server in the request path.
- **Attribution per source.** Each provider registers its licence string in
  `SOURCE_ATTRIBUTION`, and every source present in the rendered features is
  credited.
- The seam is already in place: `Feature.source` and `SOURCE_ATTRIBUTION` in
  `src/data/sources/tileSource.ts`. That is a type-level seam only — there is
  deliberately **no** source registry, discovery script or per-region fetching
  until this phase.

---

## 12. Status

- [x] Phase 1 — Scaffold and recon *(complete; recon runs still to be executed
      in a browser — see "Recon findings")*
- [x] Phase 1.6 — Post-Run-1 selector and politeness corrections
- [x] Phase 2 — Map shell *(complete, including the 2.5 corrections: 406
      resolved, request shape pinned, batched fetching, latency budget)*
- [ ] Phase 3 — Conditions engine
- [ ] Phase 4 — Symbol layers and filters
- [ ] Phase 5 — Area layers
- [ ] Phase 6 — Water warnings
- [ ] Phase 7 — Public launch
- [ ] Phase 8 — Regional enrichment (post-launch)

### Phase 2 — what still needs your eyes

Everything is built, typechecked and unit tested. One thing can only be settled
from your browser on your network:

**Run the connectivity tester** (map page → `dev` button → "test all
instances"). From this development sandbox, `kumi.systems` and `private.coffee`
accept a TCP connection and then never respond (20 s+), while `overpass-api.de`
answers in 1.7 s — almost certainly sandbox egress filtering rather than the
instances being down. The tester tells you the truth for your network; if the
order is wrong for you, `OVERPASS_INSTANCE_CONFIGS` is one edit.

There is no MapTiler key in the repo, so the map currently renders a "no basemap
configured" notice. Copy `.env.example` to `.env.local`, add a free key, and
restart.

### Decisions log

**Phase 2.5 — corrections after the browser test**

- **The 406 was never bot filtering, and the previous entry here was wrong.**
  See §5 for the measured table. `overpass-api.de` is back at normal priority,
  every request now carries an explicit `Accept`, and the whole
  "instance refuses programmatic clients" concept — the
  `refusesProgrammaticAccess` flag, the permanent demotion, the `refused` error
  kind — is deleted rather than disabled. A 406 is now classified as a **client
  bug**: logged with `console.error`, never retried, never rotated, and not an
  instance-health signal.
- **`Accept` is `application/json, */*;q=0.8`, not a bare `application/json`.**
  Measuring before changing it turned up something neither of us predicted: from
  a browser the discriminator is `Accept`, but from this machine it is the
  `User-Agent` and `Accept` makes no difference at all — curl with `Accept:
  text/html` gets 200, curl with a browser UA gets 406 for every `Accept`. `.de`
  balances across differently-configured backends, so both are true and neither
  is the whole rule. The wildcard fallback makes the request correct under
  either, and under an instance that labels its JSON `application/osm3s+json`.
  Betting on one clean cause is what produced the last two wrong conclusions.
- **The request shape was already correct, and is now pinned.** We were sending
  POST + `application/x-www-form-urlencoded`, both CORS-safelisted, so no
  preflight — the Run 2 `TypeError`s were not a preflight failure. It is now a
  test (`overpassRequestShape.test.ts`) that asserts the method, the body
  encoding, both header values, that no non-safelisted header is ever sent, and
  that `Content-Type` is never `application/json`. The failure mode it guards
  against is silent: a preflight failure looks exactly like an outage.
- **One query per viewport per output group, not one per tile.** Up to eighteen
  serialised requests became at most two. Uncached tiles' bboxes are unioned
  into one rectangle; the response is split back into per-`(tile, layer)`
  entries by point containment, so a tile stored from a batch is identical to
  one stored alone and pan reuse is unchanged.
- **The tile cap stays, with a new job.** It used to bound request count; it now
  bounds query size. **Do not fetch a large radius in one call to save
  requests**: ~1,250 km² at measured densities is tens of megabytes, which
  exceeds the server timeout and fails *after* consuming a slot — strictly worse
  for the instance than not asking at all.
- **Latency is budgeted per user action (50 s), not per request.** Past the cap
  the UI stops blocking and renders what has arrived, while retries continue in
  the background and paint as they land. Cancelling at the cap would recreate
  the original give-up-early bug; blocking past it reads as broken on mobile.
  The background state is announced, never silent.
- **Timeouts split by group**: 12 s amenity, 45 s polygon, with the server's own
  `[timeout:N]` kept just under each so it gives up first and returns a readable
  remark instead of us aborting blind.
- **Surface gets its own zoom floor (z16).** At 700–780 features/km² it is an
  order of magnitude denser than any other layer; loading it at z13 alongside
  benches would dominate every viewport's payload and slot time.

**Phase 2 — map shell**

- **The retry policy is the fix, and rotation was the bug.** Phase 1 read its
  own failures as unreachable servers. They were not: transient errors are
  normal and clear on retry, and rotating through every instance on the first
  error meant we gave up in 10–18 s without a single genuine retry. Now: 3
  attempts per instance, 5 total, jittered exponential backoff, rotation only
  after an instance has really been tried. Verified against live instances —
  the loop retries, backs off, rotates and parks exactly as designed.
- **Jitter is mandatory, not decorative.** Every client that hit the same outage
  would otherwise retry in lockstep and rebuild the burst. Equal jitter: half
  the delay fixed, half random (`OVERPASS_BACKOFF_JITTER`).
- **429 waits are informed, not guessed.** Overpass sends no `Retry-After` and
  its 429 body is HTML, but `/api/status` is plain text and states when a slot
  frees. Parsed in `src/lib/overpassRetry.ts` (pure, tested against real body
  shapes), cached for 10 s, and clamped — a "wait 3600 s" is answered by trying
  elsewhere instead of stalling.
- **Worst-case network time is minutes** (5 attempts × timeout plus backoff)
  where it used to be 18 seconds. That is the correct trade — 18 s of failure is
  not a faster answer, it is a wrong one. *Superseded in Phase 2.5:* the UI no
  longer waits for it. A 50 s budget per user action bounds what the user sees,
  and the retries continue in the background. Every wait is still announced
  ("retrying (2/5)", "waiting for a free slot (~30s)"); a silent backoff is
  indistinguishable from a crash.
- **`TileSourceError` carries `elapsedMs`, `responseReceived` and `errorName`.**
  "Could not reach X" was the most expensive string in this project: it
  collapsed CORS, DNS, offline and timeout into one message and cost a session's
  worth of misdiagnosis. `fetch` rejects with a bare `TypeError` for all of
  them, so those three fields are the only evidence there is. Full error objects
  also go to the console.
- **The cache wraps, it does not modify.** `CachedTileSource` implements
  `TileSource` and takes one as an argument, so `OverpassTileSource` still knows
  nothing about caching and the proxy path gets the same cache for free.
  Composition is assembled once, in `src/data/sources/index.ts`.
- **A failed fetch never discards cached layers.** If two layers are requested,
  one is cached and the other fails, the cached one is still returned. Losing
  data you already hold because of an unrelated failure is strictly worse than
  partial coverage.
- **MapTiler free tier** for the basemap, behind `MAP_STYLE_URL`. The allowance
  is finite; check it before public posting (§4, launch checklist). No fallback
  to `tile.openstreetmap.org` exists anywhere in the code — their policy forbids
  apps like this, so the app says "no basemap configured" instead.
- **Antimeridian split in `tilesCovering`.** A viewport panned across ±180°
  arrives with `west > east`, which read naively is a box spanning the planet.
  Now split into two ordinary boxes; tested.
- **Viewport tiles are capped and ordered centre-outward.**
  `MAX_TILES_PER_VIEWPORT = 9`. With concurrency pinned at 1, order is the only
  lever on perceived speed, so data appears where the user is looking first;
  past the cap the UI says coverage is partial rather than firing a burst that
  would be rate limited anyway.
- **Geolocation states are named individually** — prompt, granted, denied,
  unavailable (including insecure origin), timeout, position-unavailable. Each
  needs different advice: a denial is permanent until the user changes a browser
  setting, a timeout is worth retrying. "Location unavailable" for all of them
  tells the user nothing.
- **Nominatim's 1 req/s floor is enforced in the source, not the debounce.** A
  debounce is a UX device; a rate limit belongs where it cannot be bypassed.
- **Features render as uniform dots.** Phase 2 proves the pipeline end to end;
  symbols, levels and filters are Phase 4, and pretending otherwise would hide
  which phase actually failed.

**Phase 1 — post-Run-1 corrections (applied before Phase 2 started)**

Run 1's two zero-result rows were our own selector bugs, and its 35–80 s times
and 504s were queue time from our own request burst — healthy responses came
back in 1–3 s. Fixes:

- **Off-leash selectors rebuilt around real OSM values.** `dog=off_leash` does
  not exist and was the reason that row read 0 in all four cities. Now:
  `dog=unleashed` and `dog=designated` → `off_leash`, `leisure=dog_park` →
  `off_leash_fenced`, `dog=leashed` → `leashed`, `dog=no` → `prohibited`,
  `dog=yes` → `allowed_leash_unknown`.
- **`dog=yes` is never off-leash.** It states permission, not leash status; the
  OSM default is local leash law, which in NL/DE means leashed. It renders
  neutrally, never green, and is off by default via `DEFAULT_DISABLED_LEVELS`.
  Documented in §6 and commented at `offLeashLevel` in `layers.ts`; there are
  tests asserting it specifically.
- **Off-leash is expected to be sparse.** `dog=unleashed` had ~200 uses globally
  as of 2020, and Dutch *losloopgebieden* are municipal data largely absent from
  OSM. That is what Phase 8 exists for. Thin coverage is recorded as a finding,
  never patched by widening `dog=yes`.
- **Waste selectors widened.** Requiring `amenity=vending_machine` alongside
  `vending=excrement_bags` found 1 dispenser in Leipzig and 0 in Almere;
  `vending=excrement_bags` is now queried alone on any element type, and is
  ~50× more common than `waste=dog_excrement`. Levels are now `general` /
  `dog_bin` / `bag_dispenser` so Phase 4 can symbolise dispensers separately,
  plus an `amenity~dog_waste.*|dog_excrement` catch-all for the long tail.
- **Surface restricted to `WALKABLE_HIGHWAY_TYPES`** (path, footway, track,
  pedestrian, cycleway, steps, living_street, residential, service,
  unclassified). All highway types measured 700–780 features/km² — ~2,800 ways
  per 2 km tile, not viable client-side — and a motorway's surface is irrelevant
  to a dog walk. The pattern is anchored so `path` does not also match
  `footpath`.
- **Multi-source seam added at the type level only.** `Feature.source` is
  required (`'osm'` today), ids are source-prefixed (`osm:way/123`) so two
  providers cannot collide, and `SOURCE_ATTRIBUTION` maps each source to its
  licence string. A layer may hold features from several sources; nothing may
  assume one. Deliberately **no** registry, discovery or regional fetching —
  Phase 8.
- **Levels are declared as const arrays** with their types derived, so
  `DEFAULT_DISABLED_LEVELS` can be validated against the real level list rather
  than being unchecked strings.
- **Recon is now deliberately slow.** 5 s minimum between queries, 30 s between
  presets, both in `config.ts`. A full four-preset sweep takes minutes, and that
  is faster end to end than Run 1's burst was.
- **Backoff before rotation.** On 429/504/timeout the client now retries the
  *same* instance with exponential backoff (5 s, doubling, capped at 60 s, 3
  attempts) before rotating. Immediate rotation spread our own queue across all
  three instances and multiplied the load — it made things worse, not better.
  Other retryable failures (network, 5xx) still rotate immediately.
- **Single-preset mode and a tag-distribution diagnostic** added to the recon
  page: each preset has a ▶ that surveys only that location, and
  `probeTagDistribution` tallies every value of a key (`dog=*`) in an area. The
  latter exists precisely so a value list is measured rather than assumed, which
  is the mistake that produced the `dog=off_leash` row.
- **Scope deliberately rolled back to OSM-only for launch.** Official
  municipal/national sources are real gaps — most visibly NL off-leash areas —
  but they are regional, licence-varied and would break the "equal quality
  worldwide" constraint if the app depended on them. OSM ships as the single
  source everywhere; regional data appends later through the source seam
  (Phase 8) without touching UI or query code.

**Phase 1 — corrections (applied before Phase 2 started)**

- **Cache key corrected to one entry per `(tileId, layerKey)`**, plus a schema
  version: `v{schemaVersion}|{tileId}|{layerKey}`. The original seam documented
  `tileId + layerSet`, which was wrong — toggling a filter changes the layer set
  and would miss tiles already held. `layerSetKey()` is gone, replaced by
  `tileCacheKey()`; `TILE_CACHE_SCHEMA_VERSION` is in `config.ts`. The seam
  comment now specifies the partitioned read, the split-on-write (one entry per
  layer, including layers that returned nothing), and one caveat for Phase 5:
  a centre-only entry must count as a miss for a caller needing geometry.
  Described in §8.
- **`dog=off_leash` / `dog=leashed` confirmed as first-class selectors**, not
  provisional alternatives to `leisure=dog_park`. Off-leash zones commonly exist
  inside ordinary parks, forests and beaches with no `dog_park` feature; a Dutch
  *losloopgebied* normally is exactly that. Thin `dog=*` coverage in a region is
  a coverage finding to record here, not grounds for dropping the tag. Stated in
  a comment in `layers.ts` so it is not re-litigated.
- **Recon access documented, no code change needed.** The page was already
  URL-addressable both as `/recon` and `#/recon`; the exact URLs are now in §11
  Phase 1, the README and a comment in `App.tsx`.
- **`APP_CONTACT_URL` is explicitly unset**, not a plausible-looking invention.
  The previous value (`https://github.com/unrlnt/pawpath`) was fabricated during
  scaffolding and never existed. It is now the sentinel `APP_CONTACT_URL_UNSET`,
  and `buildOverpassQL` emits `contact URL not set — see APP_CONTACT_URL in
  src/config.ts` in the query comment while it stays that way: telling instance
  operators the truth beats handing them a dead link. Setting it is a Phase 7
  launch blocker (see §11) and documented in the README.

**Phase 1**

- **Tailwind v3, not v4.** v4 moves configuration into CSS and changes the build
  plugin. Nothing here needs it, and v3 is the version most reference material
  matches. Revisit only if something concrete requires v4.
- **No router.** Two routes (`/` and `/recon`) are a string comparison in
  `App.tsx`. Add a router when Phase 7 share links need one, not before.
- **Layer identity is a `LayerKey` union, defined once in
  `src/data/sources/layers.ts`.** Query building, normalisation, level
  derivation and the recon page are all driven from that table, so adding a
  layer means adding one entry there and nothing else.
- **At most two Overpass requests per tile, not one per layer.** Layers are
  grouped by the output mode they need — `out center` for amenities (cheap),
  `out geom` for polygons (expensive). Elements are attributed back to layers
  client-side by re-evaluating the same tag conditions. This keeps the request
  count low while still giving Phase 8's progressive render a natural fast
  group and slow group.
- **`OVERPASS_MAX_CONCURRENCY = 1`.** Public instances allow ~2 slots per IP;
  using one leaves headroom and makes bursts of tile queries safe by
  construction.
- **Instance rotation is sticky.** Whichever instance last answered is tried
  first next time, so a degraded instance is not re-tried on every query.
- **Identification is via a query comment, not a header.** Browsers forbid
  setting `User-Agent`, so every generated query starts with
  `// PawPath (<contact URL>) — <context>`. `APP_CONTACT_URL` in `config.ts`
  must be set and kept current: it is the only way an instance operator can
  reach us before blocking (currently unset — see the corrections above).
  Confirmed empirically that `overpass-api.de` does police the
  `User-Agent` header (a request sent as `node` is answered with HTTP 406).
- **`surface` is queried as `highway=* + surface=*`, not bare `surface=*`.**
  Bare `surface` returns every tagged polygon in the tile and is not walkable
  data.
- **`leisure=dog_park` was added to the off-leash layer** alongside the `dog=*`
  tags in §6. The `dog=*` selectors are first-class and stay: most off-leash
  areas are ordinary parks, forests and beaches carrying a `dog=*` tag — a
  Dutch *losloopgebied* normally is exactly that — and a `dog_park`-only query
  would silently miss them. Thin `dog=*` coverage in some region is a coverage
  finding to record here, not a reason to drop the tag.
- **Water in Phase 1 is `candidate` only.** OSM alone cannot distinguish a
  monitored bathing location from any other pond, so the third state is derived
  in Phase 6 from EEA WISE and the national feeds. Nothing renders green.
- **Relations carry a centre but no geometry.** Assembling multipolygon rings
  from `out geom` members is Phase 5 work; the seam is marked in
  `overpassTileSource.ts`.
- **Tile ids embed the grid size** (`2km:<latIndex>:<lngIndex>`), so retuning
  `TILE_SIZE_KM` invalidates old cached tiles instead of silently mismatching
  them.
- **The recon page is excluded from production at the route level**
  (`import.meta.env.DEV`). It is a measurement tool that hits public Overpass on
  demand, not a product surface.

### Recon findings

**Run 1 (2026-08-16) is superseded for three layers. Do not cite it for them.**

| Layer | Run 1 status | Why |
|---|---|---|
| Off-leash | **invalid** | Queried `dog=off_leash`, which does not exist. The 0s are our bug, not missing data. `dog=yes`/`designated` were never queried at all. |
| Waste | **undercounts dispensers** | Required `amenity=vending_machine` with `vending=excrement_bags`. Dog-specific bins were not distinguished. |
| Surface | **not usable as designed** | 708–781/km² across all highway types (~2,800 per 2 km tile). Now restricted to walkable types; needs re-measuring. |
| Shade, Water, Benches, Drinking water | **valid** | Selectors unchanged. |

Timings in Run 1 are also not instance performance: the 35–80 s figures and every
504 were our own burst queued behind itself, with healthy responses at 1–3 s. Run
2 paces itself (5 s between queries, 30 s between presets) and should be read as
the timing baseline instead.

Valid Run 1 signal worth keeping:
- **Shade is strong** where mapped — Almere 36/km², Bogotá 4.1/km².
- **Benches vary hugely** — Melbourne 78/km², Almere 4.1/km².
- **Drinking water is the sharpest regional split** — Melbourne 16.3/km² vs
  Almere 0.06/km² (1 feature). NL sparsity is confirmed, as §6 predicted.
- **Water** is present everywhere measured (2.6–5.1/km²), all via
  `natural=water`; `leisure=swimming_area` and `natural=beach` returned 0 in
  every city, so they may not be worth querying.
- **Bogotá is the thin-coverage control** and behaved like one: shade present,
  everything else near zero.

Run 2 still needs running for off-leash, waste and surface, plus a `dog=*`
distribution tally per location. Open `/recon`, use the ▶ buttons one location at
a time, and paste the summary below.

---

First test:
# Overpass coverage recon — 2026-08-16

Thresholds: ≥ 1/km² = worth a toggle, ≥ 0.2/km² = sparse, below = not worth a toggle.

## Almere, NL — 52.3508, 5.2647 · r=2 km · 16.0 km² · one query per layer

| Layer | Tag | Count | Per km² | Verdict | Query ms |
|---|---|---:|---:|---|---:|
| Shade | `natural=wood` | 20 | 1.25 | worth a toggle | 42837 |
| Shade | `landuse=forest` | 537 | 33.56 | worth a toggle | 42837 |
| Shade | `natural=tree_row` | 11 | 0.69 | sparse | 42837 |
| Shade | `natural=scrub` | 11 | 0.69 | sparse | 42837 |
| **Shade** | **layer total (distinct)** | **579** | **36.19** | **worth a toggle** | 42837 |
| Off-leash | — | — | — | **exhausted**: All 3 Overpass instances failed. Last: Overpass gateway timeout (504) | 63516 |
| Surface | — | — | — | **exhausted**: All 3 Overpass instances failed. Last: Overpass gateway timeout (504) | 63109 |
| Water | — | — | — | **exhausted**: All 3 Overpass instances failed. Last: No response within 40000 ms | 73109 |
| Benches | `amenity=bench` | 65 | 4.06 | worth a toggle | 1107 |
| **Benches** | **layer total (distinct)** | **65** | **4.06** | **worth a toggle** | 1107 |
| Waste bins & bag dispensers | `amenity=waste_basket` | 1 | 0.06 | not worth a toggle | 34817 |
| Waste bins & bag dispensers | `amenity=vending_machine + vending=excrement_bags` | 0 | 0.00 | not worth a toggle | 34817 |
| **Waste bins & bag dispensers** | **layer total (distinct)** | **1** | **0.06** | **not worth a toggle** | 34817 |
| Drinking water | `amenity=drinking_water` | 1 | 0.06 | not worth a toggle | 40974 |
| Drinking water | `amenity=water_point` | 0 | 0.00 | not worth a toggle | 40974 |
| **Drinking water** | **layer total (distinct)** | **1** | **0.06** | **not worth a toggle** | 40974 |

Notes:
- **Off-leash**: dog=* and leisure=dog_park are independent sources, not alternatives. Most off-leash areas are ordinary parks, forests and beaches carrying a dog=* tag — a Dutch losloopgebied normally is exactly that — and are invisible to a dog_park query.
- **Surface**: Restricted to ways that are also highway=* — an unrestricted surface=* query returns every tagged polygon in the tile and is not walkable data.
- **Water**: OSM only supplies candidate water bodies. Monitoring status and active warnings come from EEA WISE and the national portals in Phase 6. Never render a green "safe" state from this layer alone.
- **Drinking water**: Expected to be sparse in NL — one of the layers Phase 1 is meant to judge.

## Leipzig, DE — 51.3397, 12.3731 · r=2 km · 16.0 km² · one query per layer

| Layer | Tag | Count | Per km² | Verdict | Query ms |
|---|---|---:|---:|---|---:|
| Shade | — | — | — | **exhausted**: All 3 Overpass instances failed. Last: Overpass gateway timeout (504) | 66488 |
| Off-leash | `dog=off_leash` | 0 | 0.00 | not worth a toggle | 2939 |
| Off-leash | `dog=leashed` | 18 | 1.12 | worth a toggle | 2939 |
| Off-leash | `dog=no` | 9 | 0.56 | sparse | 2939 |
| Off-leash | `leisure=dog_park` | 3 | 0.19 | not worth a toggle | 2939 |
| **Off-leash** | **layer total (distinct)** | **30** | **1.87** | **worth a toggle** | 2939 |
| Surface | `highway=* + surface=*` | 11339 | 708.69 | worth a toggle | 65762 |
| **Surface** | **layer total (distinct)** | **11339** | **708.69** | **worth a toggle** | 65762 |
| Water | `natural=water` | 81 | 5.06 | worth a toggle | 55836 |
| Water | `leisure=swimming_area` | 0 | 0.00 | not worth a toggle | 55836 |
| Water | `natural=beach` | 0 | 0.00 | not worth a toggle | 55836 |
| **Water** | **layer total (distinct)** | **81** | **5.06** | **worth a toggle** | 55836 |
| Benches | — | — | — | **exhausted**: All 3 Overpass instances failed. Last: Overpass gateway timeout (504) | 78332 |
| Waste bins & bag dispensers | `amenity=waste_basket` | 581 | 36.31 | worth a toggle | 40369 |
| Waste bins & bag dispensers | `amenity=vending_machine + vending=excrement_bags` | 1 | 0.06 | not worth a toggle | 40369 |
| **Waste bins & bag dispensers** | **layer total (distinct)** | **582** | **36.37** | **worth a toggle** | 40369 |
| Drinking water | — | — | — | **exhausted**: All 3 Overpass instances failed. Last: Could not reach https://overpass-api.de/api/interpreter | 74195 |

Notes:
- **Off-leash**: dog=* and leisure=dog_park are independent sources, not alternatives. Most off-leash areas are ordinary parks, forests and beaches carrying a dog=* tag — a Dutch losloopgebied normally is exactly that — and are invisible to a dog_park query.
- **Surface**: Restricted to ways that are also highway=* — an unrestricted surface=* query returns every tagged polygon in the tile and is not walkable data.
- **Water**: OSM only supplies candidate water bodies. Monitoring status and active warnings come from EEA WISE and the national portals in Phase 6. Never render a green "safe" state from this layer alone.
- **Drinking water**: Expected to be sparse in NL — one of the layers Phase 1 is meant to judge.

## Melbourne, AU — -37.8136, 144.9631 · r=2 km · 16.0 km² · one query per layer

| Layer | Tag | Count | Per km² | Verdict | Query ms |
|---|---|---:|---:|---|---:|
| Shade | — | — | — | **exhausted**: All 3 Overpass instances failed. Last: Could not reach https://overpass-api.de/api/interpreter | 77012 |
| Off-leash | `dog=off_leash` | 0 | 0.00 | not worth a toggle | 62824 |
| Off-leash | `dog=leashed` | 13 | 0.81 | sparse | 62824 |
| Off-leash | `dog=no` | 7 | 0.44 | sparse | 62824 |
| Off-leash | `leisure=dog_park` | 0 | 0.00 | not worth a toggle | 62824 |
| **Off-leash** | **layer total (distinct)** | **20** | **1.25** | **worth a toggle** | 62824 |
| Surface | `highway=* + surface=*` | 12497 | 781.06 | worth a toggle | 39803 |
| **Surface** | **layer total (distinct)** | **12497** | **781.06** | **worth a toggle** | 39803 |
| Water | `natural=water` | 42 | 2.63 | worth a toggle | 3179 |
| Water | `leisure=swimming_area` | 0 | 0.00 | not worth a toggle | 3179 |
| Water | `natural=beach` | 0 | 0.00 | not worth a toggle | 3179 |
| **Water** | **layer total (distinct)** | **42** | **2.63** | **worth a toggle** | 3179 |
| Benches | `amenity=bench` | 1250 | 78.13 | worth a toggle | 33529 |
| **Benches** | **layer total (distinct)** | **1250** | **78.13** | **worth a toggle** | 33529 |
| Waste bins & bag dispensers | — | — | — | **exhausted**: All 3 Overpass instances failed. Last: No response within 40000 ms | 75788 |
| Drinking water | `amenity=drinking_water` | 260 | 16.25 | worth a toggle | 1120 |
| Drinking water | `amenity=water_point` | 0 | 0.00 | not worth a toggle | 1120 |
| **Drinking water** | **layer total (distinct)** | **260** | **16.25** | **worth a toggle** | 1120 |

Notes:
- **Off-leash**: dog=* and leisure=dog_park are independent sources, not alternatives. Most off-leash areas are ordinary parks, forests and beaches carrying a dog=* tag — a Dutch losloopgebied normally is exactly that — and are invisible to a dog_park query.
- **Surface**: Restricted to ways that are also highway=* — an unrestricted surface=* query returns every tagged polygon in the tile and is not walkable data.
- **Water**: OSM only supplies candidate water bodies. Monitoring status and active warnings come from EEA WISE and the national portals in Phase 6. Never render a green "safe" state from this layer alone.
- **Drinking water**: Expected to be sparse in NL — one of the layers Phase 1 is meant to judge.

## Bogotá, CO — 4.7110, -74.0721 · r=2 km · 16.0 km² · one query per layer

| Layer | Tag | Count | Per km² | Verdict | Query ms |
|---|---|---:|---:|---|---:|
| Shade | `natural=wood` | 9 | 0.56 | sparse | 7859 |
| Shade | `landuse=forest` | 6 | 0.37 | sparse | 7859 |
| Shade | `natural=tree_row` | 46 | 2.87 | worth a toggle | 7859 |
| Shade | `natural=scrub` | 5 | 0.31 | sparse | 7859 |
| **Shade** | **layer total (distinct)** | **66** | **4.12** | **worth a toggle** | 7859 |
| Off-leash | `dog=off_leash` | 0 | 0.00 | not worth a toggle | 42504 |
| Off-leash | `dog=leashed` | 1 | 0.06 | not worth a toggle | 42504 |
| Off-leash | `dog=no` | 0 | 0.00 | not worth a toggle | 42504 |
| Off-leash | `leisure=dog_park` | 0 | 0.00 | not worth a toggle | 42504 |
| **Off-leash** | **layer total (distinct)** | **1** | **0.06** | **not worth a toggle** | 42504 |
| Surface | — | — | — | **exhausted**: All 3 Overpass instances failed. Last: Could not reach https://overpass-api.de/api/interpreter | 81076 |
| Water | — | — | — | **exhausted**: All 3 Overpass instances failed. Last: Could not reach https://overpass-api.de/api/interpreter | 72373 |
| Benches | — | — | — | **exhausted**: All 3 Overpass instances failed. Last: Could not reach https://overpass-api.de/api/interpreter | 74449 |
| Waste bins & bag dispensers | — | — | — | **exhausted**: All 3 Overpass instances failed. Last: Could not reach https://overpass-api.de/api/interpreter | 81035 |
| Drinking water | — | — | — | **exhausted**: All 3 Overpass instances failed. Last: Could not reach https://overpass-api.de/api/interpreter | 81793 |

Notes:
- **Off-leash**: dog=* and leisure=dog_park are independent sources, not alternatives. Most off-leash areas are ordinary parks, forests and beaches carrying a dog=* tag — a Dutch losloopgebied normally is exactly that — and are invisible to a dog_park query.
- **Surface**: Restricted to ways that are also highway=* — an unrestricted surface=* query returns every tagged polygon in the tile and is not walkable data.
- **Water**: OSM only supplies candidate water bodies. Monitoring status and active warnings come from EEA WISE and the national portals in Phase 6. Never render a green "safe" state from this layer alone.
- **Drinking water**: Expected to be sparse in NL — one of the layers Phase 1 is meant to judge.
