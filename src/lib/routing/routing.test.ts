import { describe, expect, it } from 'vitest';

import { edgeFactor, FORBIDDEN } from './cost';
import { buildGraph, gridToLngLat, type GridLine } from './graph';
import { makeShadeLookup, stretchShade } from './shade';
import { edgeFactor as factorOf, sunFactor } from './cost';
import { bestInsertIndex, formatDistance, formatMinutes, progressAlong } from './edit';
import { chooseStop } from './stops';
import { decodeRouteHash, encodeRouteHash, toGpx } from './io';
import { planRoute } from './route';

/** The same paw bands in sun and every shade level. */
const everywhere = <const T,>(b: T) => ({ sun: b, light: b, medium: b, dense: b }) as const;

const Z = 14;
const EXT = 4096;
// A small grid near Almere: global z14 tile 8431,5391 → grid origin.
const OX = 8431 * EXT;
const OY = 5391 * EXT;
const pt = (x: number, y: number): [number, number] => [OX + x, OY + y];
const line = (tags: Record<string, string>, ...points: [number, number][]): GridLine => ({ points, tags });
const ll = (x: number, y: number) => gridToLngLat(OX + x, OY + y, Z, EXT);

describe('graph topology', () => {
  it('joins lines that share a grid vertex, even from different tiles', () => {
    const graph = buildGraph(
      [line({ highway: 'footway' }, pt(0, 0), pt(100, 0)), line({ highway: 'footway' }, pt(100, 0), pt(200, 0))],
      Z,
      EXT,
    );
    expect(graph.coords).toHaveLength(3);
    expect(graph.edges[1]).toHaveLength(2); // the shared middle node
  });

  it('drops the duplicate segment a neighbouring tile repeats in its buffer', () => {
    const seg = line({ highway: 'footway' }, pt(0, 0), pt(100, 0));
    const graph = buildGraph([seg, seg], Z, EXT);
    expect(graph.edges[0]).toHaveLength(1);
  });
});

describe('dog-aware cost', () => {
  it('never routes where dogs or walkers are not allowed', () => {
    expect(edgeFactor({ highway: 'footway', dog: 'no' })).toBe(FORBIDDEN);
    expect(edgeFactor({ highway: 'service', access: 'private' })).toBe(FORBIDDEN);
    expect(edgeFactor({ highway: 'track', access: 'no', foot: 'yes' })).not.toBe(FORBIDDEN);
  });

  it('prefers paths over streets and avoids busy roads', () => {
    expect(edgeFactor({ highway: 'footway' })).toBeLessThan(edgeFactor({ highway: 'residential' }));
    expect(edgeFactor({ highway: 'residential' })).toBeLessThan(edgeFactor({ highway: 'primary' }));
  });

  it('makes hot asphalt expensive only when it is hot', () => {
    const hot = { pawBands: everywhere({ asphalt: 'danger', concrete: 'caution', sand: 'caution', gravel: 'fine', grass: 'fine' }) } as const;
    const cool = { pawBands: everywhere({ asphalt: 'fine', concrete: 'fine', sand: 'fine', gravel: 'fine', grass: 'fine' }) } as const;
    const asphalt = { highway: 'footway', surface: 'asphalt' };
    expect(edgeFactor(asphalt, hot)).toBeGreaterThan(edgeFactor({ highway: 'footway', surface: 'grass' }, hot));
    expect(edgeFactor(asphalt, cool)).toBe(edgeFactor({ highway: 'footway', surface: 'grass' }, cool));
  });

  it('treats an unmapped surface as possibly paved in the heat', () => {
    const hot = { pawBands: everywhere({ asphalt: 'danger', concrete: 'caution', sand: 'caution', gravel: 'fine', grass: 'fine' }) } as const;
    const unknown = edgeFactor({ highway: 'footway' }, hot);
    expect(unknown).toBeGreaterThan(edgeFactor({ highway: 'footway', surface: 'grass' }, hot));
    expect(unknown).toBeLessThan(edgeFactor({ highway: 'footway', surface: 'asphalt' }, hot));
  });
});

describe('planRoute', () => {
  // Two ways from A (0,0) to B (400,0): a short asphalt street straight across,
  // and a longer grass path looping south.
  const lines = [
    line({ highway: 'residential', surface: 'asphalt' }, pt(0, 0), pt(200, 0), pt(400, 0)),
    line({ highway: 'path', surface: 'grass' }, pt(0, 0), pt(0, 150), pt(400, 150), pt(400, 0)),
  ];
  const graph = buildGraph(lines, Z, EXT);
  const A = ll(0, 0);
  const B = ll(400, 0);
  const hot = { pawBands: everywhere({ asphalt: 'danger', concrete: 'danger', sand: 'caution', gravel: 'fine', grass: 'fine' }) } as const;

  it('takes the short street when the weather does not matter', () => {
    const r = planRoute(graph, [A, B]);
    expect(r.ok && r.line.length).toBe(3);
  });

  it('bends onto the grass path when the asphalt is too hot for paws', () => {
    const r = planRoute(graph, [A, B], hot);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.line).toHaveLength(4);
    expect(r.profile.byBand.danger).toBe(0);
    expect(r.profile.unpavedM).toBeGreaterThan(0);
    expect(r.profile.minutes).toBeGreaterThan(0);
  });

  it('refuses a waypoint far from any path', () => {
    const r = planRoute(graph, [A, [A[0] + 0.1, A[1] + 0.1]]);
    expect(r).toEqual({ ok: false, reason: 'offNetwork', waypointIndex: 1 });
  });

  it('snaps to the main network rather than a nearby scrap', () => {
    const g = buildGraph(
      [
        line({ highway: 'path' }, pt(0, 0), pt(100, 0), pt(200, 0)),
        line({ highway: 'path' }, pt(200, 0), pt(300, 0)),
        // A short courtyard footway right next to the tap, not connected.
        line({ highway: 'footway' }, pt(150, 20), pt(160, 20)),
      ],
      Z,
      EXT,
    );
    const r = planRoute(g, [ll(0, 0), ll(152, 18)]);
    expect(r.ok).toBe(true);
  });

  it('reports when paths do not connect', () => {
    // An island ~750 m from the main network: too far to snap onto it.
    const island = buildGraph(
      [line({ highway: 'path' }, pt(0, 0), pt(50, 0), pt(100, 0)), line({ highway: 'path' }, pt(2000, 0), pt(2050, 0))],
      Z,
      EXT,
    );
    expect(planRoute(island, [ll(0, 0), ll(2050, 0)])).toEqual({ ok: false, reason: 'noPath', waypointIndex: 1 });
  });
});

describe('share links and GPX', () => {
  it('round-trips waypoints through the URL hash', () => {
    const wps: [number, number][] = [[5.2235, 52.3625], [5.2186, 52.3705]];
    const hash = encodeRouteHash(wps, true);
    expect(hash).toBe('#route=52.36250,5.22350;52.37050,5.21860;loop');
    expect(decodeRouteHash(hash)).toEqual({ waypoints: wps, roundTrip: true });
  });

  it('rejects malformed or hostile hashes', () => {
    expect(decodeRouteHash('#route=1,2')).toBeUndefined();
    expect(decodeRouteHash('#route=999,1;1,1')).toBeUndefined();
    expect(decodeRouteHash('#route=<script>')).toBeUndefined();
  });

  it('writes valid, escaped GPX', () => {
    const gpx = toGpx('Park & <river>', [[5.1, 52.1], [5.2, 52.2]]);
    expect(gpx).toContain('<name>Park &amp; &lt;river&gt;</name>');
    expect(gpx).toContain('<trkpt lat="52.100000" lon="5.100000"/>');
  });
});

describe('editing and following', () => {
  const a: [number, number] = [5.2, 52.36];
  const b: [number, number] = [5.22, 52.36];
  const c: [number, number] = [5.24, 52.36];

  it('inserts a via point between the stops it sits between', () => {
    expect(bestInsertIndex([a, b, c], [5.21, 52.362])).toBe(1);
    expect(bestInsertIndex([a, b, c], [5.23, 52.358])).toBe(2);
    expect(bestInsertIndex([a], [5.23, 52.358])).toBe(1);
  });

  it('measures progress along the line and distance off it', () => {
    const p = progressAlong([a, c], [5.22, 52.3601]);
    expect(p).toBeDefined();
    if (p === undefined) return;
    expect(Math.abs(p.doneM - p.remainingM)).toBeLessThan(5);
    expect(p.offRouteM).toBeGreaterThan(5);
    expect(p.offRouteM).toBeLessThan(20);
  });

  it('formats distances and durations for the panel', () => {
    expect(formatDistance(640)).toBe('640 m');
    expect(formatDistance(1430)).toBe('1.4 km');
    expect(formatMinutes(35)).toBe('35 min');
    expect(formatMinutes(80)).toBe('1 h 20 min');
  });
});

describe('shade along the route', () => {
  // A forest square from x 0–300, y 100–400, with a clearing (hole) inside.
  const forest = {
    level: 'dense' as const,
    rings: [
      [pt(0, 100), pt(300, 100), pt(300, 400), pt(0, 400), pt(0, 100)],
      [pt(100, 200), pt(200, 200), pt(200, 300), pt(100, 300), pt(100, 200)],
    ],
  };
  const treeRow = { level: 'light' as const, points: [pt(0, -40), pt(400, -40)] };
  const lookup = makeShadeLookup([forest], [treeRow], 15);

  it('finds forest, respects clearings, and counts paths beside tree rows', () => {
    expect(lookup(...pt(50, 150))).toBe('dense');
    expect(lookup(...pt(150, 250))).toBeUndefined(); // the clearing
    expect(lookup(...pt(200, -30))).toBe('light');
    expect(lookup(...pt(200, 40))).toBeUndefined();
  });

  it('counts a path in a gap between two woods as in the wood, and a forest edge as light', () => {
    // Two woods, x 0–100 and x 110–300, with a path in the gap at x 105.
    const left = { level: 'dense' as const, rings: [[pt(0, 0), pt(100, 0), pt(100, 300), pt(0, 300), pt(0, 0)]] };
    const right = { level: 'medium' as const, rings: [[pt(110, 0), pt(300, 0), pt(300, 300), pt(110, 300), pt(110, 0)]] };
    const woods = makeShadeLookup([left, right], [], 0);
    expect(stretchShade(woods, pt(105, 10), pt(105, 290), 20)).toBe('medium');
    expect(stretchShade(woods, pt(105, 10), pt(105, 290), 0)).toBeUndefined();
    // Along the outer edge of the left wood only.
    expect(stretchShade(woods, pt(-10, 10), pt(-10, 290), 20)).toBe('light');
  });

  it('leans into shade as it gets warmer, more for full sun than a tree row', () => {
    expect(sunFactor(undefined)).toBe(1);
    expect(sunFactor(15)).toBe(1);
    expect(sunFactor(30)).toBeGreaterThan(sunFactor(22));
    const ctx = { feltC: 30 };
    const path = { highway: 'path', surface: 'grass' };
    expect(factorOf(path, ctx, 'dense')).toBeLessThan(factorOf(path, ctx, 'light'));
    expect(factorOf(path, ctx, 'light')).toBeLessThan(factorOf(path, ctx));
  });

  it('cools the paw band of a shaded stretch', () => {
    const bands = {
      sun: { asphalt: 'danger', concrete: 'danger', sand: 'caution', gravel: 'fine', grass: 'fine' },
      light: { asphalt: 'danger', concrete: 'caution', sand: 'fine', gravel: 'fine', grass: 'fine' },
      medium: { asphalt: 'caution', concrete: 'fine', sand: 'fine', gravel: 'fine', grass: 'fine' },
      dense: { asphalt: 'fine', concrete: 'fine', sand: 'fine', gravel: 'fine', grass: 'fine' },
    } as const;
    const asphalt = { highway: 'footway', surface: 'asphalt' };
    expect(factorOf(asphalt, { pawBands: bands }, 'dense')).toBeLessThan(factorOf(asphalt, { pawBands: bands }));
  });

  it('routes through the wood on a warm day and reports it in the profile', () => {
    // A straight open path along y 80 (300 units), and one a third longer
    // that dips into the wood (y 130) for most of its length.
    const graph = buildGraph(
      [
        line({ highway: 'path', surface: 'grass' }, pt(0, 80), pt(300, 80)),
        line({ highway: 'path', surface: 'grass' }, pt(0, 80), pt(0, 130), pt(300, 130), pt(300, 80)),
      ],
      Z,
      EXT,
      { at: makeShadeLookup([forest], [], 15), sideReach: 0 },
    );
    const cool = planRoute(graph, [ll(0, 80), ll(300, 80)]);
    const warm = planRoute(graph, [ll(0, 80), ll(300, 80)], { feltC: 30 });
    expect(cool.ok && cool.profile.shadeM).toBe(0);
    expect(warm.ok).toBe(true);
    if (!warm.ok) return;
    expect(warm.profile.shadeM).toBeGreaterThan(0);
    expect(warm.profile.denseShadeM).toBe(warm.profile.shadeM);
    expect(warm.segments.some((seg) => seg.shaded)).toBe(true);
  });
});

describe('add a stop', () => {
  // A route due east along 52.36 N, about 2.7 km long.
  const line: [number, number][] = [[5.2, 52.36], [5.24, 52.36]];
  const near = (dLat: number, lng: number): [number, number] => [lng, 52.36 + dLat];

  it('picks the closest matching amenity within reach', () => {
    const pois = [
      { kind: 'water' as const, at: near(0.003, 5.21) }, // ~330 m off
      { kind: 'water' as const, at: near(0.001, 5.23) }, // ~110 m off
      { kind: 'bench' as const, at: near(0.0001, 5.22) }, // closer, wrong kind
    ];
    const choice = chooseStop('water', line, [line[0] as [number, number], line[1] as [number, number]], pois);
    expect(choice.ok && choice.poi.at).toEqual(near(0.001, 5.23));
  });

  it('counts dog bins as bins, and says when nothing is near', () => {
    const pois = [{ kind: 'dogBin' as const, at: near(0.0005, 5.21) }];
    expect(chooseStop('bin', line, [], pois).ok).toBe(true);
    expect(chooseStop('water', line, [], pois)).toEqual({ ok: false, reason: 'none-near' });
    expect(chooseStop('bin', line, [], [{ kind: 'bin', at: near(0.01, 5.21) }])).toEqual({ ok: false, reason: 'none-near' });
  });

  it('does not add an amenity that is already a stop', () => {
    const tap = near(0.0005, 5.21);
    expect(chooseStop('water', line, [tap], [{ kind: 'water', at: tap }])).toEqual({ ok: false, reason: 'already-on-route' });
  });
});
