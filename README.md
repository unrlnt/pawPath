# PawPath

A no-login map of the things that matter when you walk a dog: shade, off-leash
areas, water warnings, benches, bins, bag dispensers, drinking water, path
surface, and live conditions.

`CLAUDE.md` is the spec and the source of truth. Read it before changing
anything.

## Status

The map shell (Phase 2) runs on live Overpass queries. On 2026-11-20 the
project switched to **build-time vector tiles** served as static files
(CLAUDE.md §3); Phase 2R rebuilds the data path. See `docs/audit-2026-11-20.md`.

## Running

```bash
# No configuration needed: the basemap defaults to OpenFreeMap (no key).
npm install
npm run dev        # http://localhost:5173
npm run typecheck  # tsc --noEmit, strict
npm test           # vitest, pure functions and the cache wrapper
npm run build      # typecheck + static build into dist/
```

`dist/` is a static bundle served as-is by a static file server. Nothing runs
per request.

## Diagnostics

In dev, the map page has a **dev** button (bottom left) with:

- **cache inspector** — entries, approximate size, hits/misses, evictions, clear;
- **session request budget** — against the Overpass usage policy's ~10,000
  requests / ~1 GB per user per day safety margin;
- **instance health** — which instances are parked by the circuit breaker
  (a 406 is never counted: it means our own `Accept` header is wrong);
- **connectivity tester** — one trivial `out count` per instance, no retries,
  bypassing the tile pipeline entirely. This is the first thing to run when the
  map has no data: it answers "are the instances reachable from *this* browser"
  without the cache, the retry loop or the breaker confusing the picture.

## Overpass etiquette

The public instances are volunteer-funded, and this app must not be the reason
one of them starts blocking browsers. The rules are in
[CLAUDE.md](CLAUDE.md) §5 and enforced in `src/config.ts`:

- one request at a time, never parallel — slots are shared across an IP block;
- retry the same instance with jittered backoff before rotating;
- on 429, read `/api/status` and wait for a real slot instead of guessing;
- never retry 400 or 406;
- a per-session request and byte budget, well inside the documented margin.

Browsers cannot set `User-Agent` — it is a forbidden header — so the app
identifies itself in a comment at the top of every generated query, and the
browser's `Origin`/`Referer` identify the domain. Keep `APP_CONTACT_URL`
current; see below.

## The recon page

**Dev builds only** — excluded from production at the route level.

```bash
npm run dev
```

Then open either URL; they are equivalent and neither needs a code change:

```
http://localhost:5173/recon      # path form, via Vite's SPA fallback
http://localhost:5173/#/recon    # hash form; also works on any static host
```

The home page links to it in dev too. In a production build both render a
"not available" notice.

It answers the Phase 1 question: does each layer have enough OSM coverage to
justify a toggle, here and elsewhere? Pick a preset (or type a coordinate and a
radius), run it, and read the table: per-tag feature counts, features per km²,
a coverage verdict, query timings, the exact Overpass QL that produced each
number, and a Markdown summary to paste into `CLAUDE.md` §12.

It queries the public Overpass instances directly, one request at a time. Don't
leave it running in a loop.

## Layout

```
src/
  config.ts               every tunable: tile size, TTLs, zoom, paw k values, thresholds
  data/sources/
    index.ts              the data layer's public surface — UI imports from here only
    tileSource.ts         TileSource interface, Feature type, TileSourceError
    layers.ts             the declarative layer → OSM tag map (add layers HERE)
    overpassQuery.ts      Overpass QL generation, driven by layers.ts
    overpassClient.ts     transport: instance rotation, timeouts, throttling
    overpassTileSource.ts TileSource implementation + normalisation
  lib/                    pure, browser-free, unit-tested
    tiles.ts              the ~2 km query grid
    surface.ts            OSM surface=* → paw-heat model kinds
    recon.ts              recon result shapes, verdicts, Markdown summary
  components/recon/       the Phase 1 recon page
```

### Adding a layer

Add an entry to `LAYERS` in `src/data/sources/layers.ts`. Query building,
normalisation, level derivation and the recon page all pick it up. Nothing else
needs to change.

## Contact identification — needs setting

`APP_CONTACT_URL` in [src/config.ts](src/config.ts) is currently **unset**.

Browsers cannot set a `User-Agent` header, so every generated Overpass query
carries an identifying comment instead, and this URL is the whole of its value —
it is how an instance operator reaches us before deciding to block us:

```
// PawPath (https://example.org/pawpath) — tile=2km:2913:325 layers=benches+waste
```

While it is unset, queries say `contact URL not set — see APP_CONTACT_URL in
src/config.ts` rather than carrying an invented link, which is honest but is not
a contact. **Set it to a real, reachable public URL — the repository or the
deployed site — before posting the app publicly**, and keep it current: a dead
link here is the same as no contact at all. It is one line in `config.ts` and
nothing else references the value directly.

## Attribution

Map data © OpenStreetMap contributors, ODbL. Queries go to the public Overpass
API instances. Attribution is a licence requirement and must stay visible once
the map exists.
