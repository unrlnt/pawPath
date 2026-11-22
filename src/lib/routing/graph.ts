/**
 * Walking graph built from the `walk` source-layer of z14 vector tiles.
 *
 * Topology comes for free from the tile grid: every z14 tile shares ONE global
 * integer grid (tileX × extent + x), so the same OSM node decodes to the very
 * same integer pair in every tile that contains it — no float matching, no
 * tolerance. Lines are clipped with a buffer, so a way crossing a tile edge
 * appears in both tiles over the overlap and is stitched through its real
 * shared vertices. Duplicate edges from the overlap are dropped.
 */

export type Tags = Readonly<Record<string, string>>;

/** A line as decoded from one tile, in global grid units. */
export interface GridLine {
  readonly points: readonly (readonly [gx: number, gy: number])[];
  readonly tags: Tags;
}

export interface GraphEdge {
  readonly to: number;
  readonly lengthM: number;
  readonly tags: Tags;
}

export interface WalkGraph {
  /** Node coordinates, [lng, lat], by node index. */
  readonly coords: readonly (readonly [number, number])[];
  readonly edges: readonly (readonly GraphEdge[])[];
  readonly nodeIndex: ReadonlyMap<string, number>;
  /** Connected-component label per node. */
  readonly component: Int32Array;
  /** Label of the largest component — the town's real path network. */
  readonly mainComponent: number;
}

/** Grid units → lng/lat for a grid of `zoom` tiles × `extent` units. */
export function gridToLngLat(gx: number, gy: number, zoom: number, extent: number): [number, number] {
  const size = 2 ** zoom * extent;
  const lng = (gx / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * gy) / size;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lng, lat];
}

/** Great-circle distance in metres. */
export function haversineM(a: readonly [number, number], b: readonly [number, number]): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function buildGraph(lines: readonly GridLine[], zoom: number, extent: number): WalkGraph {
  const nodeIndex = new Map<string, number>();
  const coords: [number, number][] = [];
  const edges: GraphEdge[][] = [];
  const seenEdges = new Set<string>();

  const node = (gx: number, gy: number): number => {
    const key = `${gx},${gy}`;
    let id = nodeIndex.get(key);
    if (id === undefined) {
      id = coords.length;
      nodeIndex.set(key, id);
      coords.push(gridToLngLat(gx, gy, zoom, extent));
      edges.push([]);
    }
    return id;
  };

  for (const line of lines) {
    for (let i = 1; i < line.points.length; i += 1) {
      const p = line.points[i - 1];
      const q = line.points[i];
      if (p === undefined || q === undefined) continue;
      const a = node(p[0], p[1]);
      const b = node(q[0], q[1]);
      if (a === b) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seenEdges.has(key)) continue; // the same segment from a neighbouring tile's buffer
      seenEdges.add(key);
      const ca = coords[a];
      const cb = coords[b];
      if (ca === undefined || cb === undefined) continue;
      const lengthM = haversineM(ca, cb);
      edges[a]?.push({ to: b, lengthM, tags: line.tags });
      edges[b]?.push({ to: a, lengthM, tags: line.tags });
    }
  }
  const { component, mainComponent } = components(edges);
  return { coords, edges, nodeIndex, component, mainComponent };
}

/**
 * Labels connected components. Most of a town is one component; the rest are
 * scraps (a courtyard footway, a path cut off at the edge of the loaded area).
 */
function components(edges: readonly (readonly GraphEdge[])[]): { component: Int32Array; mainComponent: number } {
  const component = new Int32Array(edges.length).fill(-1);
  let mainComponent = -1;
  let mainSize = 0;
  let label = 0;
  for (let start = 0; start < edges.length; start += 1) {
    if (component[start] !== -1) continue;
    let size = 0;
    const stack = [start];
    component[start] = label;
    while (stack.length > 0) {
      const n = stack.pop() as number;
      size += 1;
      for (const edge of edges[n] ?? []) {
        if (component[edge.to] === -1) {
          component[edge.to] = label;
          stack.push(edge.to);
        }
      }
    }
    if (size > mainSize) {
      mainSize = size;
      mainComponent = label;
    }
    label += 1;
  }
  return { component, mainComponent };
}

/**
 * Node to snap a waypoint to. Prefers the main network when it is within
 * `preferMainWithinM`, so a tap next to a courtyard scrap still routes;
 * falls back to the nearest node of any component (a walk entirely inside
 * an island still works). Linear scan: tens of thousands of nodes, a few ms.
 */
export function nearestNode(
  graph: WalkGraph,
  point: readonly [number, number],
  preferMainWithinM = Number.POSITIVE_INFINITY,
): { node: number; distanceM: number } | undefined {
  let best: { node: number; distanceM: number } | undefined;
  let bestMain: { node: number; distanceM: number } | undefined;
  graph.coords.forEach((c, i) => {
    if ((graph.edges[i]?.length ?? 0) === 0) return;
    const d = haversineM(c, point);
    if (best === undefined || d < best.distanceM) best = { node: i, distanceM: d };
    if (graph.component[i] === graph.mainComponent && (bestMain === undefined || d < bestMain.distanceM)) {
      bestMain = { node: i, distanceM: d };
    }
  });
  const main = bestMain as { node: number; distanceM: number } | undefined;
  return main !== undefined && main.distanceM <= preferMainWithinM ? main : best;
}
