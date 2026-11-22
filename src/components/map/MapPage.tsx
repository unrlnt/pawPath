/**
 * The landing view: a map, filling the screen, rendering immediately and
 * filling in as tiles arrive (CLAUDE.md §2.5).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_ENABLED_LAYERS,
  MAP_DEFAULT_ZOOM,
  MAP_FALLBACK_CENTRE,
  STORAGE_KEYS,
  WATER_WARNINGS_REFRESH_MS,
} from '../../config';
import {
  DEFAULT_DISABLED_FEATURE_LEVELS,
  isFeatureLevel,
  isLayerKey,
  LAYER_KEYS,
  type FeatureLevel,
  type LayerKey,
} from '../../data/layers';
import { loadTilesManifest } from '../../data/sources/tilesManifest';
import { NO_WARNINGS, loadWaterWarnings, type WaterWarnings } from '../../data/sources/waterWarnings';
import { isStoredLocation, readStored, writeStored } from '../../lib/storage';
import ConditionsCard from '../conditions/ConditionsCard';
import { useConditions } from '../conditions/useConditions';
import { pawBySurface } from '../../lib/conditions/pawBySurface';
import {
  AdSlot,
  Banner,
  DataUnavailable,
  Disclaimer,
  LayerToggles,
  ZoomHint,
  layersAwaitingZoom,
} from './Chrome';
import RoutePanel, { SavedRoutesSheet } from '../route/RoutePanel';
import { useRoutePlanner } from '../route/useRoutePlanner';
import { useWatchPosition } from '../route/useWatchPosition';
import { progressAlong } from '../../lib/routing/edit';
import type { LngLat } from '../../lib/routing/route';
import FilterSheet from './FilterSheet';
import MapView, { type RouteOverlay, type Viewport } from './MapView';
import SearchBox from './SearchBox';
import { useGeolocation } from './useGeolocation';

const isLevelList = (value: unknown): value is FeatureLevel[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string' && isFeatureLevel(entry));

const isLayerList = (value: unknown): value is LayerKey[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string' && isLayerKey(entry));

export default function MapPage() {
  const stored = useMemo(() => readStored(STORAGE_KEYS.lastLocation, isStoredLocation), []);
  const [centre, setCentre] = useState(() =>
    stored === undefined
      ? { lat: MAP_FALLBACK_CENTRE.lat, lng: MAP_FALLBACK_CENTRE.lng }
      : { lat: stored.lat, lng: stored.lng },
  );
  const [zoom, setZoom] = useState(() => stored?.zoom ?? MAP_DEFAULT_ZOOM);
  const [viewport, setViewport] = useState<Viewport | undefined>(undefined);
  const [pin, setPin] = useState<{ lat: number; lng: number } | undefined>(undefined);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tilesUrl, setTilesUrl] = useState<string | undefined>(undefined);
  const [tilesError, setTilesError] = useState<string | undefined>(undefined);
  const [enabled, setEnabled] = useState<readonly LayerKey[]>(
    () => readStored(STORAGE_KEYS.enabledLayers, isLayerList) ?? [...DEFAULT_ENABLED_LAYERS],
  );

  const [disabledLevels, setDisabledLevels] = useState<readonly FeatureLevel[]>(
    () => readStored(STORAGE_KEYS.disabledLevels, isLevelList) ?? [...DEFAULT_DISABLED_FEATURE_LEVELS],
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [warnings, setWarnings] = useState<WaterWarnings>(NO_WARNINGS);

  // Warnings change during the day in season; refresh every 30 minutes.
  useEffect(() => {
    const controller = new AbortController();
    const load = (): void => {
      void loadWaterWarnings(controller.signal).then((w) => {
        if (!controller.signal.aborted) setWarnings(w);
      });
    };
    load();
    const timer = setInterval(load, WATER_WARNINGS_REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  const toggleLevel = useCallback((level: FeatureLevel) => {
    setDisabledLevels((current) => {
      const next = current.includes(level) ? current.filter((l) => l !== level) : [...current, level];
      writeStored(STORAGE_KEYS.disabledLevels, next);
      return next;
    });
  }, []);

  const geolocation = useGeolocation();
  // Conditions where the user is, or else where they are looking.
  const conditions = useConditions(geolocation.position ?? viewport?.centre);
  // Recomputed only when the current hour changes, not on every render.
  const currentHour = conditions.status === 'ready' ? conditions.summary.current.hour : undefined;
  const paws = useMemo(() => (currentHour === undefined ? undefined : pawBySurface(currentHour)), [currentHour]);

  // Route planner (Phase 9).
  const planner = useRoutePlanner(tilesUrl, currentHour);
  const [walking, setWalking] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [fit, setFit] = useState<{ key: number; bounds: [LngLat, LngLat] } | undefined>(undefined);
  const watch = useWatchPosition(walking && planner.active);
  const ready = planner.status.kind === 'ready' ? planner.status.result : undefined;
  const progress = useMemo(
    () => (walking && ready !== undefined && watch.position !== undefined ? progressAlong(ready.line, watch.position) : undefined),
    [walking, ready, watch.position],
  );
  // Follow the walker.
  useEffect(() => {
    if (watch.position !== undefined) setCentre({ lat: watch.position[1], lng: watch.position[0] });
  }, [watch.position]);
  useEffect(() => {
    if (!planner.active) setWalking(false);
  }, [planner.active]);

  const fitTo = useCallback((points: readonly LngLat[]) => {
    if (points.length === 0) return;
    const lngs = points.map((p) => p[0]);
    const lats = points.map((p) => p[1]);
    setFit((f) => ({
      key: (f?.key ?? 0) + 1,
      bounds: [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
    }));
  }, []);
  // A shared link opens on its route.
  useEffect(() => {
    if (planner.active && planner.waypoints.length > 0) fitTo(planner.waypoints);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const routeOverlay = useMemo<RouteOverlay | undefined>(
    () =>
      planner.active
        ? {
            waypoints: planner.waypoints,
            segments: ready?.segments ?? [],
            onAdd: planner.addWaypoint,
            onMove: planner.moveWaypoint,
            onRemove: planner.removeWaypoint,
            onInsert: planner.insertVia,
          }
        : undefined,
    [planner.active, planner.waypoints, ready, planner.addWaypoint, planner.moveWaypoint, planner.removeWaypoint, planner.insertVia],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadTilesManifest(controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      if (outcome.ok) setTilesUrl(outcome.manifest.url);
      else setTilesError(outcome.message);
    });
    return () => controller.abort();
  }, []);

  // Ask for a location once. Denied or unavailable is fine: the map still
  // works from the stored or fallback centre, and search is one tap away.
  useEffect(() => {
    geolocation.request();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (geolocation.position === undefined || stored !== undefined) return;
    setCentre({ lat: geolocation.position.lat, lng: geolocation.position.lng });
    setZoom(MAP_DEFAULT_ZOOM);
  }, [geolocation.position, stored]);

  useEffect(() => {
    if (viewport === undefined) return;
    writeStored(STORAGE_KEYS.lastLocation, {
      lat: viewport.centre.lat,
      lng: viewport.centre.lng,
      zoom: viewport.zoom,
    });
  }, [viewport]);

  const toggleLayer = useCallback((layer: LayerKey) => {
    setEnabled((current) => {
      const next = current.includes(layer)
        ? current.filter((entry) => entry !== layer)
        : LAYER_KEYS.filter((entry) => entry === layer || current.includes(entry));
      writeStored(STORAGE_KEYS.enabledLayers, next);
      return next;
    });
  }, []);

  const recentre = useCallback(() => {
    if (geolocation.position !== undefined) {
      setCentre({ lat: geolocation.position.lat, lng: geolocation.position.lng });
      setZoom(MAP_DEFAULT_ZOOM);
      return;
    }
    geolocation.request();
  }, [geolocation]);

  const waiting = viewport === undefined ? [] : layersAwaitingZoom(enabled, viewport.zoom);

  return (
    <div className="flex h-full flex-col bg-cream">
      <div className="relative min-h-0 flex-1">
        <MapView
          centre={centre}
          zoom={zoom}
          tilesUrl={tilesUrl}
          enabledLayers={enabled}
          disabledLevels={disabledLevels}
          pawBySurface={paws}
          warnings={warnings}
          userPosition={
            watch.position !== undefined ? { lat: watch.position[1], lng: watch.position[0] } : (geolocation.position ?? pin)
          }
          route={routeOverlay}
          fit={fit}
          onViewportChange={setViewport}
          onDropPin={(position) => {
            setPin(position);
            setCentre(position);
          }}
        />

        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-2 pt-2 pr-12">
          <header className="pointer-events-none mx-2 flex items-center gap-2">
            <span className="rounded-full bg-cream/95 px-3 py-1 font-display text-lg font-semibold text-ink shadow-soft">
              🐾 PawPath
            </span>
          </header>
          <ConditionsCard state={conditions} />
          {searchOpen ? (
            <SearchBox
              near={viewport?.centre}
              onPick={(result) => {
                setCentre({ lat: result.lat, lng: result.lng });
                setZoom(MAP_DEFAULT_ZOOM);
                setSearchOpen(false);
              }}
            />
          ) : null}
          {tilesError !== undefined ? <DataUnavailable message={tilesError} /> : null}
          <ZoomHint waiting={waiting} />
          {geolocation.message !== '' ? <Banner tone="info">{geolocation.message}</Banner> : null}
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-8 z-20 flex flex-col gap-2">
          <div className="pointer-events-none mr-2 flex flex-col gap-2 self-end">
            <ControlButton
              label={searchOpen ? 'Close search' : 'Search for a place'}
              onClick={() => setSearchOpen((open) => !open)}
            >
              {searchOpen ? '✕' : '🔍'}
            </ControlButton>
            <ControlButton label="Recentre on me" onClick={recentre}>
              ◎
            </ControlButton>
          </div>
          {planner.active ? (
            <RoutePanel
              planner={planner}
              walking={walking}
              progress={progress}
              walkError={watch.error}
              onToggleWalk={() => setWalking((w) => !w)}
              onShowSaved={() => setSavedOpen(true)}
            />
          ) : (
            <div className="pointer-events-auto mx-2 flex">
              <button
                type="button"
                onClick={planner.start}
                className="flex min-h-[44px] items-center gap-2 rounded-full bg-terracotta px-4 font-display text-base text-cream shadow-soft active:bg-terracottaDeep"
              >
                <span aria-hidden>🐾</span> Plan a walk
              </button>
            </div>
          )}
          {walking ? null : (
            <LayerToggles enabled={enabled} onToggle={toggleLayer} onOpenFilters={() => setFiltersOpen(true)} />
          )}
        </div>

        {savedOpen ? (
          <SavedRoutesSheet
            saved={planner.saved}
            onOpen={(route) => {
              planner.open(route);
              setSavedOpen(false);
              fitTo(route.waypoints);
            }}
            onDelete={planner.remove}
            onClose={() => setSavedOpen(false)}
          />
        ) : null}

        {filtersOpen ? (
          <FilterSheet
            enabledLayers={enabled}
            disabledLevels={disabledLevels}
            onToggleLayer={toggleLayer}
            onToggleLevel={toggleLevel}
            onClose={() => setFiltersOpen(false)}
          />
        ) : null}

        <Disclaimer />
      </div>
      <AdSlot />
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full bg-cream text-xl text-ink shadow-soft ring-1 ring-creamDeep active:bg-creamDeep"
    >
      {children}
    </button>
  );
}
