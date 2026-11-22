/**
 * Loads the routing graph (Phase 9) from the same `.pmtiles` the map draws:
 * the z14 `walk` layer around the waypoints, decoded into grid lines and
 * stitched into one graph. No server compute — a route costs a few cached
 * range requests.
 *
 * Coordinates stay integers on the global z14 grid (tileX × extent + x), so a
 * vertex shared by two tiles has exactly the same key in both.
 */

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader as Pbf } from 'pbf';
import { PMTiles, type Source } from 'pmtiles';

import { ROUTE_MAX_TILES, ROUTE_TILE_MARGIN_M } from '../../config';
import { buildGraph, type GridLine, type Tags, type WalkGraph } from '../../lib/routing/graph';
import type { LngLat } from '../../lib/routing/route';
import { WALK_GRAPH_ZOOM, WALK_LAYER } from '../walkGraph';

/** Decodes one tile's `walk` layer into lines on the global grid. */
export function walkLinesFromTile(bytes: Uint8Array, x: number, y: number): { lines: GridLine[]; extent: number } {
  const layer = new VectorTile(new Pbf(bytes)).layers[WALK_LAYER];
  if (layer === undefined) return { lines: [], extent: 4096 };
  const { extent } = layer;
  const lines: GridLine[] = [];
  for (let i = 0; i < layer.length; i += 1) {
    const feature = layer.feature(i);
    if (feature.type !== 2) continue; // lines only
    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(feature.properties)) tags[key] = String(value);
    for (const ring of feature.loadGeometry()) {
      if (ring.length < 2) continue;
      lines.push({ points: ring.map((p) => [x * extent + p.x, y * extent + p.y] as [number, number]), tags: tags as Tags });
    }
  }
  return { lines, extent };
}

const lngToX = (lng: number, n: number): number => Math.floor(((lng + 180) / 360) * n);
const latToY = (lat: number, n: number): number => {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
};

/** z14 tiles covering the points plus a margin, nearest-first; undefined if too many. */
export function graphTilesFor(points: readonly LngLat[]): [number, number][] | undefined {
  if (points.length === 0) return [];
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLat = ROUTE_TILE_MARGIN_M / 111_320;
  const dLng = dLat / Math.cos((midLat * Math.PI) / 180);
  const n = 2 ** WALK_GRAPH_ZOOM;
  const xMin = lngToX(Math.min(...lngs) - dLng, n);
  const xMax = lngToX(Math.max(...lngs) + dLng, n);
  const yMin = latToY(Math.max(...lats) + dLat, n);
  const yMax = latToY(Math.min(...lats) - dLat, n);
  if ((xMax - xMin + 1) * (yMax - yMin + 1) > ROUTE_MAX_TILES) return undefined;
  const tiles: [number, number][] = [];
  for (let x = xMin; x <= xMax; x += 1) for (let y = yMin; y <= yMax; y += 1) tiles.push([x, y]);
  return tiles;
}

export type GraphOutcome =
  | { readonly ok: true; readonly graph: WalkGraph }
  | { readonly ok: false; readonly reason: 'tooFar' | 'unavailable' };

/**
 * Keeps decoded tiles in memory, so dragging a waypoint re-routes without
 * touching the network. One instance per tile file.
 */
export class WalkGraphSource {
  private readonly archive: PMTiles;
  private readonly tiles = new Map<string, Promise<{ lines: GridLine[]; extent: number }>>();

  constructor(source: string | Source) {
    this.archive = new PMTiles(source);
  }

  private tile(x: number, y: number): Promise<{ lines: GridLine[]; extent: number }> {
    const key = `${x}/${y}`;
    let pending = this.tiles.get(key);
    if (pending === undefined) {
      pending = this.archive.getZxy(WALK_GRAPH_ZOOM, x, y).then((response) =>
        response === undefined ? { lines: [], extent: 4096 } : walkLinesFromTile(new Uint8Array(response.data), x, y),
      );
      // A failed fetch must not poison the cache: forget it so a retry refetches.
      pending.catch(() => this.tiles.delete(key));
      this.tiles.set(key, pending);
    }
    return pending;
  }

  async graphAround(points: readonly LngLat[]): Promise<GraphOutcome> {
    const tiles = graphTilesFor(points);
    if (tiles === undefined) return { ok: false, reason: 'tooFar' };
    try {
      const decoded = await Promise.all(tiles.map(([x, y]) => this.tile(x, y)));
      const extent = decoded.find((d) => d.lines.length > 0)?.extent ?? 4096;
      return { ok: true, graph: buildGraph(decoded.flatMap((d) => d.lines), WALK_GRAPH_ZOOM, extent) };
    } catch (cause) {
      console.warn('[route] graph tiles failed', cause);
      return { ok: false, reason: 'unavailable' };
    }
  }
}
