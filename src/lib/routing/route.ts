/**
 * Route through an ordered list of waypoints, plus the profile the planner
 * shows: distance, time, and how much of it is hot, paved or unpaved now.
 */

import { ROUTE_MAX_SNAP_M as MAX_SNAP_M, ROUTE_WALK_KMH as DOG_WALK_KMH } from '../../config';
import type { PawBand } from '../conditions/paw';
import { PAVED_KINDS, surfaceKindFor } from '../surface';
import { astar } from './astar';
import { edgeFactor, type CostContext } from './cost';
import { nearestNode, type GraphEdge, type WalkGraph } from './graph';

export type LngLat = readonly [number, number];


export interface RouteProfile {
  readonly lengthM: number;
  readonly minutes: number;
  /** Metres per live paw band (only edges with a known surface). */
  readonly byBand: Readonly<Record<PawBand, number>>;
  readonly pavedM: number;
  readonly unpavedM: number;
  readonly unknownSurfaceM: number;
  /** Metres under any shade (forest, scrub, tree rows), and in dense shade. */
  readonly shadeM: number;
  readonly denseShadeM: number;
  /** False when routed without weather: `byBand` is then empty. */
  readonly heatKnown: boolean;
}

export interface RouteSegment {
  readonly coords: readonly LngLat[];
  /** Live band of this stretch, or undefined when its surface is not mapped. */
  readonly band: PawBand | undefined;
  /** Whether this stretch runs through shade. */
  readonly shaded: boolean;
}

export type RouteResult =
  | {
      readonly ok: true;
      readonly line: readonly LngLat[];
      readonly segments: readonly RouteSegment[];
      readonly profile: RouteProfile;
      /** Waypoints moved onto the nearest path. */
      readonly snapped: readonly LngLat[];
    }
  | { readonly ok: false; readonly reason: 'tooFew' | 'offNetwork' | 'noPath'; readonly waypointIndex?: number };

function bandOf(edge: GraphEdge, context: CostContext): PawBand | undefined {
  const kind = surfaceKindFor(edge.tags['surface']);
  return kind === undefined || context.pawBands === undefined ? undefined : context.pawBands[edge.shade ?? 'sun'][kind];
}

export function planRoute(graph: WalkGraph, waypoints: readonly LngLat[], context: CostContext = {}): RouteResult {
  if (waypoints.length < 2) return { ok: false, reason: 'tooFew' };
  const nodes: number[] = [];
  for (const [i, wp] of waypoints.entries()) {
    const nearest = nearestNode(graph, wp, MAX_SNAP_M);
    if (nearest === undefined || nearest.distanceM > MAX_SNAP_M) return { ok: false, reason: 'offNetwork', waypointIndex: i };
    nodes.push(nearest.node);
  }

  const cost = (edge: GraphEdge): number => edge.lengthM * edgeFactor(edge.tags, context, edge.shade);
  const line: LngLat[] = [];
  const segments: RouteSegment[] = [];
  const byBand: Record<PawBand, number> = { fine: 0, caution: 0, danger: 0 };
  let lengthM = 0;
  let pavedM = 0;
  let unpavedM = 0;
  let unknownSurfaceM = 0;
  let shadeM = 0;
  let denseShadeM = 0;

  for (let i = 1; i < nodes.length; i += 1) {
    const from = nodes[i - 1];
    const to = nodes[i];
    if (from === undefined || to === undefined) continue;
    if (from === to) continue;
    const path = astar(graph, from, to, cost);
    if (path === undefined) return { ok: false, reason: 'noPath', waypointIndex: i };
    path.nodes.forEach((n, k) => {
      const c = graph.coords[n];
      if (c !== undefined && (k > 0 || line.length === 0)) line.push(c);
    });
    path.edges.forEach((edge, k) => {
      const a = graph.coords[path.nodes[k] ?? -1];
      const b = graph.coords[edge.to];
      if (a === undefined || b === undefined) return;
      const band = bandOf(edge, context);
      const shaded = edge.shade !== undefined;
      const last = segments[segments.length - 1];
      if (last !== undefined && last.band === band && last.shaded === shaded) (last.coords as LngLat[]).push(b);
      else segments.push({ coords: [a, b], band, shaded });
      lengthM += edge.lengthM;
      if (shaded) shadeM += edge.lengthM;
      if (edge.shade === 'dense') denseShadeM += edge.lengthM;
      if (band !== undefined) byBand[band] += edge.lengthM;
      const kind = surfaceKindFor(edge.tags['surface']);
      if (kind === undefined) unknownSurfaceM += edge.lengthM;
      else if (PAVED_KINDS.includes(kind)) pavedM += edge.lengthM;
      else unpavedM += edge.lengthM;
    });
  }

  return {
    ok: true,
    line,
    segments,
    snapped: nodes.map((n) => graph.coords[n] ?? [0, 0]),
    profile: {
      lengthM,
      minutes: Math.round((lengthM / 1000 / DOG_WALK_KMH) * 60),
      byBand,
      pavedM,
      unpavedM,
      unknownSurfaceM,
      shadeM,
      denseShadeM,
      heatKnown: context.pawBands !== undefined,
    },
  };
}
