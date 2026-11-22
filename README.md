# PawPath

A free, no-login map for planning today's dog walk: paths that are kind to
paws right now, shade, off-leash areas, official bathing spots, benches, bins,
bag dispensers, drinking water, live conditions — and a route planner that
prefers cool surfaces and shade in the heat. Routes save on your device and
share as a link; there are no accounts and nothing is tracked.

`CLAUDE.md` is the spec and the source of truth. Read it before changing
anything.

## How it works

The map data is **OpenStreetMap**, pre-processed once a week into our own
vector tiles (`pawpath-YYYYMMDD.pmtiles`) and served as a static file. The
browser loads only the tiles it looks at. There is no backend and no API key.

```
src/data/layers.ts          the ONE definition of every layer, tag and level
  └─ tools/tiles/generateSchema.ts → pawpath.schema.yml (Planetiler)
       └─ tools/tiles/build.sh     → public/tiles/pawpath-*.pmtiles + manifest.json
```

## Running locally

```bash
npm install
# Build a small tile set once (needs java 21 + osmium-tool), e.g. Flevoland:
curl -o data/flevoland.osm.pbf https://download.geofabrik.de/europe/netherlands/flevoland-latest.osm.pbf
npm run tiles:build -- public/tiles data/flevoland.osm.pbf
npm run dev          # http://localhost:5173
```

```bash
npm run typecheck    # tsc --noEmit, strict (app + tools)
npm test             # vitest — includes the shared layer examples
npm run tiles:verify # the same examples, run by Planetiler against the schema
npm run tiles:coverage -- public/tiles/pawpath-YYYYMMDD.pmtiles 52.3508 5.2647
npm run build        # static bundle into dist/
```

Changing a layer: edit `src/data/layers.ts`, add a case to
`src/data/layerExamples.ts`, run `npm run tiles:schema`, rebuild the tiles.
A test fails if the schema is stale.

Deployment: two containers via `docker-compose.yml` — made for Coolify, works
with plain Docker. See [docs/deployment.md](docs/deployment.md).

## Attribution

Map data © OpenStreetMap contributors, ODbL. Basemap © OpenFreeMap /
OpenMapTiles. Bathing sites © European Environment Agency. Weather data by
Open-Meteo.com (CC BY 4.0). Place search by
Photon. Attribution is a licence requirement and
stays visible on the map.
