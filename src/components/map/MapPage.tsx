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
} from '../../config';
import { isLayerKey, LAYER_KEYS, type LayerKey } from '../../data/layers';
import { loadTilesManifest } from '../../data/sources/tilesManifest';
import { isStoredLocation, readStored, writeStored } from '../../lib/storage';
import {
  AdSlot,
  Banner,
  DataUnavailable,
  Disclaimer,
  LayerToggles,
  ZoomHint,
  layersAwaitingZoom,
} from './Chrome';
import MapView, { type Viewport } from './MapView';
import SearchBox from './SearchBox';
import { useGeolocation } from './useGeolocation';

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

  const geolocation = useGeolocation();

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
          userPosition={geolocation.position ?? pin}
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

        <div className="pointer-events-none absolute bottom-24 right-2 z-20 flex flex-col gap-2">
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

        <div className="pointer-events-none absolute inset-x-0 bottom-8 z-20">
          <LayerToggles enabled={enabled} onToggle={toggleLayer} />
        </div>

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
