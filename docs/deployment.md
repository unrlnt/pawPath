# Deployment

PawPath deploys as **two containers from one repository** (CLAUDE.md §3):

| Service | Image target | Does |
|---|---|---|
| `web` | `Dockerfile` → `web` | Caddy serving the app and `/tiles/` from a shared volume. Nothing per request. |
| `tiles` | `Dockerfile` → `tiles` | Builds the map data from OpenStreetMap on first start, then rebuilds when it is older than 7 days. |

They share the `tiles` volume: `tiles` writes, `web` reads.

## Coolify (recommended)

1. **New resource → Public/Private repository** → this repo, branch of your
   choice. **Build pack: Docker Compose**, compose file `docker-compose.yml`.
2. **Domain:** assign it to the `web` service, port **80**. Coolify's proxy
   terminates TLS; Caddy inside listens on plain HTTP.
3. **Environment variables** (all optional):

   | Variable | Default | Meaning |
   |---|---|---|
   | `TILE_REGIONS` | `planet` | A preset (`planet`, `nl-de`, `flevoland`) **or** any comma-separated list of [Geofabrik](https://download.geofabrik.de) region ids, e.g. `europe/netherlands,europe/germany,europe/belgium`. Changing it triggers a rebuild — this is the "which countries" switch. |
   | `JAVA_XMX` | `4g` | Planetiler heap; raise for the planet if the build reports memory pressure |
   | `REBUILD_AFTER_DAYS` | `7` | Rebuild interval |
   | `VITE_MAP_STYLE_URL` | OpenFreeMap | Build-time basemap override (public value) |
   | `VITE_PHOTON_URL` | photon.komoot.io | Build-time search override, e.g. a self-hosted Photon |

4. **Deploy.** `web` is up within a minute and shows the map with a friendly
   "map data could not be loaded" note until the first tile build finishes.

**Tip for the first deploy:** set `TILE_REGIONS=nl-de` (minutes, a few GB),
check everything works, then switch to `planet` (hours). Changing
`TILE_REGIONS` triggers a rebuild on the next check.

### Disk and memory

- `tiles-work` volume: **~50 GB free while a planet build runs**. Regions are
  downloaded, filtered and deleted one at a time, so the peak is the largest
  region (Europe) plus small filtered parts; the volume is emptied afterwards.
- `tiles` volume: the finished `.pmtiles` (a few GB for the planet; measure on
  the first build) plus the previous one for a week.
- RAM: Planetiler works on the filtered data only; 4 GB heap is the starting
  point.

### Watching the builder

Coolify → `tiles` service → Logs. A build logs `[tiles …] downloading`,
`filtering`, `building`, `done`. A failed build logs
`build FAILED — keeping the previous tiles` and retries at the next check
(every 6 h); the site keeps serving the last good build meanwhile.

## Plain Docker Compose

```bash
TILE_REGIONS=nl-de docker compose up -d --build
docker compose logs -f tiles
# app on http://localhost (map data appears when the first build is done)
```

Publish port 80 of `web` (e.g. add `ports: ["80:80"]`) or put your own reverse
proxy in front.

## Cloudflare (free plan) in front

- Proxy the DNS record (orange cloud), SSL **Full (strict)**.
- Static assets are cached at the edge by default (`/assets/*` is marked
  immutable by Caddy).
- **Range requests on a large `.pmtiles`:** Cloudflare's free plan caches files
  up to 512 MB only, so range requests on a bigger planet file pass through to
  the server. Caddy serves those cheaply; start like this. If server load ever
  matters, add a `pmtiles serve` container that exposes `/{z}/{x}/{y}.mvt`
  (cacheable per tile with a Cache Rule for `/tiles/*`) and point the manifest
  at it.

## What the web server sends

| Path | Cache-Control | Notes |
|---|---|---|
| `/assets/*` | 1 year, immutable | hashed file names |
| `/`, `/index.html` | 5 minutes | |
| `/tiles/pawpath-YYYYMMDD.pmtiles` | 1 year, immutable | new name per build; range requests; never re-compressed |
| `/tiles/manifest.json` | 5 minutes | names the current build |
| `/tiles/.*` | 404 | in-progress builds and markers are hidden |
| `/healthz` | — | `ok`, used by the container health check |

## Without Docker

The build script needs only Java 21, `osmium-tool` and `curl`:

```bash
tools/tiles/build.sh /srv/pawpath/tiles $(grep -v '^#' tools/tiles/sources-nl-de.txt)
npm ci && npm run build   # → dist/, serve with deploy/Caddyfile (adjust paths)
```

## Verifying a build

```bash
npm run tiles:coverage -- path/to/pawpath-YYYYMMDD.pmtiles 52.3508 5.2647
```

prints features per layer and level around a point.
