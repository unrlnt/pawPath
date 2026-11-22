/**
 * Routing graph check from a built .pmtiles file (Phase 9).
 *
 *   npx tsx tools/tiles/route-check.ts FILE.pmtiles LAT1 LNG1 LAT2 LNG2
 *
 * Loads the graph around both points as the browser would, reports its size
 * and largest connected component, and plans a route between them.
 */

import { WalkGraphSource } from '../../src/data/sources/walkGraphSource';
import { pawBandsByExposure } from '../../src/lib/conditions/pawBySurface';
import { planRoute } from '../../src/lib/routing/route';
import { FileSource } from './lib/fileSource';

async function main(): Promise<void> {
  const [file, ...nums] = process.argv.slice(2);
  const [lat1, lng1, lat2, lng2] = nums.map(Number);
  if (file === undefined || [lat1, lng1, lat2, lng2].some((n) => n === undefined || Number.isNaN(n))) {
    console.error('usage: route-check.ts FILE.pmtiles LAT1 LNG1 LAT2 LNG2');
    process.exit(64);
  }
  const a: [number, number] = [lng1 as number, lat1 as number];
  const b: [number, number] = [lng2 as number, lat2 as number];
  const started = performance.now();
  const outcome = await new WalkGraphSource(new FileSource(file)).graphAround([a, b]);
  if (!outcome.ok) throw new Error(outcome.reason);
  const { graph } = outcome;
  const loaded = performance.now();

  // Largest connected component (edges are stored both ways).
  const seen = new Int32Array(graph.coords.length).fill(-1);
  const sizes: number[] = [];
  for (let start = 0; start < graph.coords.length; start += 1) {
    if (seen[start] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [start];
    seen[start] = id;
    while (stack.length > 0) {
      const node = stack.pop() as number;
      size += 1;
      for (const edge of graph.edges[node] ?? []) {
        if (seen[edge.to] === -1) {
          seen[edge.to] = id;
          stack.push(edge.to);
        }
      }
    }
    sizes.push(size);
  }
  const largest = Math.max(...sizes);
  const edges = graph.edges.reduce((sum, list) => sum + list.length, 0) / 2;
  console.log(`graph: ${graph.coords.length} nodes, ${edges} edges, ${sizes.length} components, largest ${largest} (${((100 * largest) / graph.coords.length).toFixed(1)}%) — loaded in ${(loaded - started).toFixed(0)} ms`);

  for (const label of ['cool weather', 'hot afternoon'] as const) {
    const t = performance.now();
    const context =
      label === 'hot afternoon'
        ? { pawBands: pawBandsByExposure({ airC: 31, shortwaveWm2: 900, windKmh: 3 }), feltC: 32 }
        : {};
    const route = planRoute(graph, [a, b], context);
    if (!route.ok) {
      console.log(`${label}: no route (${route.reason})`);
      continue;
    }
    const p = route.profile;
    console.log(
      `${label}: ${(p.lengthM / 1000).toFixed(2)} km, ${p.minutes} min · hot ${p.byBand.danger.toFixed(0)} m, warm ${p.byBand.caution.toFixed(0)} m · paved ${p.pavedM.toFixed(0)} m, unpaved ${p.unpavedM.toFixed(0)} m, unknown ${p.unknownSurfaceM.toFixed(0)} m · shade ${p.shadeM.toFixed(0)} m (dense ${p.denseShadeM.toFixed(0)} m) — ${(performance.now() - t).toFixed(0)} ms`,
    );
  }
}

void main();
