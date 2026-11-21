/**
 * Coverage stats from a built .pmtiles file — replaces the Overpass recon page.
 *
 *   npx tsx tools/tiles/coverage.ts FILE.pmtiles LAT LNG [RADIUS_KM=2] [ZOOM=14]
 *   npx tsx tools/tiles/coverage.ts public/tiles/pawpath-20261121.pmtiles 52.3508 5.2647
 *
 * Prints features per layer and level, and per km², in the square around the
 * point, as a Markdown table ready to paste into CLAUDE.md §12. Features split
 * across tile edges are counted once when Planetiler gave them an id, and per
 * tile otherwise (the table says which).
 */

import { open } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader as Pbf } from 'pbf';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';

import { ALL_LAYERS } from '../../src/data/layers';

/** Reads byte ranges from a local file, which is all PMTiles needs. */
class FileSource implements Source {
  constructor(private readonly path: string) {}

  getKey(): string {
    return this.path;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const handle = await open(this.path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead);
      return { data };
    } finally {
      await handle.close();
    }
  }
}

const KM_PER_DEGREE_LAT = 111.32;

function tileRange(lat: number, lng: number, radiusKm: number, zoom: number) {
  const dLat = radiusKm / KM_PER_DEGREE_LAT;
  const dLng = radiusKm / (KM_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  const n = 2 ** zoom;
  const x = (lon: number): number => Math.floor(((lon + 180) / 360) * n);
  const y = (la: number): number => {
    const rad = (la * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  };
  return {
    xMin: x(lng - dLng),
    xMax: x(lng + dLng),
    yMin: y(lat + dLat),
    yMax: y(lat - dLat),
  };
}

async function main(): Promise<void> {
  const [file, latArg, lngArg, radiusArg = '2', zoomArg = '14'] = process.argv.slice(2);
  if (file === undefined || latArg === undefined || lngArg === undefined) {
    console.error('usage: coverage.ts FILE.pmtiles LAT LNG [RADIUS_KM=2] [ZOOM=14]');
    process.exit(64);
  }
  const lat = Number(latArg);
  const lng = Number(lngArg);
  const radiusKm = Number(radiusArg);
  const zoom = Number(zoomArg);

  const archive = new PMTiles(new FileSource(file));
  const { xMin, xMax, yMin, yMax } = tileRange(lat, lng, radiusKm, zoom);
  // Counts cover whole tiles, so density is per area of the tiles read — not
  // of the requested square, which would overstate it.
  const tileSideKm = (40_075 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  const areaKm2 = (xMax - xMin + 1) * (yMax - yMin + 1) * tileSideKm ** 2;

  /** layer → level → distinct ids (or per-tile counts when ids are absent) */
  const seen = new Map<string, Map<string, Set<string>>>();
  let tiles = 0;
  let unidentified = 0;

  for (let x = xMin; x <= xMax; x += 1) {
    for (let y = yMin; y <= yMax; y += 1) {
      const tile = await archive.getZxy(zoom, x, y);
      if (tile === undefined) continue;
      tiles += 1;
      let bytes = new Uint8Array(tile.data);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
      const vt = new VectorTile(new Pbf(bytes));
      for (const [layerName, layer] of Object.entries(vt.layers)) {
        for (let i = 0; i < layer.length; i += 1) {
          const feature = layer.feature(i);
          const level = String(feature.properties['level'] ?? '—');
          const id =
            feature.id === undefined ? `${x}/${y}/${i}` : `${feature.type}:${feature.id}`;
          if (feature.id === undefined) unidentified += 1;
          const byLevel = seen.get(layerName) ?? new Map<string, Set<string>>();
          const ids = byLevel.get(level) ?? new Set<string>();
          ids.add(id);
          byLevel.set(level, ids);
          seen.set(layerName, byLevel);
        }
      }
    }
  }

  console.log(`## ${lat}, ${lng} · r=${radiusKm} km · ${areaKm2.toFixed(1)} km² · z${zoom} · ${tiles} tiles`);
  console.log(`Source: ${file}\n`);
  console.log('| Layer | Level | Features | Per km² |');
  console.log('|---|---|---:|---:|');
  for (const layer of ALL_LAYERS) {
    const byLevel = seen.get(layer.key);
    if (byLevel === undefined) {
      console.log(`| ${layer.label} | — | 0 | 0.00 |`);
      continue;
    }
    let total = 0;
    for (const [level, ids] of [...byLevel].sort()) {
      total += ids.size;
      console.log(`| ${layer.label} | ${level} | ${ids.size} | ${(ids.size / areaKm2).toFixed(2)} |`);
    }
    console.log(`| **${layer.label}** | **total** | **${total}** | **${(total / areaKm2).toFixed(2)}** |`);
  }
  if (unidentified > 0) {
    console.log(`\n${unidentified} features had no id and were counted per tile (edge-split polygons may count twice).`);
  }
}

void main();
