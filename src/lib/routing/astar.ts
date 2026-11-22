/** A* over a WalkGraph with a pluggable edge cost. Pure. */

import { MIN_EDGE_FACTOR } from './cost';
import { haversineM, type GraphEdge, type WalkGraph } from './graph';

/** Minimal binary min-heap on (priority, node). */
class Heap {
  private readonly items: [number, number][] = [];
  get size(): number {
    return this.items.length;
  }
  push(priority: number, node: number): void {
    const items = this.items;
    items.push([priority, node]);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = items[parent];
      const c = items[i];
      if (p === undefined || c === undefined || p[0] <= c[0]) break;
      items[parent] = c;
      items[i] = p;
      i = parent;
    }
  }
  pop(): number | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined) return undefined;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if ((items[l]?.[0] ?? Infinity) < (items[m]?.[0] ?? Infinity)) m = l;
        if ((items[r]?.[0] ?? Infinity) < (items[m]?.[0] ?? Infinity)) m = r;
        if (m === i) break;
        const a = items[i];
        const b = items[m];
        if (a === undefined || b === undefined) break;
        items[i] = b;
        items[m] = a;
        i = m;
      }
    }
    return top[1];
  }
}

export interface PathResult {
  readonly nodes: readonly number[];
  /** The edge taken into each node after the first. */
  readonly edges: readonly GraphEdge[];
  readonly lengthM: number;
}

/**
 * Cheapest path from `from` to `to`. The heuristic is straight-line distance,
 * admissible as long as every cost factor is ≥ the smallest factor used,
 * which `minFactor` states (the off-leash bonus makes it < 1).
 */
export function astar(
  graph: WalkGraph,
  from: number,
  to: number,
  edgeCost: (edge: GraphEdge) => number,
  minFactor = MIN_EDGE_FACTOR,
): PathResult | undefined {
  const target = graph.coords[to];
  if (target === undefined) return undefined;
  const g = new Map<number, number>([[from, 0]]);
  const cameFrom = new Map<number, { node: number; edge: GraphEdge }>();
  const heap = new Heap();
  const h = (n: number): number => {
    const c = graph.coords[n];
    return c === undefined ? 0 : haversineM(c, target) * minFactor;
  };
  heap.push(h(from), from);
  const closed = new Set<number>();

  while (heap.size > 0) {
    const current = heap.pop();
    if (current === undefined) break;
    if (current === to) break;
    if (closed.has(current)) continue;
    closed.add(current);
    const base = g.get(current) ?? Infinity;
    for (const edge of graph.edges[current] ?? []) {
      const cost = edgeCost(edge);
      if (!Number.isFinite(cost)) continue;
      const next = base + cost;
      if (next < (g.get(edge.to) ?? Infinity)) {
        g.set(edge.to, next);
        cameFrom.set(edge.to, { node: current, edge });
        heap.push(next + h(edge.to), edge.to);
      }
    }
  }

  if (!g.has(to)) return undefined;
  const nodes: number[] = [to];
  const edges: GraphEdge[] = [];
  let lengthM = 0;
  let n = to;
  while (n !== from) {
    const step = cameFrom.get(n);
    if (step === undefined) return undefined;
    edges.unshift(step.edge);
    lengthM += step.edge.lengthM;
    n = step.node;
    nodes.unshift(n);
  }
  return { nodes, edges, lengthM };
}
