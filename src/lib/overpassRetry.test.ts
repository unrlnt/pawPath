import { describe, expect, it } from 'vitest';

import {
  OVERPASS_BACKOFF_BASE_MS,
  OVERPASS_BACKOFF_MAX_MS,
  OVERPASS_MAX_SLOT_WAIT_MS,
} from '../config';
import {
  backoffDelayMs,
  isFatalStatus,
  isRetryableStatus,
  parseOverpassStatus,
  slotWaitMs,
} from './overpassRetry';

describe('backoffDelayMs', () => {
  it('grows exponentially from the base', () => {
    // random() = 1 gives the top of each jitter window, i.e. the plain curve.
    const top = (attempt: number) => backoffDelayMs(attempt, () => 1);
    expect(top(0)).toBe(OVERPASS_BACKOFF_BASE_MS);
    expect(top(1)).toBe(OVERPASS_BACKOFF_BASE_MS * 2);
    expect(top(2)).toBe(OVERPASS_BACKOFF_BASE_MS * 4);
    expect(top(3)).toBe(OVERPASS_BACKOFF_BASE_MS * 8);
  });

  it('caps the delay', () => {
    expect(backoffDelayMs(30, () => 1)).toBe(OVERPASS_BACKOFF_MAX_MS);
  });

  it('applies jitter, so two clients do not retry in lockstep', () => {
    const low = backoffDelayMs(3, () => 0);
    const high = backoffDelayMs(3, () => 1);
    expect(low).toBeLessThan(high);
    // Half fixed, half random: never zero, never more than the plain curve.
    expect(low).toBeGreaterThan(0);
    expect(high).toBe(OVERPASS_BACKOFF_BASE_MS * 8);
  });

  it('treats a negative attempt index as the first attempt', () => {
    expect(backoffDelayMs(-5, () => 1)).toBe(OVERPASS_BACKOFF_BASE_MS);
  });
});

describe('retryable statuses', () => {
  it('retries congestion and server faults', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it('never retries 400 or 406', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(406)).toBe(false);
    expect(isFatalStatus(400)).toBe(true);
    expect(isFatalStatus(406)).toBe(true);
  });
});

describe('parseOverpassStatus', () => {
  it('reads a body with free slots', () => {
    const status = parseOverpassStatus(
      [
        'Connected as: 1234567890',
        'Current time: 2026-09-06T10:00:00Z',
        'Rate limit: 2',
        '2 slots available now.',
        'Currently running queries (pid, space limit, time limit, start time):',
      ].join('\n'),
    );
    expect(status.rateLimit).toBe(2);
    expect(status.availableSlots).toBe(2);
    expect(status.nextSlotInSeconds).toBeUndefined();
    expect(status.runningQueries).toBe(0);
  });

  it('reads the wait time when no slot is free', () => {
    const status = parseOverpassStatus(
      [
        'Connected as: 1234567890',
        'Rate limit: 2',
        'Slot available after: 2026-09-06T10:00:30Z, in 30 seconds.',
        'Slot available after: 2026-09-06T10:01:00Z, in 60 seconds.',
        'Currently running queries (pid, space limit, time limit, start time):',
        '1234\t536870912\t180\t2026-09-06T09:59:00Z',
      ].join('\n'),
    );
    expect(status.availableSlots).toBe(0);
    // The earliest slot is the one worth waiting for.
    expect(status.nextSlotInSeconds).toBe(30);
    expect(status.runningQueries).toBe(1);
  });

  it('handles the singular "1 slot available now."', () => {
    expect(parseOverpassStatus('Rate limit: 2\n1 slot available now.').availableSlots).toBe(1);
  });

  it('never throws on an unrecognised body', () => {
    const status = parseOverpassStatus('<html><body>503 Service Unavailable</body></html>');
    expect(status.availableSlots).toBe(0);
    expect(status.rateLimit).toBeUndefined();
    expect(status.nextSlotInSeconds).toBeUndefined();
  });

  it('never throws on an empty body', () => {
    expect(parseOverpassStatus('').availableSlots).toBe(0);
  });
});

describe('slotWaitMs', () => {
  const status = (over: Partial<ReturnType<typeof parseOverpassStatus>>) => ({
    rateLimit: 2,
    availableSlots: 0,
    nextSlotInSeconds: undefined,
    runningQueries: 0,
    ...over,
  });

  it('does not wait when a slot is already free', () => {
    const result = slotWaitMs(status({ availableSlots: 1 }), 0, OVERPASS_MAX_SLOT_WAIT_MS);
    expect(result).toEqual({ waitMs: 0, reason: 'slot' });
  });

  it('waits exactly as long as the instance says, plus a second', () => {
    const result = slotWaitMs(status({ nextSlotInSeconds: 30 }), 0, OVERPASS_MAX_SLOT_WAIT_MS);
    expect(result).toEqual({ waitMs: 31_000, reason: 'slot' });
  });

  it('falls back to backoff when the instance said nothing useful', () => {
    const result = slotWaitMs(undefined, 2, OVERPASS_MAX_SLOT_WAIT_MS, () => 1);
    expect(result.reason).toBe('backoff');
    expect(result.waitMs).toBe(OVERPASS_BACKOFF_BASE_MS * 4);
  });

  it('refuses to stall on an absurd wait and backs off instead', () => {
    const result = slotWaitMs(status({ nextSlotInSeconds: 3600 }), 0, OVERPASS_MAX_SLOT_WAIT_MS, () => 1);
    expect(result.reason).toBe('backoff');
    expect(result.waitMs).toBeLessThanOrEqual(OVERPASS_BACKOFF_MAX_MS);
  });
});
