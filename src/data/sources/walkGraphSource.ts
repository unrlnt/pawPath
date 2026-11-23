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

import { ROUTE_MAX_TILES, ROUTE_SHADE_SIDE_REACH_M, ROUTE_TILE_MARGIN_M, ROUTE_TREE_ROW_REACH_M } from '../../config';
import { buildGraph, gridToLngLat, type GridLine, type Tags, type WalkGraph } from '../../lib/routing/graph';
import type { Poi, PoiKind } from '../../lib/routing/stops';
import { makeShadeLookup, type ShadeArea, type ShadeLevel, type ShadeLine } from '../../lib/routing/shade';
import type { LngLat } from '../../lib/routing/route';
import { WALK_GRAPH_ZOOM, WALK_LAYER } from '../walkGraph';

const SHADE_LAYER = 'shade';

export interface DecodedTile {
  readonly lines: GridLine[];
  readonly shadeAreas: ShadeArea[];
  readonly shadeLines: ShadeLine[];
  /** Benches, bins, dispensers and taps — for "add a stop". */
  readonly pois: Poi[];
  readonly extent: number;
}

/** Tile layer (and level) → the planner's amenity kind. */
function poiKind(layer: string, level: unknown): PoiKind | undefined {
  if (layer === 'benches') return 'bench';
  if (layer === 'drinkingWater') return 'water';
  if (layer === 'waste') return level === 'dog_bin' ? 'dogBin' : level === 'bag_dispenser' ? 'bagDispenser' : 'bin';
  return undefined;
}
const POI_LAYERS = ['benches', 'waste', 'drinkingWater'] as const;

const EMPTY_TILE: DecodedTile = { lines: [], shadeAreas: [], shadeLines: [], pois: [], extent: 4096 };

const isShadeLevel = (value: unknown): value is ShadeLevel => value === 'dense' || value === 'medium' || value === 'light';

/**
 * Decodes one tile's `walk` layer into lines, and its `shade` layer into
 * areas and tree rows, all on the global grid.
 */
export function decodeRoutingTile(bytes: Uint8Array, x: number, y: number): DecodedTile {
  const layers = new VectorTile(new Pbf(bytes)).layers;
  const walk = layers[WALK_LAYER];
  const extent = walk?.extent ?? 4096;
  const toGrid = (layerExtent: number) => (p: { x: number; y: number }): [number, number] => [
    x * layerExtent + p.x,
    y * layerExtent + p.y,
  ];

  const lines: GridLine[] = [];
  if (walk !== undefined) {
    const grid = toGrid(walk.extent);
    for (let i = 0; i < walk.length; i += 1) {
      const feature = walk.feature(i);
      if (feature.type !== 2) continue; // lines only
      const tags: Record<string, string> = {};
      for (const [key, value] of Object.entries(feature.properties)) tags[key] = String(value);
      for (const ring of feature.loadGeometry()) {
        if (ring.length >= 2) lines.push({ points: ring.map(grid), tags: tags as Tags });
      }
    }
  }

  const shadeAreas: ShadeArea[] = [];
  const shadeLines: ShadeLine[] = [];
  const shade = layers[SHADE_LAYER];
  if (shade !== undefined) {
    // Shade must share the walk layer's grid; Planetiler writes one extent.
    const grid = toGrid(shade.extent);
    for (let i = 0; i < shade.length; i += 1) {
      const feature = shade.feature(i);
      const level = feature.properties['level'];
      if (!isShadeLevel(level)) continue;
      const geometry = feature.loadGeometry().map((ring) => ring.map(grid));
      if (feature.type === 3) shadeAreas.push({ level, rings: geometry });
      else if (feature.type === 2) for (const points of geometry) shadeLines.push({ level, points });
    }
  }
  const pois: Poi[] = [];
  for (const name of POI_LAYERS) {
    const layer = layers[name];
    if (layer === undefined) continue;
    for (let i = 0; i < layer.length; i += 1) {
      const feature = layer.feature(i);
      const kind = poiKind(name, feature.properties['level']);
      const p = feature.loadGeometry()[0]?.[0];
      if (kind === undefined || p === undefined) continue;
      // Points outside the tile proper are the neighbour's (tile buffer).
      if (p.x < 0 || p.y < 0 || p.x >= layer.extent || p.y >= layer.extent) continue;
      pois.push({ kind, at: gridToLngLat(x * layer.extent + p.x, y * layer.extent + p.y, WALK_GRAPH_ZOOM, layer.extent) });
    }
  }
  return { lines, shadeAreas, shadeLines, pois, extent };
}

/** Grid units per metre at a z14 tile row (Web Mercator scale grows with latitude). */
function unitsPerMetre(tileY: number, extent: number): number {
  const n = 2 ** WALK_GRAPH_ZOOM;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tileY + 0.5)) / n)));
  return (n * extent) / (40_075_016.686 * Math.cos(lat));
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
  | { readonly ok: true; readonly graph: WalkGraph; readonly pois: readonly Poi[] }
  | { readonly ok: false; readonly reason: 'tooFar' | 'unavailable' };

/**
 * Keeps decoded tiles in memory, so dragging a waypoint re-routes without
 * touching the network. One instance per tile file.
 */
export class WalkGraphSource {
  private readonly archive: PMTiles;
  private readonly tiles = new Map<string, Promise<DecodedTile>>();

  constructor(source: string | Source) {
    this.archive = new PMTiles(source);
  }

  private tile(x: number, y: number): Promise<DecodedTile> {
    const key = `${x}/${y}`;
    let pending = this.tiles.get(key);
    if (pending === undefined) {
      pending = this.archive.getZxy(WALK_GRAPH_ZOOM, x, y).then((response) =>
        response === undefined ? EMPTY_TILE : decodeRoutingTile(new Uint8Array(response.data), x, y),
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
      const midTileY = tiles[Math.floor(tiles.length / 2)]?.[1] ?? 0;
      const perMetre = unitsPerMetre(midTileY, extent);
      const shade = {
        at: makeShadeLookup(
          decoded.flatMap((d) => d.shadeAreas),
          decoded.flatMap((d) => d.shadeLines),
          ROUTE_TREE_ROW_REACH_M * perMetre,
        ),
        sideReach: ROUTE_SHADE_SIDE_REACH_M * perMetre,
      };
      return {
        ok: true,
        graph: buildGraph(decoded.flatMap((d) => d.lines), WALK_GRAPH_ZOOM, extent, shade),
        pois: decoded.flatMap((d) => d.pois),
      };
    } catch (cause) {
      console.warn('[route] graph tiles failed', cause);
      return { ok: false, reason: 'unavailable' };
    }
  }
}
