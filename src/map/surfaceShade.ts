/**
 * Shade per path on the map (closes the Phase 5 stretch goal for the map
 * itself; routes have had it since Phase 9b). Uses the same lookup as the
 * route planner: each loaded `surface` path is tested against the `shade`
 * features of the loaded tiles, and the result goes into the feature's
 * state, which the paint expression reads. No re-fetch, no server.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

import { ROUTE_SHADE_SIDE_REACH_M, ROUTE_TREE_ROW_REACH_M } from '../config';
import {
  makeShadeLookup,
  SHADE_RANK,
  stretchShade,
  type ShadeArea,
  type ShadeLevel,
  type ShadeLine,
} from '../lib/routing/shade';
import { PAWPATH_SOURCE_ID } from './pawpathLayers';

type Pt = [number, number];

/** Same scale as the routing grid: z14 tiles of 4096 units. */
const WORLD = 2 ** 14 * 4096;
const toGrid = ([lng, lat]: number[]): Pt => {
  const rad = ((lat ?? 0) * Math.PI) / 180;
  return [(((lng ?? 0) + 180) / 360) * WORLD, ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * WORLD];
};
const unitsPerMetre = (lat: number): number => WORLD / (40_075_016.686 * Math.cos((lat * Math.PI) / 180));

const isShadeLevel = (v: unknown): v is ShadeLevel => v === 'dense' || v === 'medium' || v === 'light';

/** Lines of a GeoJSON line or multi-line geometry, in grid units. */
function linesOf(geometry: GeoJSON.Geometry): Pt[][] {
  if (geometry.type === 'LineString') return [geometry.coordinates.map(toGrid)];
  if (geometry.type === 'MultiLineString') return geometry.coordinates.map((l) => l.map(toGrid));
  return [];
}

/**
 * Sets feature-state `shade` (a ShadeLevel, or 'sun') on every loaded path
 * not seen before. A path counts as shaded when at least half its length is,
 * at the level covering most of it. Returns how many paths were annotated.
 */
export function annotateSurfaceShade(map: MapLibreMap, seen: Set<string | number>): number {
  const paths = map.querySourceFeatures(PAWPATH_SOURCE_ID, { sourceLayer: 'surface' });
  const fresh = paths.filter((f) => f.id !== undefined && !seen.has(f.id));
  if (fresh.length === 0) return 0;

  const areas: ShadeArea[] = [];
  const rows: ShadeLine[] = [];
  for (const f of map.querySourceFeatures(PAWPATH_SOURCE_ID, { sourceLayer: 'shade' })) {
    const level = f.properties['level'];
    if (!isShadeLevel(level)) continue;
    const g = f.geometry;
    if (g.type === 'Polygon') areas.push({ level, rings: g.coordinates.map((r) => r.map(toGrid)) });
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) areas.push({ level, rings: poly.map((r) => r.map(toGrid)) });
    else for (const points of linesOf(g)) rows.push({ level, points });
  }
  const lat = map.getCenter().lat;
  const perMetre = unitsPerMetre(lat);
  const lookup = makeShadeLookup(areas, rows, ROUTE_TREE_ROW_REACH_M * perMetre);
  const sideReach = ROUTE_SHADE_SIDE_REACH_M * perMetre;

  // A path may come in several tile pieces with one id: add their lengths up.
  const byId = new Map<string | number, { total: number; shaded: Record<ShadeLevel, number> }>();
  for (const f of fresh) {
    const id = f.id as string | number;
    const acc = byId.get(id) ?? { total: 0, shaded: { dense: 0, medium: 0, light: 0 } };
    for (const line of linesOf(f.geometry)) {
      for (let i = 1; i < line.length; i += 1) {
        const a = line[i - 1] as Pt;
        const b = line[i] as Pt;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        acc.total += len;
        const level = stretchShade(lookup, a, b, sideReach);
        if (level !== undefined) acc.shaded[level] += len;
      }
    }
    byId.set(id, acc);
  }

  for (const [id, acc] of byId) {
    seen.add(id);
    const shadedTotal = acc.shaded.dense + acc.shaded.medium + acc.shaded.light;
    let shade: ShadeLevel | 'sun' = 'sun';
    if (acc.total > 0 && shadedTotal >= acc.total / 2) {
      // The level covering most of it; on a tie, the lighter (safer) one.
      shade = (['light', 'medium', 'dense'] as const).reduce((best, level) =>
        acc.shaded[level] > acc.shaded[best] ? level : best,
      );
      if (SHADE_RANK[shade] === undefined) shade = 'sun';
    }
    map.setFeatureState({ source: PAWPATH_SOURCE_ID, sourceLayer: 'surface', id }, { shade });
  }
  return byId.size;
}
