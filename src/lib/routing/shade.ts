/**
 * Shade along paths (Phase 9, the Phase 5 stretch goal): which stretches of
 * the walking graph run through forest, scrub or along a tree row.
 *
 * Works on the same global z14 grid as the graph, so a path vertex and a
 * shade polygon from the same tile need no conversion. Polygons are tested
 * even-odd over all their rings, which handles holes (clearings) without
 * classifying rings.
 */

export type ShadeLevel = 'dense' | 'medium' | 'light';
/** Exposure of a stretch: full sun, or a shade level. */
export type Exposure = 'sun' | ShadeLevel;

export const SHADE_RANK: Readonly<Record<ShadeLevel, number>> = { light: 1, medium: 2, dense: 3 };

type Pt = readonly [number, number];

export interface ShadeArea {
  readonly level: ShadeLevel;
  readonly rings: readonly (readonly Pt[])[];
}

export interface ShadeLine {
  readonly level: ShadeLevel;
  readonly points: readonly Pt[];
}

interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

function bboxOf(points: readonly Pt[], pad = 0): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

function insideRings(rings: readonly (readonly Pt[])[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = ring[i] as Pt;
      const b = ring[j] as Pt;
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
  }
  return inside;
}

function nearLine(points: readonly Pt[], x: number, y: number, reach: number): boolean {
  const r2 = reach * reach;
  for (let i = 1; i < points.length; i += 1) {
    const [ax, ay] = points[i - 1] as Pt;
    const [bx, by] = points[i] as Pt;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const ex = ax + t * dx - x;
    const ey = ay + t * dy - y;
    if (ex * ex + ey * ey <= r2) return true;
  }
  return false;
}

const CELL = 512; // grid units per bucket (~200 m at 52° N)

/**
 * Builds a lookup: grid point → the densest shade covering it, or undefined
 * for full sun. `lineReach` is how close (grid units) a path must run to a
 * tree row to count as shaded by it.
 */
export function makeShadeLookup(
  areas: readonly ShadeArea[],
  lines: readonly ShadeLine[],
  lineReach: number,
): (x: number, y: number) => ShadeLevel | undefined {
  type Item = { box: Box; test: (x: number, y: number) => boolean; level: ShadeLevel };
  const items: Item[] = [
    ...areas.map((a) => ({ box: bboxOf(a.rings.flat()), test: (x: number, y: number) => insideRings(a.rings, x, y), level: a.level })),
    ...lines.map((l) => ({ box: bboxOf(l.points, lineReach), test: (x: number, y: number) => nearLine(l.points, x, y, lineReach), level: l.level })),
  ];
  const buckets = new Map<string, Item[]>();
  for (const item of items) {
    for (let cx = Math.floor(item.box.x0 / CELL); cx <= Math.floor(item.box.x1 / CELL); cx += 1) {
      for (let cy = Math.floor(item.box.y0 / CELL); cy <= Math.floor(item.box.y1 / CELL); cy += 1) {
        const key = `${cx},${cy}`;
        const list = buckets.get(key);
        if (list === undefined) buckets.set(key, [item]);
        else list.push(item);
      }
    }
  }
  return (x, y) => {
    let best: ShadeLevel | undefined;
    for (const item of buckets.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? []) {
      if (best !== undefined && SHADE_RANK[item.level] <= SHADE_RANK[best]) continue;
      const { box } = item;
      if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) continue;
      if (item.test(x, y)) best = item.level;
    }
    return best;
  };
}

const lower = (l: ShadeLevel, r: ShadeLevel): ShadeLevel => (SHADE_RANK[l] <= SHADE_RANK[r] ? l : r);

/**
 * Shade of a straight stretch from three samples (¼, ½, ¾): shaded when at
 * least two are, at the level of the middle one (or the other shaded one).
 * Long forest-edge segments thus count only when mostly inside.
 *
 * Each sample also looks `sideReach` grid units to both sides. Woodland is
 * often mapped with the paths left as gaps between polygons (the Dutch BGT
 * imports do this everywhere), so a path through a wood is rarely *inside*
 * one: wooded on both sides counts as that wood (the lower of the two),
 * wooded on one side only — a forest edge — counts as light shade.
 */
export function stretchShade(
  lookup: (x: number, y: number) => ShadeLevel | undefined,
  a: Pt,
  b: Pt,
  sideReach = 0,
): ShadeLevel | undefined {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const nx = len === 0 ? 0 : (-dy / len) * sideReach;
  const ny = len === 0 ? 0 : (dx / len) * sideReach;
  const at = (t: number): ShadeLevel | undefined => {
    const x = a[0] + dx * t;
    const y = a[1] + dy * t;
    const centre = lookup(x, y);
    if (centre !== undefined || sideReach === 0) return centre;
    const left = lookup(x + nx, y + ny);
    const right = lookup(x - nx, y - ny);
    if (left !== undefined && right !== undefined) return lower(left, right);
    return left !== undefined || right !== undefined ? 'light' : undefined;
  };
  const samples = [at(0.5), at(0.25), at(0.75)];
  const shaded = samples.filter((s): s is ShadeLevel => s !== undefined);
  return shaded.length >= 2 ? shaded[0] : undefined;
}
