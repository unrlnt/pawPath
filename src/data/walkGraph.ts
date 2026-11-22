/**
 * The walking network for the route planner (CLAUDE.md §11, Phase 9).
 *
 * Built into the tiles as a hidden source-layer, `walk`, at z14 only and
 * WITHOUT simplification — simplification could drop a junction vertex and
 * silently disconnect two paths. The browser decodes these lines straight from
 * the .pmtiles archive and routes on them; the server does nothing.
 *
 * Kept outside the LayerKey table on purpose: it is not a map layer users
 * toggle, it is the graph the router walks.
 */

/** Source-layer name in the tiles. */
export const WALK_LAYER = 'walk';

/** Zoom the graph is built at (and the only zoom it exists at). */
export const WALK_GRAPH_ZOOM = 14;

/**
 * Highways a dog walker may use, by preference. Busy roads are included only
 * so towns stay connected (many have sidewalks); the router avoids them.
 * Motorways and trunks are never included.
 */
export const WALK_HIGHWAYS = {
  preferred: ['path', 'footway', 'pedestrian', 'track', 'bridleway', 'living_street'],
  normal: ['residential', 'service', 'unclassified', 'cycleway', 'steps'],
  avoid: ['tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link'],
} as const;

export const ALL_WALK_HIGHWAYS: readonly string[] = [
  ...WALK_HIGHWAYS.preferred,
  ...WALK_HIGHWAYS.normal,
  ...WALK_HIGHWAYS.avoid,
];

/** Tags copied onto each walk line — just what the cost function reads. */
export const WALK_TAGS = ['highway', 'surface', 'foot', 'access', 'dog'] as const;

/** Mirrors the schema's include rule, for the generator's example expectations. */
export function isWalkable(tags: Readonly<Record<string, string>>): boolean {
  const highway = tags['highway'];
  return highway !== undefined && ALL_WALK_HIGHWAYS.includes(highway);
}
