/**
 * Per-instance health: circuit breaker, 406 demotion, and cached `/api/status`
 * readings.
 *
 * Session-scoped and deliberately in-memory. A reload starts clean, which is
 * what you want after closing a laptop lid for an hour.
 */

import {
  OVERPASS_BREAKER_COOLDOWN_MS,
  OVERPASS_BREAKER_THRESHOLD,
  OVERPASS_INSTANCE_CONFIGS,
  OVERPASS_STATUS_TTL_MS,
  type OverpassInstanceConfig,
} from '../../config';
import type { OverpassStatus } from '../../lib/overpassRetry';

export interface InstanceHealth {
  readonly url: string;
  readonly label: string;
  consecutiveFailures: number;
  /** Timestamp until which the breaker keeps this instance parked. */
  parkedUntil: number;
  lastError: string | undefined;
  lastSuccessAt: number | undefined;
  totalRequests: number;
  totalFailures: number;
}

const health = new Map<string, InstanceHealth>();

function ensure(instance: OverpassInstanceConfig): InstanceHealth {
  const existing = health.get(instance.url);
  if (existing !== undefined) return existing;
  const created: InstanceHealth = {
    url: instance.url,
    label: instance.label,
    consecutiveFailures: 0,
    parkedUntil: 0,
    lastError: undefined,
    lastSuccessAt: undefined,
    totalRequests: 0,
    totalFailures: 0,
  };
  health.set(instance.url, created);
  return created;
}

/**
 * Health record for a URL, created on demand.
 *
 * Recording must never depend on some earlier call having populated the map:
 * a silently-dropped failure would leave the breaker permanently disarmed.
 */
function ensureByUrl(url: string): InstanceHealth {
  const existing = health.get(url);
  if (existing !== undefined) return existing;
  const configured = OVERPASS_INSTANCE_CONFIGS.find((instance) => instance.url === url);
  return ensure(
    configured ?? {
      label: url,
      url,
      statusUrl: url.replace(/\/interpreter\/?$/, '/status'),
      status: 'active',
      note: 'Not in OVERPASS_INSTANCE_CONFIGS.',
    },
  );
}

export function healthFor(url: string): InstanceHealth | undefined {
  return health.get(url);
}

export function allInstanceHealth(): readonly InstanceHealth[] {
  return OVERPASS_INSTANCE_CONFIGS.filter((i) => i.status === 'active').map(ensure);
}

export function isParked(instance: InstanceHealth, now = Date.now()): boolean {
  return instance.parkedUntil > now;
}

/**
 * Instances to try, best first.
 *
 * Ordering rules:
 *  1. anything the breaker has parked goes after healthy instances;
 *  2. otherwise keep the configured order, which is itself deliberate.
 *
 * Parked instances are still returned rather than removed: if every instance is
 * parked, trying a parked one beats failing without a request.
 *
 * Note there is no "refuses us" rule any more. A 406 was once read as an
 * instance refusing programmatic clients; it was our own Accept header, and it
 * is now handled as a client bug that no reordering can fix.
 */
export function instancesInPreferenceOrder(now = Date.now()): readonly InstanceHealth[] {
  return OVERPASS_INSTANCE_CONFIGS.filter((i) => i.status === 'active')
    .map((instance, index) => ({ instance: ensure(instance), index }))
    .sort((a, b) => {
      const parked = Number(isParked(a.instance, now)) - Number(isParked(b.instance, now));
      if (parked !== 0) return parked;
      return a.index - b.index;
    })
    .map((entry) => entry.instance);
}

export function recordSuccess(url: string, now = Date.now()): void {
  const instance = ensureByUrl(url);
  instance.consecutiveFailures = 0;
  instance.parkedUntil = 0;
  instance.lastError = undefined;
  instance.lastSuccessAt = now;
  instance.totalRequests += 1;
}

/**
 * Records a failure and parks the instance once it has failed
 * `OVERPASS_BREAKER_THRESHOLD` times in a row. After the cooldown it is tried
 * again — a single success resets it completely.
 */
export function recordFailure(url: string, message: string, now = Date.now()): void {
  const instance = ensureByUrl(url);
  instance.consecutiveFailures += 1;
  instance.totalRequests += 1;
  instance.totalFailures += 1;
  instance.lastError = message;
  if (instance.consecutiveFailures >= OVERPASS_BREAKER_THRESHOLD) {
    instance.parkedUntil = now + OVERPASS_BREAKER_COOLDOWN_MS;
  }
}

/** Test seam: clears all session health state. */
export function resetInstanceHealth(): void {
  health.clear();
  statusCache.clear();
}

/* ------------------------------------------------------------------ *
 * /api/status cache
 * ------------------------------------------------------------------ */

interface CachedStatus {
  readonly status: OverpassStatus;
  readonly fetchedAt: number;
}

const statusCache = new Map<string, CachedStatus>();

export function cachedStatus(url: string, now = Date.now()): OverpassStatus | undefined {
  const entry = statusCache.get(url);
  if (entry === undefined) return undefined;
  if (now - entry.fetchedAt > OVERPASS_STATUS_TTL_MS) {
    statusCache.delete(url);
    return undefined;
  }
  return entry.status;
}

export function cacheStatus(url: string, status: OverpassStatus, now = Date.now()): void {
  statusCache.set(url, { status, fetchedAt: now });
}

/** `/api/status` URL for an interpreter URL. */
export function statusUrlFor(interpreterUrl: string): string {
  const configured = OVERPASS_INSTANCE_CONFIGS.find((i) => i.url === interpreterUrl);
  return configured?.statusUrl ?? interpreterUrl.replace(/\/interpreter\/?$/, '/status');
}
