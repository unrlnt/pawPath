/**
 * Route planner state (Phase 9): waypoints, undo, round trip, the computed
 * route, saved routes and the share link. Routing runs here in the browser on
 * the `walk` layer of the same tiles the map draws — no server involved.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ROUTE_MAX_SAVED, ROUTE_MAX_WAYPOINTS, ROUTE_STOP_MAX_OFF_ROUTE_M, STORAGE_KEYS } from '../../config';
import { walkGraphSourceFor } from '../../data/sources/walkGraphSource';
import { pawBandsByExposure } from '../../lib/conditions/pawBySurface';
import type { HourPoint } from '../../lib/conditions/types';
import { bestInsertIndex } from '../../lib/routing/edit';
import { chooseStop, STOP_KINDS, type Poi, type StopKind } from '../../lib/routing/stops';
import { decodeRouteHash, encodeRouteHash, isSavedRouteList, type SavedRoute } from '../../lib/routing/io';
import { planRoute, type LngLat, type RouteResult } from '../../lib/routing/route';
import { readStored, writeStored } from '../../lib/storage';

export type RouteStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'routing' }
  | { readonly kind: 'ready'; readonly result: Extract<RouteResult, { ok: true }> }
  | { readonly kind: 'failed'; readonly message: string };

const FAILURE_TEXT = {
  offNetwork: (i: number) => `Stop ${i + 1} is too far from any path. Move it closer to a path.`,
  noPath: (i: number) => `No walkable connection to stop ${i + 1} — the paths there are not linked.`,
  tooFar: 'That walk is too long to plan in one go. Keep stops within a few kilometres.',
  unavailable: 'Path data could not be loaded. Check your connection and try again.',
} as const;

interface PlannerState {
  readonly waypoints: readonly LngLat[];
  readonly roundTrip: boolean;
}

const EMPTY: PlannerState = { waypoints: [], roundTrip: false };

export function useRoutePlanner(tilesUrl: string | undefined, hour: HourPoint | undefined) {
  // A shared link opens the planner with its route.
  const fromHash = useMemo(() => decodeRouteHash(window.location.hash), []);
  const [active, setActive] = useState(fromHash !== undefined);
  // Current state and its undo history in one value, so updates stay pure.
  const [{ state, history }, setPlanner] = useState<{ state: PlannerState; history: readonly PlannerState[] }>({
    state: fromHash ?? EMPTY,
    history: [],
  });
  const [status, setStatus] = useState<RouteStatus>({ kind: 'idle' });
  const [saved, setSaved] = useState<readonly SavedRoute[]>(
    () => readStored(STORAGE_KEYS.savedRoutes, isSavedRouteList) ?? [],
  );

  const source = useMemo(() => (tilesUrl === undefined ? undefined : walkGraphSourceFor(tilesUrl)), [tilesUrl]);

  /** Every edit goes through here, so undo always works. */
  const update = useCallback((next: (current: PlannerState) => PlannerState) => {
    setPlanner((p) => {
      const updated = next(p.state);
      return updated === p.state ? p : { state: updated, history: [...p.history.slice(-49), p.state] };
    });
  }, []);

  const addWaypoint = useCallback(
    (p: LngLat) =>
      update((s) => (s.waypoints.length >= ROUTE_MAX_WAYPOINTS ? s : { ...s, waypoints: [...s.waypoints, p] })),
    [update],
  );
  const moveWaypoint = useCallback(
    (index: number, p: LngLat) => update((s) => ({ ...s, waypoints: s.waypoints.map((w, i) => (i === index ? p : w)) })),
    [update],
  );
  const removeWaypoint = useCallback(
    (index: number) => update((s) => ({ ...s, waypoints: s.waypoints.filter((_, i) => i !== index) })),
    [update],
  );
  /** A via point dropped on the route line (dragged or tapped). */
  const insertVia = useCallback(
    (p: LngLat) =>
      update((s) => {
        if (s.waypoints.length >= ROUTE_MAX_WAYPOINTS) return s;
        const ring = s.roundTrip && s.waypoints[0] !== undefined ? [...s.waypoints, s.waypoints[0]] : [...s.waypoints];
        const at = Math.min(bestInsertIndex(ring, p), s.waypoints.length);
        return { ...s, waypoints: [...s.waypoints.slice(0, at), p, ...s.waypoints.slice(at)] };
      }),
    [update],
  );
  const toggleRoundTrip = useCallback(() => update((s) => ({ ...s, roundTrip: !s.roundTrip })), [update]);
  const clear = useCallback(() => update((s) => (s.waypoints.length === 0 ? s : EMPTY)), [update]);
  const undo = useCallback(() => {
    setPlanner((p) => {
      const previous = p.history[p.history.length - 1];
      return previous === undefined ? p : { state: previous, history: p.history.slice(0, -1) };
    });
  }, []);

  // Route whenever the stops, the loop or the weather change.
  const run = useRef(0);
  /** Amenities in the tiles of the last route calculation. */
  const poisRef = useRef<readonly Poi[]>([]);
  useEffect(() => {
    const stops = state.roundTrip && state.waypoints.length >= 2 ? [...state.waypoints, state.waypoints[0] as LngLat] : state.waypoints;
    if (!active || stops.length < 2) {
      setStatus({ kind: 'idle' });
      return;
    }
    if (source === undefined) {
      setStatus({ kind: 'failed', message: 'Path data is not available yet, so walks cannot be planned right now.' });
      return;
    }
    const id = (run.current += 1);
    setStatus({ kind: 'routing' });
    // The current hour's weather: paw bands for sun and each shade level, and
    // the felt temperature that makes shade worth a detour.
    const context = hour === undefined ? {} : { pawBands: pawBandsByExposure(hour), feltC: hour.apparentC };
    void source.graphAround(stops).then((outcome) => {
      if (id !== run.current) return; // a newer edit won
      if (!outcome.ok) {
        setStatus({ kind: 'failed', message: FAILURE_TEXT[outcome.reason] });
        return;
      }
      poisRef.current = outcome.pois;
      const result = planRoute(outcome.graph, stops, context);
      if (result.ok) setStatus({ kind: 'ready', result });
      else if (result.reason === 'tooFew') setStatus({ kind: 'idle' });
      else setStatus({ kind: 'failed', message: FAILURE_TEXT[result.reason](result.waypointIndex ?? 0) });
    });
  }, [active, state, source, hour]);

  // Keep the share link in the address bar while planning.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.hash = active && state.waypoints.length >= 2 ? encodeRouteHash(state.waypoints, state.roundTrip) : '';
    window.history.replaceState(null, '', url.hash === '' ? url.pathname + url.search : url.toString());
  }, [active, state]);

  const persist = (next: readonly SavedRoute[]): void => {
    setSaved(next);
    writeStored(STORAGE_KEYS.savedRoutes, next);
  };

  const save = useCallback(
    (name: string) => {
      if (state.waypoints.length < 2) return;
      const route: SavedRoute = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim() === '' ? 'My walk' : name.trim().slice(0, 60),
        waypoints: state.waypoints,
        roundTrip: state.roundTrip,
        savedAt: Date.now(),
      };
      persist([route, ...saved].slice(0, ROUTE_MAX_SAVED));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, saved],
  );
  const open = useCallback(
    (route: SavedRoute) => {
      update(() => ({ waypoints: route.waypoints, roundTrip: route.roundTrip }));
      setActive(true);
    },
    [update],
  );
  /** Start planning a fresh walk through these stops ("Walk there"). */
  const startWith = useCallback(
    (waypoints: readonly LngLat[]) => {
      update(() => ({ waypoints, roundTrip: false }));
      setActive(true);
    },
    [update],
  );
  const remove = useCallback(
    (id: string) => persist(saved.filter((r) => r.id !== id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saved],
  );

  const shareUrl = (): string => {
    const url = new URL(window.location.href);
    url.hash = encodeRouteHash(state.waypoints, state.roundTrip);
    return url.toString();
  };

  /** "Add a stop": route via the nearest amenity of this kind. Returns what to tell the walker. */
  const addStop = useCallback(
    (kind: StopKind): string => {
      if (status.kind !== 'ready') return 'Plan a route first, then add a stop.';
      const choice = chooseStop(kind, status.result.line, state.waypoints, poisRef.current);
      const noun = STOP_KINDS[kind].noun;
      if (!choice.ok) {
        return choice.reason === 'already-on-route'
          ? `Your walk already passes a ${noun}.`
          : `No ${noun} is mapped within ${ROUTE_STOP_MAX_OFF_ROUTE_M} m of this walk.`;
      }
      insertVia(choice.poi.at);
      return `Added a ${noun} about ${Math.max(10, Math.round(choice.offRouteM / 10) * 10)} m off your route.`;
    },
    [status, state.waypoints, insertVia],
  );

  return {
    addStop,
    active,
    start: () => setActive(true),
    stop: () => setActive(false),
    waypoints: state.waypoints,
    roundTrip: state.roundTrip,
    canUndo: history.length > 0,
    status,
    saved,
    addWaypoint,
    moveWaypoint,
    removeWaypoint,
    insertVia,
    toggleRoundTrip,
    clear,
    undo,
    save,
    open,
    startWith,
    remove,
    shareUrl,
  };
}

export type RoutePlanner = ReturnType<typeof useRoutePlanner>;
