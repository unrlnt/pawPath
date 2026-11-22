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

**The product is planning today's walk, place by place** (owner, 2026-11-22):
where paths are kind to paws right now, which parks allow dogs off-leash,
where official bathing spots and warnings are, where to rest, where to find
bag dispensers and bins — and eventually a planned route through them. Area
summaries or per-city statistics have no value to a user; the coverage-stats
script is a developer tool only.

Primary users: the owner and his partner (Netherlands, frequently Germany).
Secondary: anyone, anywhere — the app will be posted publicly and must not
degrade outside the Netherlands.

## 2. Non-negotiable constraints

1. **No marginal running cost.** The app runs on the owner's existing server
   with Cloudflare's free proxy in front. No paid tiers, no paid tile or data
   provider, no per-request compute that grows with traffic. Any design that
   needs a paid plan to serve more users is wrong.
2. **No login, no registration, no accounts.** All user state in `localStorage`.
3. **Equal quality worldwide.** No feature may depend on a Netherlands-only data
   source unless there is a globally available fallback that is used by default.
   Country-specific sources are enrichment only. The data tiles are built from
   the whole planet, not a regional extract.
4. **The server serves static files only.** Nothing runs per request. Allowed
   on the server: the scheduled tile build (which also refreshes the official
   bathing-site data) and a static file server. No n8n (owner, 2026-11-22). A dynamic endpoint may be added only if it is
   cacheable at the edge and has been discussed first.
5. **Map is the landing view.** Not a list, not a dashboard. The map renders
   immediately and fills in progressively.
6. **Show only what exists.** If there is no record for something, nothing is
   drawn. No "unknown" pins, no empty states per feature. The one exception is
   water (see §6).
7. **The repository is public.** Nothing secret and nothing personal is ever
   committed — no keys, no `.env*` except `.env.example`, no real names or
   personal email addresses (commit metadata included). The app needs no API
   keys (§5); anything with a `VITE_` prefix ships to every browser and is
   public by definition.

## 3. Architecture decision

**Decided 2026-11-20: build-time vector tiles, served as static files.**
Supersedes the client-side Overpass design (archived verbatim in
`docs/history/overpass-era-spec.md`; reasons in §12).

```
Weekly build (owner's server, or any build box)
  planet-latest.osm.pbf
    └─ osmium tags-filter  → only the tags in the layer table (§6)
       └─ Planetiler, custom profile → pawpath.pmtiles   (z0–14, overzoomed above)

Owner's server — Coolify, docker-compose.yml     Cloudflare free proxy in front
  web   (Caddy, static only)
    /              the SPA (Vite build, baked into the image)
    /tiles/        pawpath-YYYYMMDD.pmtiles + manifest.json  ← shared volume
    /tiles/water-warnings.json   optional (Phase 6) — no source with clear terms yet
  tiles (builder) rebuilds into the shared volume when > 7 days old

Browser
  ├── MapLibre GL JS     basemap (OpenFreeMap) + pawpath vector source
  ├── OpenMeteoSource    conditions, direct, cached 1 h in localStorage
  └── localStorage       filter prefs, favourites, last location
```

Why:
- Everything drawn from OSM is static over weeks. Querying it live from a
  volunteer service cost seconds and megabytes per area, failed in ways that
  took two sessions to misdiagnose, and could not scale (§9 always said so).
- Public Overpass does not reliably serve datacenter IPs (observed
  2026-11-20), so proxying it through the owner's server was not an option.
- Static tiles cost the server the same at 10 users or 100,000, and the edge
  cache absorbs almost all of it.
- The dog-specific rules (levels, `dog=yes`, surface → paw risk) move into the
  tile-build profile unchanged in meaning. `src/data/sources/layers.ts`
  remains the single definition; the profile is generated from it or kept
  in lock-step by a test.

**The data layer stays swappable.** UI code reads tile and style URLs from
`config.ts` and feature properties from the vector source; it never knows
where the tiles were built or hosted.

### Known trade-offs

Accepted deliberately; do not "fix" these without discussion:
- Data is up to one build old (weekly). Irrelevant for benches and forests.
- A planet build needs **~50 GB of temporary disk**: `build.sh` downloads,
  filters and deletes one region at a time, so the peak is the largest region
  (Europe) plus small filtered parts. Only the `.pmtiles` stays afterwards.
  If even that is too much, build elsewhere and upload the result.
- Tags not in the profile are not in the tiles. Adding a layer means a rebuild.
- **The routing layer (Phase 9) is most of the size.** Flevoland: filtered
  extract 11 MB of 39 MB, tiles 6.7 MB (4.2 MB without `walk`). Scaled by
  extract size, rough estimates only: NL+DE tiles ~1–2 GB, planet ~10–15 GB
  permanent, and the planet filter step needs ~20 GB more temporary space on
  top of the largest download. Measure on the first real NL+DE build.

## 4. Stack

- Vite + React 18 + TypeScript, Tailwind CSS v3 — static SPA, no SSR.
- MapLibre GL JS (**not** Mapbox GL — licensing) + the `pmtiles` protocol.
- Tile build: `osmium-tool`, Planetiler (Java 21), the `pmtiles` CLI.
- Hosting: **Docker via Coolify** on the owner's server, from this repository
  (`docker-compose.yml`): a Caddy `web` container serving static files and a
  `tiles` builder container, sharing one volume. Cloudflare free proxy in
  front. No Worker, no database, no n8n.
  Details: `docs/deployment.md`.

### Basemap

**OpenFreeMap** (`https://tiles.openfreemap.org/styles/liberty`) by default:
no key, no request limits, commercial use allowed, no SLA. Configured through
`MAP_STYLE_URL` in `config.ts`; `VITE_MAP_STYLE_URL` overrides it, so MapTiler,
Stadia or a self-hosted Protomaps/OpenMapTiles basemap is an env-var change.
If OpenFreeMap ever becomes unreliable, self-host a basemap `.pmtiles` next to
ours.

**Never point at OpenStreetMap's standard tile servers** (`tile.openstreetmap.org`) —
their usage policy forbids it.

## 5. Data sources

**No API keys are needed anywhere.** Every source below is keyless.

| Data | Source | Coverage | Limits / terms | Used for |
|---|---|---|---|---|
| OSM features | Own `pawpath.pmtiles`, built from the planet file | Global | ODbL; attribution mandatory | All map symbols and areas |
| Basemap | OpenFreeMap | Global | No limits, no key, as-is | Background map |
| Weather, UV, radiation, rain | Open-Meteo Forecast | Global (KNMI/DWD high-res models where available) | Free tier **non-commercial**, < 10,000 calls/day, 5,000/h, 600/min, CC BY 4.0 | Conditions, paw model, walk window |
| Air quality, pollen | Open-Meteo Air Quality (CAMS) | Global AQ; pollen Europe only | Same as above | AQI card |
| Place search | Photon (komoot public instance), later self-hosted | Global | Fair use, throttled when heavy, no SLA | Search box |
| Bathing water sites | EEA ArcGIS service `BathingWater_Dyna_WM` (Bathing Water Directive) | EU + CH, AL (21,973 sites) | EEA re-use policy, attribution; newest classification season 2022 | Phase 6, baked into tiles each build — "monitored" state |
| Live water warnings | **none usable yet** — see §12 Phase 6 | — | zwemwater.nl publishes no live API (monthly Excel for press use only); DE is per state | Optional `water-warnings.json`, format in `docs/water-warnings.md` |

Staying inside the limits:
- **Tiles and basemap** have no per-request limits; the edge cache and browser
  HTTP cache do the rest.
- **Open-Meteo** is called from each visitor's own browser, so its per-IP
  limits apply per visitor, not to us. Requests are rounded to a ~0.1° grid
  and cached for `CONDITIONS_TTL_MS` (1 h) in `localStorage`: one visitor
  costs a handful of calls per day. **Commercial use** (an enabled ad slot)
  requires Open-Meteo's paid plan or self-hosting it — a Phase 7 blocker.
- **Photon**: search runs on submit (or debounced, minimum 3 characters,
  ≥ 1 s apart), never per keystroke. Self-host when traffic warrants.
- **Nominatim is not used** for search: its policy forbids client-side
  autocomplete.

### Overpass — development tool only

Overpass is no longer in the product. It may be used by hand or by the recon
tooling to check what a tag looks like before adding it to the profile. The
lessons that still apply if it is ever called from a browser again: POST
`application/x-www-form-urlencoded` (never `application/json`, which forces a
preflight), `Accept: application/json, */*;q=0.8` (a 406 means our `Accept`
is wrong, not that we are blocked), one request at a time, jittered backoff.
Full history: §12 and `docs/history/overpass-era-spec.md`.

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

Implemented (Phase 6): the water layer holds **only** EEA bathing sites (grey-blue
waves badge); OSM water bodies are not in the tiles at all. The popup names the
EU classification **with its season**, says when it is outside the bathing
season ("not being monitored right now"), repeats "not a safety guarantee", and
links the official profile for today's status. A site turns red (alert badge)
only when `water-warnings.json` names its EEA id.

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

Implemented rules (`src/lib/conditions/`), recorded so they are not re-derived:
- The hour is scored on **asphalt in full sun** — the common worst case on a walk.
- **poor** if paw > 52 °C, rain ≥ 60 % or UV ≥ 8; **ok** if paw ≥ 45 °C, rain
  ≥ 30 % or UV ≥ 6; otherwise **good**. The paw band uses the **high end** of
  the estimate range.
- **The 15-minute forecast beats the hourly probability**: when it says the
  next 2 h stay dry, rain reasons are dropped for those hours — for the verdict
  *and* the walk window, so the card never contradicts itself.
- Verdict: the current hour's score, downgraded by air quality (EAQI ≥ 60 →
  care, ≥ 80 → wait).
- **Day and night are not scored** (owner, 2026-11-22): people may walk when
  they like; the card informs (sunset time) but never marks night as worse.
- **Heat stress for dogs** (added 2026-11-22) uses the felt (apparent)
  temperature — a property of the location, not of a path: ≥ 28 °C makes an
  hour "ok" at best, ≥ 32 °C "poor", day or night. The card adds advice from
  20 °C up, pointing to shady routes. Bands in `DOG_HEAT_BANDS_C`.
- **Pollen** (added 2026-11-22, CAMS, Europe only): shown as chips at moderate
  or high, never part of the verdict.

### Seasonal warnings

Date-and-temperature rules, no external data:
- Grass seeds (*grasaren*): roughly June–August
- Ticks: temperature above ~7 °C for several consecutive days, peak spring/autumn
- Oak processionary caterpillar: roughly April–July, NL/DE/BE
- Breeding-season leash obligation: 1 March – 15 July (NL nature areas)
- Winter paws (added 2026-11-21): frost or snow in the next 12 h → ice and
  road-salt advisory.

All of these are advisory. Word them as such. Country-specific rules use rough
country boxes (`COUNTRY_BOXES`), not geocoding; dates use the calendar at the
location's time zone, not the browser's.

## 8. Tile strategy

- **One vector source, one source-layer per `LayerKey`.** Feature properties
  carry the derived `level` and the tags popups need — never the full tag set.
- **Zoom.** Tiles are built to z14 and overzoomed by MapLibre above that.
  Amenity layers appear from z13; surface from z15 (it is an order of
  magnitude denser than anything else — 700–780 features/km² measured).
  Per-layer minimum zooms live in the build profile and are mirrored in
  `config.ts` so the UI can say "zoom in to see …".
- **Toggling a layer is a visibility change**, not a request. Default on first
  visit: shade, off-leash, water.
- **Polygons are complete**, multipolygon relations included — assembled at
  build time.
- **Paw-heat recolouring** of surfaces is a MapLibre style expression driven
  by the current paw estimate, not a re-fetch.
- **Caching** is HTTP caching: long `Cache-Control` on tiles, versioned file
  name per build (`pawpath-YYYYMMDD.pmtiles`) so a new build never mixes with
  old cached tiles. Conditions: 1 h in `localStorage`.
- **Coverage stats** replace the recon page: a script reports features per km²
  per layer for any bbox, read from the built tiles.

## 9. Monetisation

A single unobtrusive ad slot is included from Phase 7. Build it as a component
with a feature flag so it can be enabled, swapped or removed without touching
layout code. Reserve the space in the layout so enabling it causes no shift.

Caveats to keep in mind, recorded so they are not rediscovered later:
- **Open-Meteo's free API is non-commercial.** An enabled ad slot makes the app
  commercial: switch to their paid plan or self-host Open-Meteo first.
- **ESA WorldCover** (a candidate shade source, §12) is CC BY 4.0 but asks for
  prior approval for use in commercial advertising.
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

### Design direction (decided 2026-11-21)

**Cute, artsy, playful — not childish.** For dogs and the people who walk them.

- **Light theme only.** No dark mode.
- **Palette:** warm and soft — cream paper background, sage green, terracotta,
  sunny yellow, with a deep warm brown for text. Defined once as design tokens
  (Tailwind theme + `src/styles/tokens.ts` for map styles), never as ad-hoc hex
  values in components.
- **Safety colours keep their meaning, softened in tone:** off-leash green,
  leash amber, prohibited red, `dog=yes` neutral. They must stay distinguishable
  for colour-blind users (pair colour with an icon or pattern) and readable in
  sunlight.
- **Basemap:** OpenFreeMap restyled toward muted, paper-like colours so our
  symbols carry the colour.
- **Mascot: a golden retriever, cartoon style.** Appears in loading, empty and
  error states and the disclaimer — small, warm, never in the way of the map.
  Original artwork only (inline SVG in the repo), no stock or third-party
  characters.
- **Icons:** rounded, slightly hand-drawn feel, consistent stroke.
- **Type:** one friendly rounded face for headings (Fredoka), a highly legible
  face for body text (Nunito), self-hosted via npm — no Google Fonts CDN.
- **Copy** has a little personality ("Paws are fine — 31 °C on asphalt") but
  safety messages stay plain and unambiguous.
- Mobile-first rules in §10 still win: 44 px tap targets, high contrast.

---

## 11. Phases

Phases are units of work, not sessions: several may run in one session. At
the end of each phase, update §12 Status before starting the next.

### Phase 1 — Scaffold and Overpass reconnaissance
Project setup, data-source abstraction, and a `/recon` page that runs Overpass
queries for a given coordinate and reports feature counts per tag. Purpose:
verify empirically that OSM coverage is good enough per layer in the
Netherlands, Germany and one other country before building UI on top of it.

*The recon page was deleted in Phase 2R together with the Overpass path. Its
job — features per km² per layer — is now `npm run tiles:coverage`, which
reads the built tiles (see "Recon findings").*

### Phase 2 — Map shell *(built on Overpass; superseded by 2R)*
MapLibre map, geolocation, tile grid, IndexedDB cache, zoom gating, debounce,
attribution, disclaimer. Its Overpass data path is replaced by Phase 2R; the
map, geolocation, disclaimer, attribution and ad slot carry over.

### Phase 2R — Tile pipeline and map rebuild
- Planetiler profile generated from (or tested against) `layers.ts`; build
  script `osmium tags-filter` → Planetiler → `pawpath-YYYYMMDD.pmtiles`.
- Verified first on a small extract (Flevoland), then NL+DE, then planet.
- MapLibre reads the `.pmtiles` via the `pmtiles` protocol; basemap OpenFreeMap.
- Layer toggles (visibility only) and the "zoom in to see" hint.
- Place search moved to Photon, never per keystroke.
- Delete the Overpass runtime path, the IndexedDB cache, the tile grid and the
  proxy seam; replace the recon page with a coverage-stats script.
- Deployment notes for Caddy + Cloudflare, with long-lived cache headers.
- **Done when** features render around Almere at z14 from our own tiles.

### Phase 3 — Conditions engine
Open-Meteo integration, paw temperature model, walk window, rain window, air
quality, UV, seasonal rules. Collapsible conditions card. Pure functions + tests.

### Phase 4 — Symbol layers and filters
All amenity layers, filter panel with persistence, level-encoded symbols,
popups, progressive rendering.

### Phase 5 — Area layers
Shade polygons, surface rendering with live paw-heat recolouring, off-leash areas.

**Paw temperature per path, not per place** (owner, 2026-11-22): each path is
coloured by the paw model for *its own* surface, from the current weather — an
asphalt road reads hot while a grass path next to it stays green. The tiles
already carry `surface`; the style computes the band per surface kind (k value)
from the live estimate, so it is a style update, not a re-fetch. Stretch goal:
use shade polygons for the canopy fraction of paths that run through them.

### Phase 6 — Water warnings
EEA bathing water sites baked into the tiles at every build
(`tools/tiles/fetch-bathing-waters.sh`); three-state water rendering; an
optional runtime `water-warnings.json` turns named sites red. **No n8n**
(owner, 2026-11-22): if a warnings source becomes usable, its connector runs
as a step in the existing `tiles` container loop. No Worker, no database.

### Phase 7 — Public launch
Ad slot component, error and offline states, performance pass, share links,
favourites, deployment.

**Launch checklist — all blocking:**

1. **Repository hygiene before it goes public** (§2.7): re-run a secret and
   personal-data scan over the full history (the 2026-11-21 rewrite fixed the
   one finding so far). Enable GitHub's "keep my email private", "block
   command line pushes that expose my email", and secret-scanning push
   protection. Before flipping to public, consider recreating the repository
   from a fresh push: GitHub can keep unreferenced old commits reachable by
   SHA for a while after a force-push.
2. **Set `APP_CONTACT_URL`** in `src/config.ts` to the public repository URL.
3. **Commercial status of Open-Meteo** (§9): if the ad slot is enabled, the
   paid plan or a self-hosted instance must be in place first.
4. **Attribution** for every source present: OSM (ODbL), OpenFreeMap /
   OpenMapTiles, Open-Meteo (CC BY 4.0), and any enrichment source.

### Phase 9 — Route planner (requested 2026-11-22)
Plan a walk: tap waypoints, drag the line onto another path, see distance and
the paw/shade/off-leash profile along the way; save routes (localStorage) and
reopen them; export GPX and share as a link. Optional "walk it" mode that
follows your position along the route (no voice turn-by-turn at first).

**Decided and built (2026-11-22) — keeps §2.1/§2.4 intact:** routing in
the browser on a walking graph the weekly build produces anyway. The build
writes a `walk` source-layer into the same `.pmtiles` (z14 only, every
walkable way with `highway`, `surface`, `foot`, `access`, `dog`); the browser
loads the tiles around the waypoints and runs A* with **dog-aware weights** (prefer cool surfaces, shade and off-leash
areas; avoid hot asphalt in the heat). Zero server compute, works for any
traffic, and it is the one thing no public router does. Dog walks are a few
km, so the graph needed per route is small.
Rejected alternatives: public routers (OSRM/Valhalla/GraphHopper demo or
FOSSGIS servers) — usage limits, an external dependency like Overpass was,
and no dog-specific weighting; keyed APIs (openrouteservice, GraphHopper) —
keys would ship to every browser (§2.7); a self-hosted router — per-request
compute on the owner's server (§2.4).

### Phase 10 — Community mirrors (idea, 2026-11-22)
Others host part of the map to share load. Feasible because tiles are static:
- **Mirrors**: the manifest lists several hosts with the same file; the app
  picks one. Simple, but every mirror stores the whole file.
- **Regional shards**: a volunteer builds and hosts one region
  (`TILE_REGIONS=europe/belgium`) and registers it; the manifest maps regions
  to hosts, and the app adds one vector source per region in view.
Open questions: trust (a shard can serve wrong data — sign manifests?),
uptime (fall back to the main host), and versioning across shards. Not
before launch; Cloudflare's free cache is likely enough until then.

### Phase 11 — Mobile app (idea, owner 2026-11-22)
Recommended path, cheapest first:
1. **PWA** — installable from the browser, offline shell, cached tiles for the
   last-viewed area. Almost free on this architecture (static files, no
   accounts) and covers most of what an app store app would.
2. **Capacitor wrapper** around the same build when store presence, background
   location for the "walk it" mode, or push reminders ("good walk window in
   30 min") justify it. Same code base; no second app.
Decide after launch, with real usage.

### Phase 12 — Report what's missing (idea, owner 2026-11-22)
Let walkers report a bench, bin, bag dispenser or tap that is missing or
gone. **Recommended, not built:** an anonymous **OSM Note** (`POST
/api/0.6/notes`, no account, no key) at the tapped spot with a prefilled,
editable text ("Dog-waste bag dispenser here — reported via PawPath"). OSM
mappers then verify and add it; it reaches our tiles with the next weekly
build. Keeps §2: no accounts, no server of ours, no key.
- **Permanent features only.** Never temporary conditions — blue-green algae,
  a broken tap today, a loose dog: OSM is not for transient state, and a
  water warning from an unknown user would wrongly look official (§6).
- Rate-limit in the browser (one note per minute), show the note link after
  sending, and say plainly that it is public and anonymous.
- Not editing OSM directly: that needs an OSM account and OAuth, and
  unreviewed edits from a casual UI would harm the map we depend on.

### Phase 8 — Regional enrichment (post-launch)
Official municipal/national sources added **on top of** OSM via build-time
static GeoJSON. OSM remains the default and only source everywhere until then.

The motivating gap: Dutch off-leash areas (*losloopgebieden*) are municipal open
data and largely absent from OSM, so `dog=*` coverage is thin exactly where the
primary users walk. Enrichment appends to a layer rather than replacing it.

Constraints that keep this compatible with §2:
- **Additive only.** A region with no official source shows OSM data and is not
  degraded. No feature may depend on a regional source being present.
- **Build-time only**: merged into the same tile build. No runtime fetching of
  third-party portals.
- **Attribution per source.** Each provider registers its licence string in
  `SOURCE_ATTRIBUTION`, and every source present in the rendered features is
  credited.
- The seam: a regional dataset becomes another `sources:` entry in the
  generated Planetiler schema, its features land in the same source-layers,
  and its licence goes into `SOURCE_ATTRIBUTION` (`src/data/attribution.ts`).
  Nothing is built for this until the phase starts.

---

## 12. Status

- [x] Phase 1 — Scaffold and recon *(code complete. **No recon run has ever completed
      cleanly**: Run 1 was a self-inflicted burst, and from Phase 2.5 until the
      2026-11-20 audit every recon query sent `[timeout:[object Object]]` and
      was rejected with 400. Fixed; Run 2 still to be executed.)*
- [x] Phase 1.6 — Post-Run-1 selector and politeness corrections
- [~] Phase 2 — Map shell *(code complete, including the 2.5 corrections.
      **Not yet confirmed end to end:** features have never been seen on the
      map. See "Phase 2 — verification status" below. Its data path is
      superseded by Phase 2R.)*
- [x] Phase 2R — Tile pipeline and map rebuild *(done 2026-11-21: verified
      on a Flevoland build — features render around Almere at z14 from our own
      tiles. NL+DE and planet builds still to run, on the owner's server.)*
- [x] Phase 3 — Conditions engine *(done 2026-11-21: Open-Meteo forecast + air
      quality, paw model, walk and rain windows, seasonal advisories,
      collapsible card; verified in a headless browser at Almere with live data)*
- [x] Phase 4 — Symbol layers and filters *(done 2026-11-22: level-coded badge
      icons, filter sheet with per-level switches persisted, popups with exact
      values and an "edit on OpenStreetMap" link; verified in the browser)*
- [x] Phase 5 — Area layers *(done 2026-11-22: every path coloured live by
      its own surface's paw estimate, paved solid / unpaved dashed; shade
      hatched; off-leash areas with fill, outline and badge)*
- [x] Phase 6 — Water warnings *(done 2026-11-22 for what exists: 21,973
      official EU bathing sites in the tiles, three-state rendering, optional
      warnings file. **No live warnings source** is usable yet — see below.)*
- [ ] Phase 7 — Public launch
- [ ] Phase 8 — Regional enrichment (post-launch)
- [x] Phase 9 — Route planner *(done 2026-11-22, pulled forward before
      Phase 7: in-browser A* on the `walk` tile layer, dog- and heat-aware;
      drag stops and the line, undo, round trip, save, share link, GPX,
      "walk it". Verified in the browser at Almere.)*
- [ ] Phase 10 — Community mirrors *(idea)*
- [ ] Phase 11 — Mobile app *(idea: PWA first, Capacitor later)*
- [ ] Phase 12 — Report what's missing *(idea: anonymous OSM Notes, permanent
      features only)*

### Phase 2R — verification (2026-11-21)

Headless Chromium, Almere 52.3508, 5.2647, our own Flevoland tiles
(`pawpath-20261121.pmtiles`, 5.5 MB, OSM data of 2026-11-21, built in 8 s):

| View | Rendered features | Requests |
|---|---|---|
| z14, default layers | 143 dense / 35 medium / 2 light shade, 12 dog parks | 5 range requests, no errors |
| z14, all layers | the above + 7 benches; "zoom in to see path surface (level 15)" shown | 5 |
| z16, Almere centre, all layers | 64 benches, 53 hot-surface paths, 1 drinking water | 2 |

Cross-checked against the raw data with `osmium` in the same 16 km² square:
forest 545 ways + 11 relations, wood 18, tree rows 26, scrub 557, 80 bench
nodes, 8 dog parks — consistent with the tiles. Run 1 had forest 537 and
wood 20 (matching), but **scrub 11**; whether that was its slow, partial
query or a mapping wave since August is unknown — the tiles reflect today.

Known gaps after 2R, all owned by later phases:
- **Water draws nothing yet** — correctly: unmonitored water is never drawn
  (§6), and "monitored"/"warning" arrive in Phase 6. The toggle exists.
- **Shade blends into the basemap's own forest green** at z14 — Phase 5 needs a
  distinct treatment (pattern or hatch).
- Symbols are plain level-coloured circles; icons are Phase 4.
- Geofabrik (and Overpass) drop connections from the Claude cloud sandbox; the
  test extract came from `download.openstreetmap.fr`. Not an issue on the
  owner's server.

### Phase 3 — verification (2026-11-21)

Headless Chromium, Almere, live Open-Meteo data, 16:32 local:
collapsed card "Good to walk · UV 0 · paws 6–12 °C"; expanded shows the paw
estimate (one line without sun), "Good now, until about tomorrow 17:00", "Dry
for the next 2 hours", sunset 16:38, UV low, air good (EAQI 19), and the
Open-Meteo credit. First load: 2 requests (forecast + air quality); reload: 0
(1 h cache). The first run exposed three wording bugs — a midnight-spanning
window without "tomorrow", three identical paw rows at dusk, and "rain
possible" next to "dry for 2 h" — all fixed and pinned by tests.

Known after Phase 3:
- The walk window ignores darkness: "good now until tomorrow 17:00" runs
  through the night. Sunset is shown; whether night should score lower is a
  product decision, not taken.
- The OpenFreeMap style logs three MapLibre warnings ("Expected value to be of
  type number, but found null") — confirmed to occur with all PawPath layers
  off, so they are upstream.

### Phase 4 — verification (2026-11-22)

Headless Chromium, Flevoland tiles: at z17 in Almere centre 9 bench badges
render and all 12 badge images are registered; tapping a bench opens "Bench ·
No backrest · Made of wood · Something wrong? Fix it on OpenStreetMap" linking
to the right OSM node. At z14.5, 12 dog-park features render; switching "Dog
park" off in the filter sheet hides all 12, switching it on restores them, and
the choice is stored. No page errors.

### Phase 5 — verification (2026-11-22)

Headless Chromium, Flevoland tiles, Almere centre at z16:
- **Real weather (night)**: all 53 rendered paths green; tapping an asphalt
  street: "Kind to paws right now · Paws now: about 6–12 °C in the sun".
- **Simulated hot afternoon** (31 °C, 900 W/m², injected into the local
  conditions cache — a rendering test, not real weather): asphalt and metal
  paths terracotta, concrete and paving stones yellow, side by side; the
  asphalt popup reads "Too hot for paws right now · about 49–55 °C".
- South of Almere at z15.5: 27 hatched shade areas, 12 dashed unpaved and 6
  solid paved paths; hatch distinct from the basemap's forest green.

### Phase 6 — verification (2026-11-22)

- `fetch-bathing-waters.sh`: 21,973 sites in 6 s (NL 740, DE 2,292), merged
  from two pages; Flevoland tile build 4.2 MB (was 5.5 MB — the never-drawn
  OSM water polygons are gone). `planetiler verify`: 34/34 incl. an EEA example.
- Browser, Weerwater (Almere), z13.4: three official beaches render with the
  neutral badge; the Stedenwijkstrand popup reads "Official bathing spot · EU
  classification (2022 season): Good · Outside the bathing season: it is not
  being monitored right now · … not a safety guarantee", with the official link.
- With a **test** warnings file (deleted afterwards) naming Stedenwijkstrand:
  that site alone turns red; popup "Blue-green algae · Keep your dog out of the
  water", link to the notice. Without the file: no red anywhere.
- `tiles` image rebuilt with `jq`; fetch script present.

### Phase 9 — verification (2026-11-22)

Flevoland build with the `walk` layer: 6.7 MB (was 4.2 MB); `planetiler
verify` 36/36. `npm run tiles:route-check` around Almere centre (9 tiles):
74,676 nodes, 88,953 edges, **largest component 99.4 %**, loaded in 0.25 s,
a 5.2 km route planned in 45–60 ms.

Headless Chromium, Almere centre, z14.6:
- Two taps → 650 m, about 10 min, profile bar and legend; share link in the
  address bar. A stop in the Weerwater lake: "Stop 2 is too far from any
  path" (correct refusal).
- Dragging the route line → a third stop where it was released, 930 m;
  dragging that stop → 570 m; Undo → 930 m; Round trip → 1.6 km "back to
  the start". Saved as "Weerwater loop"; GPX download with 119 points.
- Fresh page: My walks → reopen → same 1.6 km route. Fresh page with only the
  share link → planner opens on the same route, camera fitted.
- Simulated hot afternoon (31 °C, 900 W/m²): "20 m too hot for paws now · 90 m
  warm"; in the Node check the second test route's unpaved share rose from
  413 m to 1,092 m.
- No page errors (Open-Meteo answered 429 to this sandbox in one run: its
  per-IP limit, shared by the whole cloud host; not our traffic).

### Decisions log

**Phase 9 — route planner (2026-11-22)**

- **The graph is a tile layer, not a separate file.** `walk` (z14, never
  simplified, `min_size 0`) sits in the same `.pmtiles`, so the build,
  hosting, caching and versioning are unchanged. Every walkable highway is in
  the osmium filter now, which is most of the size increase.
- **Topology from the tile grid.** Coordinates stay integers on the global z14
  grid (`tileX × extent + x`): a vertex shared by two tiles has the same key
  in both, so tiles stitch exactly with no float tolerance; duplicate
  segments from the tile buffers are dropped.
- **Dog-aware cost** (`src/lib/routing/cost.ts`, factors in `config.ts`):
  never through `foot=no`, private/no access (unless `foot=yes`) or `dog=no`;
  paths 1, streets 1.25, tertiary 2, secondary/primary 3.5; off-leash 0.85;
  with live weather, caution ×1.8 and danger ×4 by the path's own surface.
  **Unmapped surface gets half the asphalt penalty** in the heat — without
  it the first test route escaped onto 4.7 km of untagged (often paved) ways.
- **Snap to the main network** when it is within 250 m: the first browser run
  snapped a via point onto a 2-node courtyard footway and found no route.
- **No routing without the tiles nearby**: at most 64 z14 tiles per route
  (`ROUTE_MAX_TILES`), so a walk of a few km; longer gets a plain message.
- **State is URL + localStorage only**: the share link is
  `#route=lat,lng;…[;loop]` (validated, ≤ 30 stops), saved walks are in
  `pawpath.routes.v1` (≤ 50). No accounts (§2.2).
- **Editing**: tap the map to add a stop, drag a stop to move it, tap it to
  remove it, press-and-drag the line to add a via point where it is
  released (inserted between the stops it sits between). A release outside
  the map cancels the drag. Undo covers every edit.
- **Profile**: with weather, metres too hot / warm / kind to paws now plus
  paved/unpaved; without weather, paved / unpaved / not mapped — never a
  heat claim without weather.
- **"Walk it"** uses `watchPosition` only while on, follows the walker, shows
  distance left and "off the route by …" beyond 40 m. No turn-by-turn.
- **Not done**: amenities along the route (benches, bins, water near it) and
  shade along the route (the stretch goal from Phase 5) — both candidates.
- **OSM write-backs** recorded as Phase 12: anonymous OSM Notes for permanent
  features only, never algae or other temporary states.

**Phase 6 — water (2026-11-22)**

- **Bathing sites come from the EEA's ArcGIS service**, fetched at build time
  (not Discodata, which returned 403 to this environment). **Data quirk
  handled:** the service holds a duplicate of every site with `countryCode
  'EU'`, all at one point in Slovenia (14.47 E, 46.27 N) — ~22,000 phantom
  sites; filtered out. The newest classification season is read from the field
  alias (2022) and stored per site, so the class is never shown without its
  year. Fewer than 1,000 sites or any failure → the last good file is kept (or
  an empty one); the tile build never fails because of the EEA.
- **OSM water is gone from the tiles.** It could only ever be "candidate"
  (never drawn, §6). `layers.ts` gained `externalSource`, the seam Phase 8
  needs anyway; the generator adds the GeoJSON source to the schema.
- **No live warnings source, and none scraped.** zwemwater.nl's "Data en API"
  offers only a monthly Excel of past measures, licensed for press reporting,
  without coordinates; the app's backend is undocumented and unlicensed. Berlin
  (LAGeSo, cc-by-sa) documents a JSON API, but its URL could not be confirmed
  and it covers one city. So the warnings path is built and tested
  (`waterWarnings.ts`, `docs/water-warnings.md`) but nothing writes the file.
  **Next step for the owner, if wanted:** ask zwemwater.nl / Rijkswaterstaat
  for reuse of live warning data with EEA ids; a connector would then be a
  step in the `tiles` loop.
- **No n8n** (owner): one less system. Anything scheduled runs in the `tiles`
  container, which is defined in this repo.
- **No OSM edit link on bathing sites** — they are EEA data; a decoded "OSM
  id" would point at an unrelated object. The official profile link instead.
- **EEA credited** in the map attribution next to OSM.
- Known: bathing sites are EU-wide in every build, even a `nl-de` build — they
  are tiny and harmless; clip later if it ever matters.

**Phase 5 — area layers (2026-11-22)**

- **Per-path paw colour is a style expression**, not data: `surfacePaint()`
  maps each path's `surface` value to its kind and the kind to the live band
  (`pawBySurface()` for the current hour, full sun), and MapView swaps it with
  `setPaintProperty` when the hour changes. Without weather it falls back to
  the static material risk. Hotter bands also draw wider (not colour alone).
- **Paved solid, unpaved dashed** (two layers: `line-dasharray` is not
  data-driven), so material stays readable when everything is cool at night.
- **Popups for paths speak about now** ("Too hot for paws right now", with the
  estimate range) and fall back to the material label without weather.
- **Shade = light wash + diagonal hatch** (dense for forest/wood, wider for
  scrub), tree rows as round dots; hatch tiles drawn at runtime like the icons.
- **Not done (stretch)**: canopy fraction for paths running through shade
  polygons — the per-path estimate assumes full sun, which is the safe side.
- **Mobile app** recorded as Phase 11 (owner idea): PWA first, Capacitor later.

**Phase 4 + owner feedback (2026-11-22)**

- **Icons are SVG path data in `src/map/icons.ts`**, rasterised into badges at
  runtime (Path2D) for the map and drawn as inline SVG in the filter sheet and
  popups — one definition, no asset pipeline. Every off-leash level has its own
  glyph (paw, fence, leash, crossed paw, question mark), not just a colour.
- **Level filters are live**: the filter expressions are rebuilt and swapped
  with `setFilter` — no re-fetch, no layer re-creation. `dog=yes` stays off by
  default and its explanation sits next to its switch.
- **Popups**: built only from DOM nodes and `textContent` (OSM text is
  untrusted), exact tags in words, a plain caveat for `dog=yes`, and an edit
  link decoded from Planetiler's id (`osmId × 10 + type`, verified).
- **Regions without an admin panel**: an admin account would break §2.2 (no
  accounts) and §2.4 (static only). Coolify's environment page is the admin
  switch: `TILE_REGIONS` takes a preset (`nl-de`, `planet`) or any list of
  Geofabrik ids (`europe/netherlands,europe/belgium`); changing it rebuilds.
- **Water is never "good to swim".** The owner asked to show "where the water
  is good to swim"; §6 stands: only official warnings and monitored bathing
  spots (with "not a safety guarantee") are shown, and unmonitored water is
  not drawn. A green "safe" state would be the second-worst failure after
  `dog=yes` as off-leash.
- Known: a closed-way bench can appear twice in a tile (Planetiler offers a
  closed way as line and polygon to `centroid`); invisible on the map.

**Containers for Coolify (2026-11-21)**

- **One Dockerfile, two targets**: `web` (Caddy 2.10, static, 89 MB) and
  `tiles` (Temurin 21 JRE + osmium + Planetiler 0.10.2 pinned). Compose wires
  them through a shared `tiles` volume; a `tiles-work` volume holds the ~50 GB
  of temporary build space.
- **The builder needs no Node.** The osmium filter is now generated *and
  committed* (`tools/tiles/osmium-filters.txt`) next to the schema, with the
  same staleness test. `build.sh` needs only Java, osmium and curl.
- **No cron**: `builder-loop.sh` builds when the manifest is missing, older
  than `REBUILD_AFTER_DAYS`, or built from a different `TILE_REGIONS`; a failed
  build keeps the previous tiles (tested: three download retries, then
  "build FAILED — keeping the previous tiles", old tiles still served).
- **Atomic swaps**: the archive is written as a hidden `.partial` file and
  renamed; the manifest likewise. Caddy hides dotfiles (`/tiles/.*` → 404).
- **No compression on `/tiles/`**: tiles inside the archive are already gzip,
  and compressing a range response breaks the pmtiles reader. Verified: 206
  with `Content-Range`, no `Content-Encoding`, immutable cache header.
- Tested end to end in Docker here: Flevoland built in the `tiles` container
  into a volume, served by `web` (healthcheck, SPA fallback, manifest, ranges).
  The sandbox needed its proxy CA injected into a test-only copy of the
  Dockerfile; the real Dockerfile is unchanged and needs nothing on a normal
  server.

**Phase 3 — conditions engine (2026-11-21)**

- **All logic is pure** in `src/lib/conditions/` (paw, bands, walk window, rain
  window, seasonal, verdict, summary); the card only words and lays out
  `summarise()`'s result. 32 tests, including the boundaries that matter
  (45/52 °C, 15 July inclusive, tick days, local-date at the location).
- **Open-Meteo, two requests**: forecast (hourly, 15-minute rain, daily means
  and sun times, 3 past days for the tick rule) and air quality (European AQI).
  Air quality failing never sinks the card. `timeformat=unixtime`; times are
  shown in the location's IANA time zone.
- **Cache**: 0.1° grid, 1 h in localStorage, entries older than a day pruned on
  write; a failed refresh falls back to stale data rather than nothing.
- **Pollen not added** (it was a "free addition if wanted"); dog heat stress
  from air temperature is not modelled beyond the paw estimate — both are
  candidates, not decisions.
- **A TypeScript trap, again**: a union member typed `status: 'idle' |
  'loading'` defeated narrowing and silently made `summary` `any` in the card.
  Split into one member per status; worth remembering next to the
  `[timeout:[object Object]]` bug.

**Phase 2R — tile pipeline and map rebuild (2026-11-21)**

- **`src/data/layers.ts` is declarative now.** Levels are ordered rules (first
  match wins) instead of functions, which is exactly Planetiler's match
  semantics. `tools/tiles/generateSchema.ts` generates the Planetiler schema
  *and* the osmium pre-filter from it; nobody edits `pawpath.schema.yml`.
- **One set of examples, two implementations.** `src/data/layerExamples.ts`
  (33 cases, every `dog=*` rule included) runs in vitest against the TS
  evaluator and in `planetiler verify` against the real build. Both pass. A
  test fails if the committed schema is stale.
- **Off-leash lines only on paths.** Planetiler treats a closed OSM way as both
  a possible line and polygon; off-leash lines are restricted to `highway=*`
  (e.g. `dog=no` on a footway) so park outlines are not drawn twice.
- **Surface requires a scored value.** `surface=moon_dust` used to pass the
  selector and fail later; now an unscored surface is not in the tiles (§2.6).
- **`amenity~dog_waste.*` became `amenity=dog_waste*` (prefix).** The old regex
  was unanchored; Planetiler's `%` wildcard is a prefix match. Same intent.
- **Versioned tiles + manifest.** The build writes `pawpath-YYYYMMDD.pmtiles`
  (immutable) and `manifest.json` (short cache); old files are kept a week.
- **Deleted:** the Overpass client, retry/breaker/budget, request-shape tests,
  IndexedDB cache, tile grid, proxy seam, recon page, dev panel, Nominatim
  search, `idb-keyval`. The lessons survive in §5 and the history file.
- **Photon replaces Nominatim**; search runs on submit only, ≥ 1 s apart,
  biased (not filtered) to the current map centre.
- **Design tokens** in `src/styles/tokens.ts` feed both Tailwind and the map
  styles. Fonts self-hosted (Fredoka, Nunito). The golden-retriever mascot is
  an original inline SVG (`src/components/Mascot.tsx`).
- **Basemap recoloured client-side** (`warmBasemap`), by layer id/type, so an
  upstream style change degrades to "less warm", not broken.
  `VITE_MAP_RECOLOUR=false` turns it off for non-OpenMapTiles styles.
- **Attribution deduplicated.** The basemap style credits its provider; our
  vector source credits OSM. `VITE_MAP_ATTRIBUTION` is only for a style that
  credits nothing itself. The control stays expanded (licence requirement).
- **Dev-only `window.__pawpathMap`** for diagnostics and the headless check.

**Stack change — 2026-11-20 (owner approved)**

- **Build-time vector tiles replace live Overpass.** Goal changed to "runs on
  the owner's server, usable by anyone, without overloading it". Live Overpass
  could not do that: volunteer capacity, per-IP slots, datacenter IPs refused,
  seconds and megabytes per area. A weekly planet build into one `.pmtiles`
  served statically behind Cloudflare costs the same at any traffic. §2, §3,
  §4, §5, §8 rewritten; the old text is in `docs/history/overpass-era-spec.md`.
- **Constraint §2.1 changed** from "Cloudflare free tier only" to "no marginal
  cost", and **§2.4** from "VPS not in the request path" to "server serves
  static files only". Same intent, matched to the new hosting.
- **New constraint §2.7: the repository is public.** Audit of the full history
  (2 commits, all files): no keys, tokens or credentials; lockfile resolves
  only to registry.npmjs.org. **One finding: the `init` commit's author and
  committer carry a personal Gmail address.** *Fixed 2026-11-21 (owner
  approved): history rewritten so `init` is authored by `unrlnt` with the
  GitHub noreply address, and both branches force-pushed. Every SHA changed.*
- **2026-11-21: the "one phase per session" rule is removed** (owner). Phases
  are units of work; several may run in one session.
- **Basemap: OpenFreeMap replaces MapTiler as default.** No key, no limits,
  commercial use allowed. MapTiler stays an env-var away. No key is needed
  anywhere in the app.
- **Phase 6 simplified**: n8n writes a static JSON; no Worker, no D1.
  *Superseded 2026-11-22: no n8n either — see Phase 6 decisions.*
- **Place search moves from Nominatim to Photon**; never per keystroke.

**Sources review — 2026-11-20** (what is best per parameter; candidates are
not decided, just recorded so they are not re-researched)

| Parameter | Current | Verdict | Better / additional candidates |
|---|---|---|---|
| Shade | OSM wood/forest/scrub/tree_row | Good where mapped, uneven worldwide | **OSM `natural=tree`** (individual trees — dense in NL cities from municipal imports); **ESA WorldCover 10 m** tree class (global, CC BY 4.0, consistent everywhere; ad use needs ESA approval); later: building shadows by time of day from OSM building heights |
| Off-leash | OSM `dog=*`, `dog_park` | Sparse everywhere, as expected | Municipal *losloopgebieden* open data (Phase 8) |
| Surface | OSM `surface=*` on walkable ways | Best available | — (untagged ways stay undrawn, §2.6) |
| Water bodies | OSM `natural=water` | Good; swimming_area/beach were 0 everywhere | Drop or keep the two empty selectors — decide from coverage stats |
| Water monitoring / warnings | EEA + NL/DE portals (Phase 6) | Right sources | — |
| Benches, bins, dispensers, drinking water | OSM | Only global source | NL drinking-water taps from water-company / municipal open data (Phase 8, unverified) |
| Weather, UV, radiation | Open-Meteo | **Best fit**: global, keyless, has shortwave radiation the paw model needs, uses KNMI/DWD high-res models for NL/DE | — |
| Short-range rain | Open-Meteo `minutely_15` | Model, not radar | Radar nowcast would be better for "rain in 30 min"; RainViewer's free API was cut back in 2025–26 (zoom limits, no forecast) — not recommended. Buienradar is Benelux-only enrichment; verify terms |
| Air quality | Open-Meteo CAMS | Good globally | Luchtmeetnet (NL official measurements) as enrichment |
| Pollen | — | Not planned | Open-Meteo CAMS pollen (Europe) — free addition if wanted |
| Official weather warnings (heat, storm) | — | **Gap** | MeteoAlarm CAP feeds (EU national met services); licence terms to verify before use |
| Daylight / darkness | — | **Gap** for the walk window | Computed locally (sun position), no API |
| Winter paws (frost, snow, road salt) | — | **Gap** | Derived from Open-Meteo temperature + snowfall: "salt likely on paths" advisory |
| Ticks, processionary caterpillar | Date/temperature rules | Fine as advisory | NL enrichment candidates exist; not researched |

**Audit — 2026-11-20 (repo moved to GitHub; first cloud session)**

Full write-up, including the implemented-vs-claimed table and a stack
proposal awaiting a decision: `docs/audit-2026-11-20.md`.

- **Recon and `fetchTile` were sending `[timeout:[object Object]]`.** Phase 2.5
  turned `OVERPASS_SERVER_TIMEOUT_S` into a per-group object; the default in
  `buildOverpassQL` was an unannotated destructuring default, which TypeScript
  silently widened to `number | object`, so the type checker never complained.
  Overpass answers that with 400, which is classed as fatal — every recon probe
  failed on its first attempt. Only `fetchTiles` (the map path) passed an
  explicit timeout and was unaffected. Fixed, annotated, and pinned by a test.
- **A 406 still counted against instance health.** §5 says it must not; the
  fatal-status path called `recordFailure`, so three 406s would park a healthy
  instance. Removed; the test now asserts zero recorded failures.
- **A partly-failed batch cached the failed layers as empty for 30 days.**
  `CachedTileSource` wrote every requested layer whenever any feature came
  back. Latent on the map path (it requests one output group per call) but
  real for any mixed request. `TilesFetchResult.failedLayers` now tells the
  cache which layers were answered; only those are written.
- **Stale 406 comments** in `overpassRetry.ts`, `overpassHealth.ts` and the
  README still described "policy refusal / demotion". Corrected.
- **Claims below that were false or superseded are now marked inline**, not
  deleted, so the history stays readable: sticky rotation (never implemented),
  "two requests per tile" (superseded by batching), the Phase 1.6 backoff
  numbers (superseded by Phase 2), "verified against live instances" (only
  against failing ones), and the `User-Agent` "policing" line.
- **Decisions that were made in code but never written down**, recorded here:
  Nominatim place search (search-as-you-type, which its usage policy forbids —
  must become submit-on-Enter or move to Photon); long-press / right-click
  "drop a pin"; Almere as the fallback centre for *every* visitor worldwide;
  session budget of 1,000 requests / 100 MB; IndexedDB LRU limits of 2,000
  entries / 40 MB; 300 ms between Overpass requests; `osm.ch` and `osm.jp` as
  unverified candidate instances; polygon layers fetched with `out geom` in
  Phase 2 although only their centre point is drawn (payload paid for nothing
  until Phase 5).

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
  after an instance has really been tried. *Audit 2026-11-20: "verified
  against live instances" overstated it — it was verified only against
  instances that were failing from a sandbox. The loop has never been observed
  completing a success end to end.*
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
- *(Superseded by the Phase 2 retry policy: ~1 s base, 30 s cap, 3 per
  instance, 5 total, jittered.)* **Backoff before rotation.** On 429/504/timeout the client now retries the
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
- *(Corrected in Phase 1.6: `dog=off_leash` is not a valid OSM value. The
  first-class selectors are `dog=unleashed`, `dog=designated`, `dog=leashed`,
  `dog=no`, `dog=yes`.)* **`dog=off_leash` / `dog=leashed` confirmed as first-class selectors**, not
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
- *(Superseded in Phase 2.5: one request per output group per **viewport**,
  not per tile.)* **At most two Overpass requests per tile, not one per layer.** Layers are
  grouped by the output mode they need — `out center` for amenities (cheap),
  `out geom` for polygons (expensive). Elements are attributed back to layers
  client-side by re-evaluating the same tag conditions. This keeps the request
  count low while still giving Phase 8's progressive render a natural fast
  group and slow group.
- **`OVERPASS_MAX_CONCURRENCY = 1`.** Public instances allow ~2 slots per IP;
  using one leaves headroom and makes bursts of tile queries safe by
  construction.
- ~~**Instance rotation is sticky.**~~ *Audit 2026-11-20: never implemented.
  `instancesInPreferenceOrder` uses the configured order, with parked
  instances moved last. The circuit breaker is what keeps a degraded instance
  from being retried on every query.*
- **Identification is via a query comment, not a header.** Browsers forbid
  setting `User-Agent`, so every generated query starts with
  `// PawPath (<contact URL>) — <context>`. `APP_CONTACT_URL` in `config.ts`
  must be set and kept current: it is the only way an instance operator can
  reach us before blocking (currently unset — see the corrections above).
  ~~Confirmed empirically that `overpass-api.de` does police the
  `User-Agent` header.~~ *WRONG, and the root of the later "filters
  programmatic requests" mistake. The 406 is `Accept` content negotiation
  (§5). Browsers cannot set `User-Agent` anyway, so it never mattered to the
  app.*
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

**Run 2 is replaced by coverage stats from the tiles** (`npm run
tiles:coverage -- FILE.pmtiles LAT LNG`). First result, Almere, Flevoland
build of 2026-11-21 (density per area of the z14 tiles read):

#### 52.3508, 5.2647 · r=2 km · 26.8 km² · z14 · 12 tiles
Source: public/tiles/pawpath-20261121.pmtiles

| Layer | Level | Features | Per km² |
|---|---|---:|---:|
| Shade | dense | 851 | 31.77 |
| Shade | light | 68 | 2.54 |
| Shade | medium | 1168 | 43.60 |
| **Shade** | **total** | **2087** | **77.91** |
| Off-leash & dog rules | leashed | 7 | 0.26 |
| Off-leash & dog rules | off_leash_fenced | 8 | 0.30 |
| **Off-leash & dog rules** | **total** | **15** | **0.56** |
| Path surface | high | 1207 | 45.06 |
| Path surface | low | 244 | 9.11 |
| Path surface | mid | 186 | 6.94 |
| **Path surface** | **total** | **1637** | **61.11** |
| Water | candidate | 360 | 13.44 |
| **Water** | **total** | **360** | **13.44** |
| Benches | — | 155 | 5.79 |
| **Benches** | **total** | **155** | **5.79** |
| Bins & bag dispensers | general | 5 | 0.19 |
| **Bins & bag dispensers** | **total** | **5** | **0.19** |
| Drinking water | — | 3 | 0.11 |
| **Drinking water** | **total** | **3** | **0.11** |

Leipzig, Melbourne and Bogotá follow once the planet build runs.

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
