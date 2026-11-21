/**
 * Loads conditions for a point and keeps the summary current.
 *
 * Keyed on the 0.1° grid cell, so panning within a town does not refetch.
 * The summary re-evaluates every minute (the hour changes, the rain moves);
 * the data itself refreshes when its 1 h cache expires.
 */

import { useEffect, useMemo, useState } from 'react';

import { CONDITIONS_TTL_MS } from '../../config';
import { loadConditions, snapToGrid } from '../../data/sources/openMeteoSource';
import { summarise, type ConditionsSummary } from '../../lib/conditions/summary';
import type { Conditions } from '../../lib/conditions/types';

// One member per status. A shared `status: 'idle' | 'loading'` member defeats
// narrowing and silently turns destructured fields into `any`.
export type ConditionsState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly conditions: Conditions;
      readonly summary: ConditionsSummary;
    };

const MINUTE = 60_000;

export function useConditions(point: { lat: number; lng: number } | undefined): ConditionsState {
  const cellLat = point === undefined ? undefined : snapToGrid(point.lat);
  const cellLng = point === undefined ? undefined : snapToGrid(point.lng);
  const [conditions, setConditions] = useState<Conditions | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (cellLat === undefined || cellLng === undefined) return;
    const controller = new AbortController();
    setError(undefined);
    void loadConditions(cellLat, cellLng, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      if (outcome.ok) setConditions(outcome.conditions);
      else setError(outcome.message);
    });
    return () => controller.abort();
  }, [cellLat, cellLng, refreshToken]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), MINUTE);
    const refresh = setInterval(() => setRefreshToken((t) => t + 1), CONDITIONS_TTL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, []);

  const summary = useMemo(
    () => (conditions === undefined ? undefined : summarise(conditions, now)),
    [conditions, now],
  );

  if (conditions !== undefined && summary !== undefined) {
    return { status: 'ready', conditions, summary };
  }
  if (error !== undefined) return { status: 'error', message: error };
  return point === undefined ? { status: 'idle' } : { status: 'loading' };
}
