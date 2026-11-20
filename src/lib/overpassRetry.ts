/**
 * Retry policy and `/api/status` parsing. Pure and browser-free.
 *
 * This module encodes the corrected diagnosis from Phase 2: the public Overpass
 * instances are reachable and reliable — the same queries succeed by hand from
 * overpass-turbo, on the same browser and IP. Our failures came from rotating
 * through every instance on the first network-class error and giving up inside
 * 20 seconds without a single real retry. Transient errors are normal; the fix
 * is to wait and try again, on the same instance, before moving on.
 */

import {
  OVERPASS_BACKOFF_BASE_MS,
  OVERPASS_BACKOFF_JITTER,
  OVERPASS_BACKOFF_MAX_MS,
} from '../config';

/* ------------------------------------------------------------------ *
 * Backoff
 * ------------------------------------------------------------------ */

/**
 * Exponential backoff with jitter: ~1 s, 2 s, 4 s, 8 s, 16 s, capped at 30 s.
 *
 * Jitter is not optional. Every client that hit the same outage would otherwise
 * retry in lockstep and rebuild the very burst that caused the failure. With
 * `OVERPASS_BACKOFF_JITTER = 0.5` half of each delay is fixed and half is
 * random, so retries spread out while still growing.
 *
 * `random` is injectable so the spread is testable.
 */
export function backoffDelayMs(attemptIndex: number, random: () => number = Math.random): number {
  const uncapped = OVERPASS_BACKOFF_BASE_MS * 2 ** Math.max(0, attemptIndex);
  const capped = Math.min(uncapped, OVERPASS_BACKOFF_MAX_MS);
  const fixed = capped * (1 - OVERPASS_BACKOFF_JITTER);
  return Math.round(fixed + random() * (capped - fixed));
}

/* ------------------------------------------------------------------ *
 * What is worth retrying
 * ------------------------------------------------------------------ */

/**
 * HTTP statuses worth retrying.
 *
 * 400 and 406 are absent deliberately, and both mean the bug is ours. 400 is
 * malformed QL. 406 is content negotiation: we advertised an `Accept` Overpass
 * cannot satisfy (a browser address bar sends `text/html` and gets exactly
 * this). It is NOT an instance refusing programmatic clients — that reading
 * was wrong and has been removed. Neither is retried, rotated, or counted
 * against the instance's health.
 */
export const RETRYABLE_HTTP_STATUSES: readonly number[] = [429, 500, 502, 503, 504];

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.includes(status);
}

/** Statuses that must never be retried, on any instance. */
export function isFatalStatus(status: number): boolean {
  return status === 400 || status === 406;
}

/* ------------------------------------------------------------------ *
 * /api/status
 * ------------------------------------------------------------------ */

/**
 * What an instance reports about our slots.
 *
 * Overpass sends no `Retry-After` header and its 429 body is HTML, so a blind
 * backoff on 429 is guesswork. `/api/status` is plain text and says exactly how
 * many slots we have and when the next one frees.
 */
export interface OverpassStatus {
  /** Slots this client is allowed, or undefined if the line was absent. */
  readonly rateLimit: number | undefined;
  /** Slots free right now. */
  readonly availableSlots: number;
  /** Seconds until the earliest slot frees, when none are free now. */
  readonly nextSlotInSeconds: number | undefined;
  /** Number of queries this client currently has running. */
  readonly runningQueries: number;
}

/**
 * Parses the plain-text `/api/status` body.
 *
 * The format is stable but not a contract, and it varies between versions, so
 * every field is optional and a line we do not recognise is ignored rather than
 * throwing. A body we cannot read at all yields 0 available slots and no wait
 * hint, which the caller treats as "fall back to blind backoff".
 *
 * A representative body:
 *
 *   Connected as: 1234567890
 *   Current time: 2026-09-06T10:00:00Z
 *   Rate limit: 2
 *   Slot available after: 2026-09-06T10:00:30Z, in 30 seconds.
 *   Currently running queries (pid, space limit, time limit, start time):
 */
export function parseOverpassStatus(body: string): OverpassStatus {
  const rateLimitMatch = /rate limit:\s*(\d+)/i.exec(body);

  // "2 slots available now." — also "1 slot available now."
  const availableMatch = /(\d+)\s+slots?\s+available\s+now/i.exec(body);

  // "Slot available after: <iso>, in 30 seconds." — possibly several; the
  // earliest is the one that matters.
  const waitSeconds: number[] = [];
  const waitPattern = /in\s+(-?\d+)\s+seconds?/gi;
  let waitMatch = waitPattern.exec(body);
  while (waitMatch !== null) {
    const seconds = Number(waitMatch[1]);
    if (Number.isFinite(seconds)) waitSeconds.push(Math.max(0, seconds));
    waitMatch = waitPattern.exec(body);
  }

  // Lines after the "Currently running queries" header, one per running query.
  let runningQueries = 0;
  const runningHeaderIndex = body.search(/currently running queries/i);
  if (runningHeaderIndex >= 0) {
    runningQueries = body
      .slice(runningHeaderIndex)
      .split('\n')
      .slice(1)
      .filter((line) => /^\s*\d+\s/.test(line)).length;
  }

  const rateLimit = rateLimitMatch === null ? Number.NaN : Number(rateLimitMatch[1]);
  const availableSlots = availableMatch === null ? 0 : Number(availableMatch[1]);

  return {
    rateLimit: Number.isFinite(rateLimit) ? rateLimit : undefined,
    availableSlots: Number.isFinite(availableSlots) ? availableSlots : 0,
    nextSlotInSeconds: waitSeconds.length === 0 ? undefined : Math.min(...waitSeconds),
    runningQueries,
  };
}

/**
 * How long to wait before retrying, given a status reading.
 *
 * Falls back to jittered backoff when the instance told us nothing useful, and
 * clamps to `maxWaitMs` so a pathological "in 3600 seconds" cannot stall the
 * app — past the clamp it is better to try another instance.
 */
export function slotWaitMs(
  status: OverpassStatus | undefined,
  attemptIndex: number,
  maxWaitMs: number,
  random: () => number = Math.random,
): { waitMs: number; reason: 'slot' | 'backoff' } {
  if (status !== undefined && status.availableSlots > 0) {
    // A slot is free: the 429 was a moment ago and has already cleared.
    return { waitMs: 0, reason: 'slot' };
  }
  if (status?.nextSlotInSeconds !== undefined) {
    // One extra second so we do not arrive exactly as the slot opens.
    const waitMs = (status.nextSlotInSeconds + 1) * 1000;
    if (waitMs <= maxWaitMs) return { waitMs, reason: 'slot' };
  }
  return { waitMs: backoffDelayMs(attemptIndex, random), reason: 'backoff' };
}
