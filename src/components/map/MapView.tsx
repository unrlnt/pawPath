/**
 * The MapLibre canvas and nothing else.
 *
 * Provider-agnostic on purpose: this component reads `MAP_STYLE_URL` and
 * `MAP_ATTRIBUTION` from config and knows nothing about MapTiler, Stadia or
 * Protomaps. Swapping provider is an env-var change (CLAUDE.md §4).
 *
 * Phase 2 renders every feature as the same plain dot. That is the point: it
 * proves the pipeline end to end. Symbols and level encoding are Phase 4.
 */

import type { FeatureCollection, Point } from 'geojson';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';

import {
  MAP_ATTRIBUTION,
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
  MAP_STYLE_URL,
} from '../../config';
import { SOURCE_ATTRIBUTION, type Feature } from '../../data/sources';
import type { Viewport } from './useTileFeatures';

const FEATURE_SOURCE_ID = 'pawpath-features';
const FEATURE_LAYER_ID = 'pawpath-feature-dots';
const USER_SOURCE_ID = 'pawpath-user';
const USER_LAYER_ID = 'pawpath-user-dot';

export interface MapViewProps {
  readonly centre: { lat: number; lng: number };
  readonly zoom: number;
  readonly features: readonly Feature[];
  readonly userPosition: { lat: number; lng: number } | undefined;
  /** Fires after the map settles, already debounced downstream. */
  readonly onViewportChange: (viewport: Viewport) => void;
  /** Fires on a long-press or right-click: the drop-a-pin gesture. */
  readonly onDropPin: (position: { lat: number; lng: number }) => void;
}

function toGeoJson(features: readonly Feature[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: features.map((feature) => ({
      type: 'Feature',
      id: feature.id,
      geometry: { type: 'Point', coordinates: [feature.lng, feature.lat] },
      properties: { layer: feature.layer, level: feature.level ?? '', id: feature.id },
    })),
  };
}

export default function MapView({
  centre,
  zoom,
  features,
  userPosition,
  onViewportChange,
  onDropPin,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // Callbacks live in refs so re-renders never tear down the map.
  const viewportChangeRef = useRef(onViewportChange);
  const dropPinRef = useRef(onDropPin);
  viewportChangeRef.current = onViewportChange;
  dropPinRef.current = onDropPin;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || mapRef.current !== null) return;

    const map = new maplibregl.Map({
      container,
      style: MAP_STYLE_URL,
      center: [centre.lng, centre.lat],
      zoom,
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      attributionControl: false,
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: false,
        // Licence requirement, not decoration: OSM and the tile provider are
        // credited permanently (CLAUDE.md §10).
        customAttribution: [SOURCE_ATTRIBUTION.osm.label, MAP_ATTRIBUTION],
      }),
      'bottom-right',
    );

    const emitViewport = (): void => {
      const bounds = map.getBounds();
      const mapCentre = map.getCenter();
      viewportChangeRef.current({
        bbox: {
          south: bounds.getSouth(),
          west: bounds.getWest(),
          north: bounds.getNorth(),
          east: bounds.getEast(),
        },
        centre: { lat: mapCentre.lat, lng: mapCentre.lng },
        zoom: map.getZoom(),
      });
    };

    map.on('load', () => {
      map.addSource(FEATURE_SOURCE_ID, { type: 'geojson', data: toGeoJson([]) });
      map.addLayer({
        id: FEATURE_LAYER_ID,
        type: 'circle',
        source: FEATURE_SOURCE_ID,
        paint: {
          // Uniform dots, deliberately. Phase 4 encodes layer and level.
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 3, 18, 7],
          'circle-color': '#1d4ed8',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      });

      map.addSource(USER_SOURCE_ID, { type: 'geojson', data: toGeoJson([]) });
      map.addLayer({
        id: USER_LAYER_ID,
        type: 'circle',
        source: USER_SOURCE_ID,
        paint: {
          'circle-radius': 7,
          'circle-color': '#059669',
          'circle-stroke-width': 3,
          'circle-stroke-color': '#ffffff',
        },
      });

      emitViewport();
    });

    // `moveend` covers pan, zoom and rotate, and fires once the map settles —
    // the debounce downstream then absorbs rapid successive settles.
    map.on('moveend', emitViewport);

    map.on('contextmenu', (event) => {
      dropPinRef.current({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    });

    // Long-press equivalent for touch, where there is no right-click.
    let longPress: ReturnType<typeof setTimeout> | undefined;
    const clearLongPress = (): void => {
      if (longPress !== undefined) clearTimeout(longPress);
      longPress = undefined;
    };
    map.on('touchstart', (event) => {
      clearLongPress();
      const { lngLat } = event;
      longPress = setTimeout(() => {
        dropPinRef.current({ lat: lngLat.lat, lng: lngLat.lng });
      }, 600);
    });
    map.on('touchend', clearLongPress);
    map.on('touchmove', clearLongPress);
    map.on('movestart', clearLongPress);

    return () => {
      clearLongPress();
      map.remove();
      mapRef.current = null;
    };
    // Mount once: centre and zoom are the initial camera only. Later changes
    // are applied through the imperative effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recentre when the caller moves the camera (geolocation, search, pin).
  useEffect(() => {
    const map = mapRef.current;
    if (map === null) return;
    map.easeTo({ center: [centre.lng, centre.lat], zoom, duration: 600 });
  }, [centre.lat, centre.lng, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (map === null) return;
    const apply = (): void => {
      const source = map.getSource(FEATURE_SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData(toGeoJson(features));
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [features]);

  useEffect(() => {
    const map = mapRef.current;
    if (map === null) return;
    const apply = (): void => {
      const source = map.getSource(USER_SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData({
        type: 'FeatureCollection',
        features:
          userPosition === undefined
            ? []
            : [
                {
                  type: 'Feature',
                  geometry: {
                    type: 'Point',
                    coordinates: [userPosition.lng, userPosition.lat],
                  },
                  properties: {},
                },
              ],
      });
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [userPosition]);

  return <div ref={containerRef} className="h-full w-full" data-testid="map-canvas" />;
}
