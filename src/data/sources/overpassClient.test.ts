import { beforeEach, describe, expect, it } from 'vitest';

import {
  MIN_QUERY_ZOOM,
  OVERPASS_ATTEMPTS_PER_INSTANCE,
  OVERPASS_BREAKER_THRESHOLD,
  OVERPASS_INSTANCES,
  OVERPASS_INSTANCE_CONFIGS,
  OVERPASS_MAX_ATTEMPTS,
  OVERPASS_MAX_CONCURRENCY,
  OVERPASS_SERVER_TIMEOUT_S,
  OVERPASS_TIMEOUT_MS,
  USER_ACTION_LATENCY_BUDGET_MS,
  minZoomForLayer,
} from '../../config';
import {
  allInstanceHealth,
  instancesInPreferenceOrder,
  isParked,
  recordFailure,
  recordSuccess,
  resetInstanceHealth,
  statusUrlFor,
} from './overpassHealth';

beforeEach(() => {
  resetInstanceHealth();
});

describe('instance configuration', () => {
  /**
   * Order is a policy decision, not a preference: kumi's wiki entry permits any
   * purpose, while overpass-api.de currently refuses programmatic browser
   * requests outright (406).
   */
  it('tries kumi.systems first', () => {
    expect(OVERPASS_INSTANCES[0]).toContain('kumi.systems');
  });

  /**
   * overpass-api.de was once demoted to last for answering 406. That was our
   * own Accept header, not bot filtering, so it is back at normal priority.
   */
  it('keeps overpass-api.de at normal priority', () => {
    expect(OVERPASS_INSTANCES.some((url) => url.includes('overpass-api.de'))).toBe(true);
    expect(OVERPASS_INSTANCES[OVERPASS_INSTANCES.length - 1]).not.toContain('overpass-api.de');
  });

  it('keeps unverified instances out of rotation', () => {
    const candidates = OVERPASS_INSTANCE_CONFIGS.filter((i) => i.status === 'candidate');
    for (const candidate of candidates) {
      expect(OVERPASS_INSTANCES).not.toContain(candidate.url);
    }
    // ...but they are still declared, so the connectivity tester can check them.
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('derives a status URL for every instance', () => {
    for (const instance of OVERPASS_INSTANCE_CONFIGS) {
      expect(statusUrlFor(instance.url)).toBe(instance.statusUrl);
      expect(statusUrlFor(instance.url)).toMatch(/\/api\/status$/);
    }
    // Unknown URLs still derive something sane.
    expect(statusUrlFor('https://example.org/api/interpreter')).toBe(
      'https://example.org/api/status',
    );
  });

  it('never runs requests in parallel — the usage policy forbids it', () => {
    expect(OVERPASS_MAX_CONCURRENCY).toBe(1);
  });

  it('retries the same instance at least twice before rotating', () => {
    expect(OVERPASS_ATTEMPTS_PER_INSTANCE).toBeGreaterThanOrEqual(3);
    expect(OVERPASS_MAX_ATTEMPTS).toBeGreaterThanOrEqual(5);
  });
});

describe('latency budgets', () => {
  /**
   * Amenity queries return in 1–3 s when healthy (Run 1: benches 1.1 s). Giving
   * them the polygon group's timeout spends 45 s of a user's attention waiting
   * on a request that failed 40 s ago.
   */
  it('gives amenity queries a far shorter timeout than polygons', () => {
    expect(OVERPASS_TIMEOUT_MS.amenity).toBeLessThan(OVERPASS_TIMEOUT_MS.area / 2);
    expect(OVERPASS_TIMEOUT_MS.amenity).toBeGreaterThan(5_000);
  });

  it('lets the server give up before the client does, in both groups', () => {
    // Otherwise we abort blind instead of receiving a readable remark.
    expect(OVERPASS_SERVER_TIMEOUT_S.amenity * 1000).toBeLessThan(OVERPASS_TIMEOUT_MS.amenity);
    expect(OVERPASS_SERVER_TIMEOUT_S.area * 1000).toBeLessThan(OVERPASS_TIMEOUT_MS.area);
  });

  /** A cap that mobile users would read as "broken" defeats the purpose. */
  it('caps a user action well under a minute', () => {
    expect(USER_ACTION_LATENCY_BUDGET_MS).toBeGreaterThanOrEqual(45_000);
    expect(USER_ACTION_LATENCY_BUDGET_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('per-layer zoom floors', () => {
  it('holds surface back to a closer zoom than everything else', () => {
    // 700–780 features/km² measured in Run 1 — an order of magnitude above any
    // other layer.
    expect(minZoomForLayer('surface')).toBeGreaterThan(MIN_QUERY_ZOOM);
  });

  it('leaves other layers at the global floor', () => {
    for (const layer of ['benches', 'water', 'shade', 'waste', 'drinkingWater']) {
      expect(minZoomForLayer(layer)).toBe(MIN_QUERY_ZOOM);
    }
  });
});

describe('circuit breaker', () => {
  const first = () => {
    const instance = allInstanceHealth()[0];
    if (instance === undefined) throw new Error('no active instances configured');
    return instance;
  };

  it('parks an instance after consecutive failures', () => {
    const instance = first();
    for (let i = 0; i < OVERPASS_BREAKER_THRESHOLD - 1; i += 1) {
      recordFailure(instance.url, 'boom');
      expect(isParked(instance)).toBe(false);
    }
    recordFailure(instance.url, 'boom');
    expect(isParked(instance)).toBe(true);
  });

  it('unparks completely on a single success', () => {
    const instance = first();
    for (let i = 0; i < OVERPASS_BREAKER_THRESHOLD; i += 1) recordFailure(instance.url, 'boom');
    expect(isParked(instance)).toBe(true);

    recordSuccess(instance.url);
    expect(isParked(instance)).toBe(false);
    expect(instance.consecutiveFailures).toBe(0);
  });

  it('probes a parked instance again after the cooldown', () => {
    const instance = first();
    for (let i = 0; i < OVERPASS_BREAKER_THRESHOLD; i += 1) recordFailure(instance.url, 'boom');
    expect(isParked(instance, Date.now())).toBe(true);
    expect(isParked(instance, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('instance preference order', () => {
  it('follows the configured order while everything is healthy', () => {
    expect(instancesInPreferenceOrder().map((i) => i.url)).toEqual([...OVERPASS_INSTANCES]);
  });

  it('prefers healthy instances over parked ones without dropping them', () => {
    const target = OVERPASS_INSTANCES[0];
    if (target === undefined) throw new Error('no active instances configured');
    for (let i = 0; i < OVERPASS_BREAKER_THRESHOLD; i += 1) recordFailure(target, 'boom');

    const order = instancesInPreferenceOrder();
    expect(order[0]?.url).not.toBe(target);
    // Still present: if every instance is parked, a parked attempt beats none.
    expect(order.map((i) => i.url)).toContain(target);
    expect(order).toHaveLength(OVERPASS_INSTANCES.length);
  });
});
