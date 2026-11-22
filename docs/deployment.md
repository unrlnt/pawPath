# Deployment

PawPath deploys as **two containers from one repository** (CLAUDE.md §3):

| Service | Image target | Does |
|---|---|---|
| `web` | `Dockerfile` → `web` | Caddy serving the app and `/tiles/` from a shared volume. Nothing per request. |
| `tiles` | `Dockerfile` → `tiles` | Builds the map data from OpenStreetMap on first start, then rebuilds when it is older than 7 days. |

They share the `tiles` volume: `tiles` writes, `web` reads.

## Coolify (recommended)

Everything is in this repository; Coolify builds both images from the
`Dockerfile` and wires them with `docker-compose.yml`. No registry, no
secrets, no API keys.

### First deploy, step by step

1. **Choose the branch.** Coolify deploys one branch. Use `main` once the
   work is merged there (or point it at the development branch to try it).
2. **Coolify → Projects → your project → + New → Resource.** Pick
   **Public Repository** (works while the repo is public) or **Private
   Repository (with GitHub App)** — the GitHub App also gives you automatic
   deploys on every push.
3. Repository `unrlnt/dogWalkMap`, the branch from step 1.
   **Build Pack: Docker Compose**, Docker Compose location
   `/docker-compose.yml`. Continue.
4. **Domains:** Coolify lists the two services. Set your domain on **`web`**
   (e.g. `https://pawpath.example`), port 80 is implied. Leave `tiles`
   without a domain — it serves nothing.
5. **Environment variables** — none are required. The useful ones:

   | Variable | Default | Meaning |
   |---|---|---|
   | `TILE_REGIONS` | `nl-de` | A preset (`nl-de`, `planet`, `flevoland`) **or** any comma-separated list of [Geofabrik](https://download.geofabrik.de) region ids, e.g. `europe/netherlands,europe/germany,europe/belgium`. Changing it triggers a rebuild — this is the "which countries" switch. |
   | `JAVA_XMX` | `4g` | Planetiler heap. 4g is fine for NL+DE; use 8g–16g for the planet. |
   | `REBUILD_AFTER_DAYS` | `7` | Rebuild interval |
   | `VITE_MAP_STYLE_URL` | OpenFreeMap | Build-time basemap override (public value) |
   | `VITE_PHOTON_URL` | photon.komoot.io | Build-time search override, e.g. a self-hosted Photon |

6. **Deploy.** The images build in a few minutes. `web` is healthy within a
   minute and shows the basemap with the note *"The map data is still being
   prepared"*; `tiles` starts downloading right away.
7. **Watch the first build:** `tiles` service → **Logs**. For NL+DE expect
   `downloading` (two files, ~5.5 GB), `filtering`, `building`, `done` —
   typically 20–60 minutes, depending on the connection and CPU. Reload the
   site afterwards: shade, paths, benches and the route planner appear.

### Updates

Push to the deployed branch → Coolify rebuilds and restarts (automatic with
the GitHub App, otherwise press **Redeploy** or add Coolify's webhook to the
repo). The map data lives in the `tiles` volume and survives redeploys, so an
app update never triggers a tile rebuild. The tile file name changes with
every build and the app chunks are hashed, so visitors never mix old and new.

### Disk and memory

| | NL+DE (default) | Planet |
|---|---|---|
| `tiles-work`, while building | ~10 GB (largest download is Germany, ~4.3 GB) | ~70 GB (Europe download + filtered parts + Planetiler temp) |
| `tiles`, permanently | ~1–2 GB (two builds kept for a week) | ~10–15 GB per build, ×2 for a week |
| RAM | ~6 GB free (4 GB heap) | 16 GB+ recommended |

These are estimates scaled from the Flevoland test build (the routing layer
is most of the size); the first real build will tell. `tiles-work` is emptied
after each build. If the server cannot hold a planet build, build elsewhere
with `tools/tiles/build.sh` and copy the `.pmtiles` and `manifest.json` into
the `tiles` volume.

### Bathing sites

Each tile build also downloads the official EU bathing sites from the EEA
(`water.discomap.eea.europa.eu`, a few seconds, ~11 MB). If the EEA is down,
the previous copy in `tiles-work` is reused; the build never fails over it.

### Watching the builder

Coolify → `tiles` service → Logs. A build logs `[tiles …] downloading`,
`filtering`, `building`, `done`. A failed build logs
`build FAILED — keeping the previous tiles` and retries at the next check
(every 6 h); the site keeps serving the last good build meanwhile.

## Plain Docker Compose

```bash
docker compose up -d --build        # NL+DE by default
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
| `/tiles/water-warnings.json` | 5 minutes | empty `{"warnings": []}` written by the `tiles` container; no live source yet (`docs/water-warnings.md`) |
| `/tiles/.*` | 404 | in-progress builds and markers are hidden |
| `/healthz` | — | `ok`, used by the container health check |

Every response also carries `Content-Security-Policy` (scripts only from this
origin; connections and images to any https host, so basemap and search
overrides keep working), `Permissions-Policy` (location for this site only),
`X-Content-Type-Options` and `Referrer-Policy`.

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
