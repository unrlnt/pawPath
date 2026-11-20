/**
 * Viewport → tiles → features.
 *
 * Everything the query strategy in CLAUDE.md §8 asks for lives here: debounce
 * after the map settles, zoom floors (global and per layer), one batched
 * request per output group, amenity layers before polygon layers, and
 * cancellation of work whose viewport has gone.
 *
 * Two rules shape the design:
 *
 *  1. **One request per output group per viewport, not per tile.** Nine tiles ×
 *     two groups was eighteen serialised requests for a single pan.
 *  2. **The UI stops waiting long before the network does.** Past
 *     `USER_ACTION_LATENCY_BUDGET_MS` the spinner goes away and whatever has
 *     arrived is shown, while the retries carry on in the background and paint
 *     tiles as they land. Cancelling at the cap would just be Phase 1's
 *     give-up-early bug in new clothing; blocking past it is indistinguishable
 *     from a crash on mobile.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  MAX_TILES_PER_VIEWPORT,
  MIN_QUERY_ZOOM,
  QUERY_DEBOUNCE_MS,
  USER_ACTION_LATENCY_BUDGET_MS,
  minZoomForLayer,
} from '../../config';
import {
  ALL_LAYERS,
  tileSource,
  type Feature,
  type LayerKey,
  type TileSourceError,
} from '../../data/sources';
import { tilesForViewport, type BBox } from '../../lib/tiles';

export type LayerStatus =
  | 'idle'
  | 'loading'
  | 'retrying'
  /** Still running, but past the latency budget — no longer blocking the UI. */
  | 'background'
  | 'partial'
  | 'error'
  /** Zoomed out too far for this specific layer. */
  | 'zoomedOut';

export interface LayerState {
  readonly status: LayerStatus;
  readonly message: string;
  readonly featureCount: number;
}

export interface Viewport {
  readonly bbox: BBox;
  readonly centre: { lat: number; lng: number };
  readonly zoom: number;
}

export interface TileFeaturesState {
  readonly features: readonly Feature[];
  readonly layerStates: Readonly<Record<string, LayerState>>;
  /** True below MIN_QUERY_ZOOM: nothing is queried at all. */
  readonly belowMinZoom: boolean;
  /** Layers held back by their own higher zoom floor, e.g. surface. */
  readonly layersAwaitingZoom: readonly LayerKey[];
  readonly coveragePartial: boolean;
  readonly tilesRequested: number;
  readonly tilesTotal: number;
  /** The UI should show a spinner. False once the latency budget is spent. */
  readonly busy: boolean;
  /** Work is still running after the budget, painting as it arrives. */
  readonly backgroundActive: boolean;
  readonly lastError: string | undefined;
}

const idleLayerState: LayerState = { status: 'idle', message: '', featureCount: 0 };

/**
 * Fetch order: cheap group first.
 *
 * With concurrency pinned at 1, ordering is the only lever on perceived speed.
 * Amenity layers return in 1–3 s; polygon layers take tens of seconds. Fetching
 * amenities first puts something on screen while the slow group runs
 * (CLAUDE.md §8, progressive render).
 */
function splitByCost(layers: readonly LayerKey[]): { fast: LayerKey[]; slow: LayerKey[] } {
  const fast: LayerKey[] = [];
  const slow: LayerKey[] = [];
  for (const layer of layers) {
    const definition = ALL_LAYERS.find((entry) => entry.key === layer);
    if (definition?.kind === 'amenity') fast.push(layer);
    else slow.push(layer);
  }
  return { fast, slow };
}

export function useTileFeatures(
  viewport: Viewport | undefined,
  enabledLayers: readonly LayerKey[],
): TileFeaturesState {
  const [features, setFeatures] = useState<readonly Feature[]>([]);
  const [layerStates, setLayerStates] = useState<Record<string, LayerState>>({});
  const [coveragePartial, setCoveragePartial] = useState(false);
  const [tilesRequested, setTilesRequested] = useState(0);
  const [tilesTotal, setTilesTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [backgroundActive, setBackgroundActive] = useState(false);
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const [layersAwaitingZoom, setLayersAwaitingZoom] = useState<readonly LayerKey[]>([]);

  /** Loaded features, keyed `layer:id` so one element can serve two layers. */
  const featureIndex = useRef(new Map<string, Feature>());
  const runToken = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const belowMinZoom = viewport !== undefined && viewport.zoom < MIN_QUERY_ZOOM;

  const setLayer = useCallback((layer: LayerKey, patch: Partial<LayerState>) => {
    setLayerStates((current) => ({
      ...current,
      [layer]: { ...(current[layer] ?? idleLayerState), ...patch },
    }));
  }, []);

  useEffect(() => {
    if (viewport === undefined) return;

    if (belowMinZoom) {
      // Deliberately no query at all below the floor: a whole-city bbox is a
      // multi-megabyte answer nobody asked for.
      setLayerStates({});
      setBusy(false);
      setBackgroundActive(false);
      setLayersAwaitingZoom([]);
      return;
    }

    // Layers with their own, higher floor — surface above all, at 700+
    // features/km².
    const zoom = viewport.zoom;
    const eligible = enabledLayers.filter((layer) => zoom >= minZoomForLayer(layer));
    const waiting = enabledLayers.filter((layer) => zoom < minZoomForLayer(layer));
    setLayersAwaitingZoom(waiting);
    for (const layer of waiting) {
      setLayer(layer, {
        status: 'zoomedOut',
        message: `zoom to ${minZoomForLayer(layer)} to load`,
      });
    }

    if (eligible.length === 0) {
      setBusy(false);
      setBackgroundActive(false);
      return;
    }

    const token = (runToken.current += 1);

    const debounce = setTimeout(() => {
      const { tileIds, capped, totalTiles } = tilesForViewport(
        viewport.bbox,
        viewport.centre,
        MAX_TILES_PER_VIEWPORT,
      );
      setCoveragePartial(capped);
      setTilesRequested(tileIds.length);
      setTilesTotal(totalTiles);
      if (tileIds.length === 0) return;

      // Abandon the previous viewport's work: those tiles are off screen.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setBusy(true);
      setBackgroundActive(false);
      setLastError(undefined);

      // The budget stops the UI waiting; it does NOT stop the work.
      const budgetTimer = setTimeout(() => {
        if (token !== runToken.current) return;
        setBusy(false);
        setBackgroundActive(true);
        setLayerStates((current) => {
          const next = { ...current };
          for (const [layer, state] of Object.entries(current)) {
            if (state.status === 'loading' || state.status === 'retrying') {
              next[layer] = {
                ...state,
                status: 'background',
                message: 'still loading in the background',
              };
            }
          }
          return next;
        });
      }, USER_ACTION_LATENCY_BUDGET_MS);

      const { fast, slow } = splitByCost(eligible);

      const runGroup = async (group: readonly LayerKey[]): Promise<void> => {
        if (group.length === 0 || token !== runToken.current) return;

        for (const layer of group) setLayer(layer, { status: 'loading', message: 'loading…' });

        const result = await tileSource.fetchTiles({
          tileIds,
          layers: group,
          signal: controller.signal,
          onProgress: (progress) => {
            if (token !== runToken.current) return;
            for (const layer of group) {
              setLayer(layer, {
                // Past the budget the UI is no longer blocking, so keep the
                // background label rather than re-asserting a spinner state.
                status: controller.signal.aborted ? 'error' : 'retrying',
                message: progress.message,
              });
            }
          },
        });

        if (token !== runToken.current || controller.signal.aborted) return;

        for (const feature of result.features) {
          featureIndex.current.set(`${feature.layer}:${feature.id}`, feature);
        }
        setFeatures([...featureIndex.current.values()]);

        for (const layer of group) {
          const count = result.features.filter((feature) => feature.layer === layer).length;
          if (result.error !== undefined && result.error.kind !== 'aborted') {
            const partial = count > 0;
            setLayer(layer, {
              status: partial ? 'partial' : 'error',
              message: partial
                ? `partial data — ${result.error.message}`
                : result.error.message,
              featureCount: count,
            });
            setLastError(result.error.message);
          } else {
            setLayer(layer, { status: 'idle', message: '', featureCount: count });
          }
        }
      };

      void (async () => {
        try {
          // Amenities first — they are the ones that return in seconds.
          await runGroup(fast);
          await runGroup(slow);
        } finally {
          clearTimeout(budgetTimer);
          if (token === runToken.current) {
            setBusy(false);
            setBackgroundActive(false);
          }
        }
      })();
    }, QUERY_DEBOUNCE_MS);

    return () => {
      clearTimeout(debounce);
    };
  }, [viewport, enabledLayers, belowMinZoom, setLayer]);

  // Abort in-flight work when the map goes away.
  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  return {
    features,
    layerStates,
    belowMinZoom,
    layersAwaitingZoom,
    coveragePartial,
    tilesRequested,
    tilesTotal,
    busy,
    backgroundActive,
    lastError,
  };
}

export type { TileSourceError };
