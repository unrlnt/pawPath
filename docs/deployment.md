# Deployment

PawPath is three kinds of static file on one server, with Cloudflare's free
proxy in front (CLAUDE.md §3):

| Path | What | Cache |
|---|---|---|
| `/` | the SPA (`npm run build` → `dist/`) | `index.html` short, `/assets/*` immutable |
| `/tiles/manifest.json` | names the current tile file | 5 minutes |
| `/tiles/pawpath-YYYYMMDD.pmtiles` | our vector tiles | immutable (new name per build) |

Nothing runs per request. The only scheduled job is the weekly tile build.

## 1. Server prerequisites

```bash
sudo apt-get install -y openjdk-21-jre-headless osmium-tool caddy
# Node 22+ for the build scripts:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs
sudo git clone https://github.com/unrlnt/dogwalkmap /opt/pawpath   # once public
cd /opt/pawpath && npm ci
```

## 2. Weekly tile build

```bash
# NL + DE first (≈ 5 GB download, minutes):
WORK_DIR=/var/tmp/pawpath tools/tiles/build.sh /srv/pawpath/www/tiles $(cat tools/tiles/sources-nl-de.txt)

# Whole planet, one region at a time:
WORK_DIR=/var/tmp/pawpath JAVA_XMX=6g \
  tools/tiles/build.sh /srv/pawpath/www/tiles $(cat tools/tiles/sources-planet.txt)
```

**Disk:** regions are downloaded, filtered and deleted one at a time, so the
peak is the largest region (Europe, ~35 GB) plus the filtered parts and
Planetiler's temp files — budget **~50 GB of temporary space**. Afterwards only
the `.pmtiles` remains (size to be measured on the first planet build).
`WORK_DIR` can point at any disk with room; it is emptied at the end.

**RAM:** Planetiler on the filtered planet should fit in a few GB; raise
`JAVA_XMX` if it reports memory pressure.

Cron (Monday 03:17):

```cron
17 3 * * 1  cd /opt/pawpath && git pull -q && npm ci --silent && WORK_DIR=/var/tmp/pawpath JAVA_XMX=6g tools/tiles/build.sh /srv/pawpath/www/tiles $(cat tools/tiles/sources-planet.txt) >> /var/log/pawpath-tiles.log 2>&1
```

The script keeps the previous `.pmtiles` for a week, so a browser holding an
older manifest still finds its file.

## 3. The app

```bash
npm run build
rsync -a --delete --exclude tiles/ dist/ /srv/pawpath/www/
```

(`--exclude tiles/` keeps a locally built dev tile set out of production.)

## 4. Caddy

```caddy
pawpath.example.org {
	root * /srv/pawpath/www
	encode zstd gzip

	@immutable path /assets/* /tiles/*.pmtiles
	header @immutable Cache-Control "public, max-age=31536000, immutable"
	header /tiles/manifest.json Cache-Control "public, max-age=300"
	header /index.html Cache-Control "public, max-age=300"

	try_files {path} /index.html
	file_server
}
```

Caddy answers HTTP range requests out of the box, which is all the browser's
pmtiles reader needs.

## 5. Cloudflare (free plan)

- Proxy the DNS record (orange cloud) and set SSL to **Full (strict)**.
- Static assets are cached at the edge by default.
- **Range requests on a large `.pmtiles`:** Cloudflare's free plan only caches
  files up to 512 MB, so range requests on a bigger planet file pass through to
  the server. Caddy serves those cheaply (sendfile), so start like this. If the
  server load ever matters, switch to `pmtiles serve` behind Caddy, which turns
  the archive into individual `/{z}/{x}/{y}.mvt` tiles that Cloudflare caches
  one by one (add a Cache Rule for `/tiles/*`), and point the manifest at that
  URL.

## Verifying a build

```bash
npm run tiles:coverage -- /srv/pawpath/www/tiles/pawpath-YYYYMMDD.pmtiles 52.3508 5.2647
```

prints features per layer and level around a point — paste the table into
CLAUDE.md §12 when something changes.
