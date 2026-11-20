/**
 * The landing view: a map, filling the screen, that renders immediately and
 * fills in progressively (CLAUDE.md §2.5).
 *
 * Phase 2 draws every feature as the same plain dot with no filtering. That is
 * the deliverable: proof that viewport → tiles → cache → Overpass → normalised
 * features → screen works end to end. Symbols are Phase 4.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_ENABLED_LAYERS,
  MAP_DEFAULT_ZOOM,
  MAP_FALLBACK_CENTRE,
  MAP_STYLE_CONFIGURED,
  STORAGE_KEYS,
} from '../../config';
import type { LayerKey } from '../../data/sources';
import { isStoredLocation, readStored, writeStored } from '../../lib/storage';
import { AdSlot, AttributionBar, Disclaimer, StatusLine } from './Chrome';
import DevPanel from './DevPanel';
import MapView from './MapView';
import PlaceSearch from './PlaceSearch';
import { useGeolocation } from './useGeolocation';
import { useTileFeatures, type Viewport } from './useTileFeatures';

/**
 * Phase 2 uses the spec's default subset (CLAUDE.md §8). The filter panel that
 * makes this user-controlled is Phase 4.
 */
const ENABLED_LAYERS: readonly LayerKey[] = DEFAULT_ENABLED_LAYERS;

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

  const geolocation = useGeolocation();
  const {
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
  } = useTileFeatures(viewport, ENABLED_LAYERS);

  // Ask for a location once on load. If it is denied or unavailable, the map
  // still works from the stored or fallback centre — never a blocking gate.
  useEffect(() => {
    geolocation.request();
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (geolocation.position === undefined) return;
    // Only move for the very first fix; afterwards the user is in charge.
    if (stored !== undefined) return;
    setCentre({ lat: geolocation.position.lat, lng: geolocation.position.lng });
    setZoom(MAP_DEFAULT_ZOOM);
  }, [geolocation.position, stored]);

  // Persist wherever the user ends up, so the next visit opens there.
  useEffect(() => {
    if (viewport === undefined) return;
    writeStored(STORAGE_KEYS.lastLocation, {
      lat: viewport.centre.lat,
      lng: viewport.centre.lng,
      zoom: viewport.zoom,
    });
  }, [viewport]);

  const recentre = useCallback(() => {
    if (geolocation.position !== undefined) {
      setCentre({ lat: geolocation.position.lat, lng: geolocation.position.lng });
      setZoom(MAP_DEFAULT_ZOOM);
      return;
    }
    geolocation.request();
  }, [geolocation]);

  const retryMessage = Object.values(layerStates).find(
    (state) => state.status === 'retrying',
  )?.message;
  const errorMessage =
    Object.values(layerStates).find((state) => state.status === 'error')?.message ?? lastError;

  if (!MAP_STYLE_CONFIGURED) return <MapProviderMissing />;

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="relative min-h-0 flex-1">
        <MapView
          centre={centre}
          zoom={zoom}
          features={features}
          userPosition={geolocation.position ?? pin}
          onViewportChange={setViewport}
          onDropPin={(position) => {
            setPin(position);
            setCentre(position);
          }}
        />

        {/* Top: status and search. Kept clear of the map's own controls. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-2 p-2 pr-14">
          <StatusLine
            belowMinZoom={belowMinZoom}
            coveragePartial={coveragePartial}
            tilesRequested={tilesRequested}
            tilesTotal={tilesTotal}
            busy={busy}
            backgroundActive={backgroundActive}
            layersAwaitingZoom={layersAwaitingZoom}
            retryMessage={retryMessage}
            errorMessage={errorMessage}
            featureCount={features.length}
          />
          {geolocation.message !== '' ? (
            <div className="pointer-events-none rounded bg-white/95 px-3 py-2 text-sm text-slate-800 shadow">
              {geolocation.message}
            </div>
          ) : null}
          {searchOpen ? <PlaceSearch onPick={(result) => {
            setCentre({ lat: result.lat, lng: result.lng });
            setZoom(MAP_DEFAULT_ZOOM);
            setSearchOpen(false);
          }} /> : null}
        </div>

        {import.meta.env.DEV ? (
          <div className="pointer-events-none absolute bottom-2 left-2 z-20">
            <DevPanel />
          </div>
        ) : null}

        {/* Bottom-right: thumb-reachable controls, 44px minimum. */}
        <div className="pointer-events-none absolute bottom-16 right-2 z-20 flex flex-col gap-2">
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

        <Disclaimer />
      </div>

      <AttributionBar />
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
      className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border-2 border-slate-900 bg-white text-xl shadow-lg active:bg-slate-100"
    >
      {children}
    </button>
  );
}

/**
 * Without a style URL there is no basemap to draw. Saying so plainly beats a
 * blank grey rectangle, and it never falls back to OSM's own tile servers —
 * their usage policy forbids apps like this one (CLAUDE.md §4).
 */
function MapProviderMissing() {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-lg font-bold">No basemap configured</h1>
      <p className="max-w-md text-sm text-slate-700">
        Set <code className="rounded bg-slate-100 px-1">VITE_MAPTILER_KEY</code> (free tier) or{' '}
        <code className="rounded bg-slate-100 px-1">VITE_MAP_STYLE_URL</code> for another provider
        in <code className="rounded bg-slate-100 px-1">.env.local</code>, then restart the dev
        server.
      </p>
      <p className="max-w-md text-xs text-slate-500">
        There is deliberately no fallback to tile.openstreetmap.org — their tile usage policy
        forbids applications like this one.
      </p>
    </main>
  );
}
