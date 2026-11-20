/**
 * The ~2 km query grid (CLAUDE.md §8).
 *
 * Viewports are snapped to whole tiles so that a query is reusable and
 * cacheable; raw bounding boxes are never queried. Pure and browser-free.
 *
 * The grid is equirectangular: a fixed latitude step, and a longitude step
 * widened by 1/cos(lat) per latitude band so tiles stay roughly square in
 * kilometres as you move away from the equator. The band index is part of the
 * tile id, so a tile id decodes back to its bounds without extra context.
 */

import { DEGREES_PER_KM_LAT, TILE_GRID_MAX_LATITUDE, TILE_SIZE_KM } from '../config';

export interface BBox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

export type TileId = string;

export interface TileCoords {
  readonly latIndex: number;
  readonly lngIndex: number;
}

/** Height of every tile, in degrees of latitude. */
export const TILE_LAT_STEP = TILE_SIZE_KM * DEGREES_PER_KM_LAT;

const clampLatitude = (lat: number): number =>
  Math.min(TILE_GRID_MAX_LATITUDE, Math.max(-TILE_GRID_MAX_LATITUDE, lat));

/** Longitude step for the band a given latitude index falls in. */
function lngStepForBand(latIndex: number): number {
  const bandCentreLat = clampLatitude((latIndex + 0.5) * TILE_LAT_STEP);
  const cos = Math.cos((bandCentreLat * Math.PI) / 180);
  const minCos = Math.cos((TILE_GRID_MAX_LATITUDE * Math.PI) / 180);
  return TILE_LAT_STEP / Math.max(cos, minCos);
}

export function tileCoordsFor(lat: number, lng: number): TileCoords {
  const latIndex = Math.floor(clampLatitude(lat) / TILE_LAT_STEP);
  const lngIndex = Math.floor(normaliseLongitude(lng) / lngStepForBand(latIndex));
  return { latIndex, lngIndex };
}

/**
 * Tile ids carry the grid size. If TILE_SIZE_KM is ever retuned, old cached
 * tiles simply stop matching instead of silently returning wrong bounds.
 */
export function formatTileId(coords: TileCoords): TileId {
  return `${TILE_SIZE_KM}km:${coords.latIndex}:${coords.lngIndex}`;
}

export function tileIdFor(lat: number, lng: number): TileId {
  return formatTileId(tileCoordsFor(lat, lng));
}

export function parseTileId(tileId: TileId): TileCoords | undefined {
  const parts = tileId.split(':');
  if (parts.length !== 3 || parts[0] !== `${TILE_SIZE_KM}km`) return undefined;
  const latIndex = Number(parts[1]);
  const lngIndex = Number(parts[2]);
  if (!Number.isInteger(latIndex) || !Number.isInteger(lngIndex)) return undefined;
  return { latIndex, lngIndex };
}

export function tileBoundsFor(coords: TileCoords): BBox {
  const lngStep = lngStepForBand(coords.latIndex);
  return {
    south: coords.latIndex * TILE_LAT_STEP,
    north: (coords.latIndex + 1) * TILE_LAT_STEP,
    west: coords.lngIndex * lngStep,
    east: (coords.lngIndex + 1) * lngStep,
  };
}

/** Bounds of a tile id, or undefined if the id is malformed or from another grid. */
export function boundsForTileId(tileId: TileId): BBox | undefined {
  const coords = parseTileId(tileId);
  return coords === undefined ? undefined : tileBoundsFor(coords);
}

/**
 * Splits a bounding box at the antimeridian.
 *
 * A viewport panned across ±180° arrives with `west > east` (e.g. west 179,
 * east -179). Treated naively that reads as a box spanning almost the entire
 * planet, and the tile loop would try to cover the whole world. Splitting it
 * into two boxes keeps every downstream calculation ordinary.
 */
export function splitAtAntimeridian(bbox: BBox): BBox[] {
  const west = normaliseLongitude(bbox.west);
  const east = normaliseLongitude(bbox.east);
  if (west <= east) return [{ ...bbox, west, east }];
  return [
    { ...bbox, west, east: 180 },
    { ...bbox, west: -180, east },
  ];
}

/**
 * Every tile covering a bounding box, antimeridian included.
 *
 * Latitude is clamped to the grid's usable range, so a viewport that includes a
 * pole yields the top band rather than an unbounded loop.
 */
export function tilesCovering(bbox: BBox): TileId[] {
  const ids: TileId[] = [];
  const seen = new Set<TileId>();

  for (const part of splitAtAntimeridian(bbox)) {
    const southIndex = tileCoordsFor(Math.min(part.south, part.north), part.west).latIndex;
    const northIndex = tileCoordsFor(Math.max(part.south, part.north), part.west).latIndex;

    for (let latIndex = southIndex; latIndex <= northIndex; latIndex += 1) {
      const lngStep = lngStepForBand(latIndex);
      const westIndex = Math.floor(part.west / lngStep);
      const eastIndex = Math.floor(part.east / lngStep);
      for (let lngIndex = westIndex; lngIndex <= eastIndex; lngIndex += 1) {
        const id = formatTileId({ latIndex, lngIndex });
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    }
  }

  return ids;
}

/**
 * Smallest bounding box containing every given tile.
 *
 * Used to collapse a viewport's worth of uncached tiles into ONE Overpass
 * query. The rectangle may cover tiles we already hold — that is accepted: the
 * alternative is one bbox filter per tile, which for the shade layer alone is
 * ~10 statements × 9 tiles, and the extra area is bounded by the viewport
 * because tiles come from a contiguous grid.
 *
 * Returns undefined if no tile id is usable.
 */
export function boundingBoxOfTiles(tileIds: readonly TileId[]): BBox | undefined {
  let south = Number.POSITIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let found = false;

  for (const tileId of tileIds) {
    const bounds = boundsForTileId(tileId);
    if (bounds === undefined) continue;
    found = true;
    south = Math.min(south, bounds.south);
    west = Math.min(west, bounds.west);
    north = Math.max(north, bounds.north);
    east = Math.max(east, bounds.east);
  }

  return found ? { south, west, north, east } : undefined;
}

/** Great-circle-ish distance in km. Good enough for ordering tiles. */
function approximateDistanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const latKm = (a.lat - b.lat) / DEGREES_PER_KM_LAT;
  const midLat = clampLatitude((a.lat + b.lat) / 2);
  const lngKm =
    ((a.lng - b.lng) / DEGREES_PER_KM_LAT) * Math.cos((midLat * Math.PI) / 180);
  return Math.hypot(latKm, lngKm);
}

/** Centre point of a tile. */
export function tileCentre(tileId: TileId): { lat: number; lng: number } | undefined {
  const bounds = boundsForTileId(tileId);
  if (bounds === undefined) return undefined;
  return {
    lat: (bounds.north + bounds.south) / 2,
    lng: (bounds.east + bounds.west) / 2,
  };
}

export interface ViewportTiles {
  /** Tiles to fetch, nearest the centre first. */
  readonly tileIds: readonly TileId[];
  /** True when the cap trimmed the list, so coverage is deliberately partial. */
  readonly capped: boolean;
  /** How many tiles the viewport actually needs. */
  readonly totalTiles: number;
}

/**
 * Tiles for a viewport, ordered centre-outward and capped.
 *
 * Two deliberate behaviours:
 *  - **Centre-first ordering.** With one request in flight at a time, order is
 *    what the user experiences: data appears where they are looking first.
 *  - **A hard cap.** A zoomed-out viewport can span hundreds of tiles. Firing
 *    all of them would be rate limited anyway and would violate the usage
 *    policy; instead we fetch the centre-most `maxTiles` and tell the user
 *    coverage is partial.
 */
export function tilesForViewport(
  bbox: BBox,
  centre: { lat: number; lng: number },
  maxTiles: number,
): ViewportTiles {
  const all = tilesCovering(bbox);
  const ordered = all
    .map((tileId) => {
      const tileMiddle = tileCentre(tileId);
      return {
        tileId,
        distance: tileMiddle === undefined ? Number.POSITIVE_INFINITY : approximateDistanceKm(tileMiddle, centre),
      };
    })
    .sort((a, b) => a.distance - b.distance || a.tileId.localeCompare(b.tileId))
    .map((entry) => entry.tileId);

  return {
    tileIds: ordered.slice(0, Math.max(0, maxTiles)),
    capped: ordered.length > maxTiles,
    totalTiles: ordered.length,
  };
}

/**
 * Wraps a longitude into [-180, 180).
 *
 * Values already in range are returned untouched: the modulo round-trip
 * introduces float drift (179.98 becomes 179.98000000000002), which is enough
 * to shift a tile index at a boundary.
 */
export function normaliseLongitude(lng: number): number {
  if (lng >= -180 && lng < 180) return lng;
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * Square bounding box of a given radius around a point. Used by the recon page,
 * which works in radii rather than tiles.
 */
export function bboxAround(lat: number, lng: number, radiusKm: number): BBox {
  const latDelta = radiusKm * DEGREES_PER_KM_LAT;
  const cos = Math.cos((clampLatitude(lat) * Math.PI) / 180);
  const minCos = Math.cos((TILE_GRID_MAX_LATITUDE * Math.PI) / 180);
  const lngDelta = latDelta / Math.max(cos, minCos);
  return {
    south: Math.max(-90, lat - latDelta),
    north: Math.min(90, lat + latDelta),
    west: lng - lngDelta,
    east: lng + lngDelta,
  };
}

/** Approximate area of a bounding box in km². Used for feature-density maths. */
export function bboxAreaKm2(bbox: BBox): number {
  const heightKm = (bbox.north - bbox.south) / DEGREES_PER_KM_LAT;
  const midLat = (bbox.north + bbox.south) / 2;
  const widthKm =
    ((bbox.east - bbox.west) / DEGREES_PER_KM_LAT) *
    Math.cos((clampLatitude(midLat) * Math.PI) / 180);
  return Math.abs(heightKm * widthKm);
}
