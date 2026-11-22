/**
 * The MapLibre canvas: basemap + PawPath vector tiles + "you".
 *
 * Provider-agnostic: reads MAP_STYLE_URL / MAP_ATTRIBUTION from config and the
 * tile URL from the manifest; knows nothing about where either is hosted.
 * Toggling a layer is a visibility change, never a request (CLAUDE.md §8).
 */

import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { useEffect, useRef } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';

import {
  MAP_ATTRIBUTION,
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
  MAP_RECOLOUR_BASEMAP,
  MAP_STYLE_URL,
} from '../../config';
import { SOURCE_ATTRIBUTION } from '../../data/attribution';
import { isLayerKey, type FeatureLevel, type LayerKey } from '../../data/layers';
import { GLYPHS, registerIcons } from '../../map/icons';
import type { PawBySurface } from '../../lib/conditions/pawBySurface';
import type { WaterWarnings } from '../../data/sources/waterWarnings';
import {
  PAWPATH_SOURCE_ID,
  SURFACE_LAYER_IDS,
  WATER_ICON_LAYER_ID,
  pawpathLayerSpecs,
  surfacePaint,
  waterIcon,
} from '../../map/pawpathLayers';
import { popupModel, type PopupContext } from '../../map/popupModel';
import { warmBasemap } from '../../map/warmBasemap';
import type { LngLat, RouteSegment } from '../../lib/routing/route';
import { palette, pawRisk } from '../../styles/tokens';

// One protocol handler for the page's lifetime; it caches archive headers.
let protocolRegistered = false;
function registerPmtiles(): void {
  if (protocolRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  protocolRegistered = true;
}

const USER_SOURCE_ID = 'pawpath-user';
const ROUTE_SOURCE_ID = 'pawpath-route';
const ROUTE_LINE_ID = 'pawpath-route-line';
const ROUTE_CASING_ID = 'pawpath-route-casing';
const ROUTE_GHOST_ID = 'pawpath-route-ghost';

/** The route being planned, as MapView draws and edits it. */
export interface RouteOverlay {
  readonly waypoints: readonly LngLat[];
  readonly segments: readonly RouteSegment[];
  readonly onAdd: (p: LngLat) => void;
  readonly onMove: (index: number, p: LngLat) => void;
  readonly onRemove: (index: number) => void;
  /** A via point dropped on the route line — dragged there, or tapped. */
  readonly onInsert: (p: LngLat) => void;
}

/** A numbered stop: big enough to grab with a thumb (44 px hit area). */
function waypointElement(label: string, isEnd: boolean): HTMLElement {
  const hit = document.createElement('div');
  hit.className = 'flex h-11 w-11 cursor-grab items-center justify-center';
  hit.setAttribute('role', 'button');
  hit.setAttribute('aria-label', `Stop ${label}: drag to move, tap to remove`);
  const dot = document.createElement('div');
  dot.className =
    'flex h-7 w-7 items-center justify-center rounded-full border-[3px] font-display text-sm font-semibold shadow-soft';
  dot.style.background = isEnd ? palette.ink : palette.cream;
  dot.style.borderColor = palette.ink;
  dot.style.color = isEnd ? palette.cream : palette.ink;
  dot.textContent = label;
  hit.append(dot);
  return hit;
}
// Ids and draw order do not depend on the filters, only the filter
// expressions do — so the id list can be computed once.
const { specs: BASE_SPECS, idsByLayer: IDS_BY_LAYER } = pawpathLayerSpecs([]);
const ALL_PAWPATH_IDS = BASE_SPECS.map((spec) => spec.id);

export interface Viewport {
  readonly centre: { lat: number; lng: number };
  readonly zoom: number;
}

export interface MapViewProps {
  readonly centre: { lat: number; lng: number };
  readonly zoom: number;
  /** Absolute URL of the current .pmtiles file; undefined until the manifest loads. */
  readonly tilesUrl: string | undefined;
  readonly enabledLayers: readonly LayerKey[];
  /** Levels switched off in the filter sheet (dog=yes until opted in). */
  readonly disabledLevels: readonly FeatureLevel[];
  /** Live paw estimate per surface kind: recolours every path by its own surface. */
  readonly pawBySurface: PawBySurface | undefined;
  /** Runtime water warnings; named bathing sites turn red. */
  readonly warnings: WaterWarnings;
  readonly userPosition: { lat: number; lng: number } | undefined;
  readonly onViewportChange: (viewport: Viewport) => void;
  readonly onDropPin: (position: { lat: number; lng: number }) => void;
  /** Route planner overlay; when present, taps edit the route instead of opening popups. */
  readonly route: RouteOverlay | undefined;
  /** Fit the camera to these bounds whenever `fitKey` changes. */
  readonly fit: { readonly key: number; readonly bounds: [LngLat, LngLat] } | undefined;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Popup body built from DOM nodes and textContent only — OSM text is untrusted input. */
function popupContent(
  layer: LayerKey,
  properties: Record<string, unknown>,
  featureId: unknown,
  context: PopupContext,
): HTMLElement {
  const model = popupModel(layer, properties, featureId, context);
  const root = document.createElement('div');
  root.className = 'max-w-[240px]';

  const head = document.createElement('div');
  head.className = 'flex items-center gap-2';
  if (model.icon !== undefined) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '28');
    svg.setAttribute('height', '28');
    svg.setAttribute('class', 'shrink-0 rounded-full p-1');
    svg.setAttribute('style', `background:${model.icon.colour}`);
    const glyph: { stroke?: readonly string[]; fill?: readonly string[] } = GLYPHS[model.icon.glyph];
    for (const d of glyph.fill ?? []) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', palette.cream);
      svg.append(path);
    }
    for (const d of glyph.stroke ?? []) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', palette.cream);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.append(path);
    }
    head.append(svg);
  }
  const title = document.createElement('div');
  title.className = 'font-display text-base leading-tight';
  title.textContent = model.title;
  head.append(title);
  root.append(head);

  const add = (text: string, className: string): void => {
    const line = document.createElement('div');
    line.className = className;
    line.textContent = text;
    root.append(line);
  };
  if (model.name !== undefined) add(model.name, 'mt-1 text-sm font-bold');
  for (const detail of model.details) add(detail, 'text-sm text-inkSoft');
  if (model.note !== undefined) add(model.note, 'mt-1 text-sm font-bold text-ink');
  if (model.sourceUrl !== undefined) {
    const link = document.createElement('a');
    link.href = model.sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'mt-2 block text-sm font-bold text-ink underline';
    link.textContent = 'Today’s status at the official source';
    root.append(link);
  }
  if (model.osmUrl !== undefined) {
    const link = document.createElement('a');
    link.href = model.osmUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'mt-2 block text-xs text-inkSoft underline';
    link.textContent = 'Something wrong? Fix it on OpenStreetMap';
    root.append(link);
  }
  return root;
}

export default function MapView({
  centre,
  zoom,
  tilesUrl,
  enabledLayers,
  disabledLevels,
  pawBySurface,
  warnings,
  userPosition,
  onViewportChange,
  onDropPin,
  route,
  fit,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleReady = useRef(false);
  // Latest props for handlers registered once.
  const latest = useRef({ tilesUrl, enabledLayers, disabledLevels, pawBySurface, warnings, userPosition, onViewportChange, onDropPin, route });
  latest.current = { tilesUrl, enabledLayers, disabledLevels, pawBySurface, warnings, userPosition, onViewportChange, onDropPin, route };
  const markers = useRef<maplibregl.Marker[]>([]);

  /** Adds our source and layers if the style is ready and the URL known. Idempotent. */
  const syncPawpath = (map: MapLibreMap): void => {
    const url = latest.current.tilesUrl;
    if (!styleReady.current || url === undefined) return;
    const { specs } = pawpathLayerSpecs(latest.current.disabledLevels);
    if (map.getSource(PAWPATH_SOURCE_ID) === undefined) {
      registerIcons(map);
      map.addSource(PAWPATH_SOURCE_ID, {
        type: 'vector',
        url: `pmtiles://${url}`,
        attribution: [SOURCE_ATTRIBUTION.osm, SOURCE_ATTRIBUTION.eea]
          .map((s) => `<a href="${s.url}" target="_blank" rel="noopener">${s.label}</a>`)
          .join(' | '),
      });
      for (const spec of specs) map.addLayer(spec);
    } else {
      // Level filters changed: swap the filter expressions in place.
      for (const spec of specs) {
        if ('filter' in spec && spec.filter !== undefined) map.setFilter(spec.id, spec.filter);
      }
    }
    // Every path coloured by the live paw band of its own surface.
    const paws = latest.current.pawBySurface;
    const paint = surfacePaint(
      paws === undefined
        ? undefined
        : {
            asphalt: paws.asphalt.band,
            concrete: paws.concrete.band,
            sand: paws.sand.band,
            gravel: paws.gravel.band,
            grass: paws.grass.band,
          },
    );
    for (const id of SURFACE_LAYER_IDS) {
      if (map.getLayer(id) === undefined) continue;
      map.setPaintProperty(id, 'line-color', paint['line-color']);
      map.setPaintProperty(id, 'line-width', paint['line-width']);
    }

    if (map.getLayer(WATER_ICON_LAYER_ID) !== undefined) {
      map.setLayoutProperty(WATER_ICON_LAYER_ID, 'icon-image', waterIcon([...latest.current.warnings.byId.keys()]));
    }

    const enabled = new Set(latest.current.enabledLayers);
    for (const [key, ids] of Object.entries(IDS_BY_LAYER)) {
      const visibility = isLayerKey(key) && enabled.has(key) ? 'visible' : 'none';
      for (const id of ids) map.setLayoutProperty(id, 'visibility', visibility);
    }
  };

  const syncUser = (map: MapLibreMap): void => {
    if (!styleReady.current) return;
    const position = latest.current.userPosition;
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features:
        position === undefined
          ? []
          : [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [position.lng, position.lat] },
                properties: {},
              },
            ],
    };
    const source = map.getSource(USER_SOURCE_ID) as GeoJSONSource | undefined;
    if (source !== undefined) {
      source.setData(data);
      return;
    }
    map.addSource(USER_SOURCE_ID, { type: 'geojson', data });
    map.addLayer({
      id: 'pawpath-user-halo',
      type: 'circle',
      source: USER_SOURCE_ID,
      paint: { 'circle-radius': 16, 'circle-color': palette.terracotta, 'circle-opacity': 0.18 },
    });
    map.addLayer({
      id: 'pawpath-user-dot',
      type: 'circle',
      source: USER_SOURCE_ID,
      paint: {
        'circle-radius': 7,
        'circle-color': palette.terracotta,
        'circle-stroke-width': 3,
        'circle-stroke-color': palette.cream,
      },
    });
  };

  /** Route line (coloured by live paw band) and its draggable stops. */
  const syncRoute = (map: MapLibreMap): void => {
    if (!styleReady.current) return;
    const overlay = latest.current.route;
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: (overlay?.segments ?? []).map((segment) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: segment.coords.map((c) => [c[0], c[1]]) },
        properties: { band: segment.band ?? 'unknown', shaded: segment.shaded },
      })),
    };
    const source = map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    if (source !== undefined) source.setData(data);
    else {
      map.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data });
      // Below the user dot, above everything of ours.
      const before = map.getLayer('pawpath-user-halo') === undefined ? undefined : 'pawpath-user-halo';
      map.addLayer(
        {
          id: ROUTE_CASING_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          // Shaded stretches get a green edge: shade reads at a glance, and
          // not by colour alone — the edge is also wider.
          paint: {
            'line-color': ['case', ['get', 'shaded'], palette.sageDeep, palette.ink],
            'line-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              12,
              ['case', ['get', 'shaded'], 8, 6],
              18,
              ['case', ['get', 'shaded'], 18, 14],
            ],
          },
        },
        before,
      );
      map.addLayer(
        {
          id: ROUTE_LINE_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': [
              'match',
              ['get', 'band'],
              'danger',
              pawRisk.high,
              'caution',
              pawRisk.mid,
              'fine',
              pawRisk.low,
              palette.cream,
            ],
            'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 18, 8],
          },
        },
        before,
      );
      map.addSource(ROUTE_GHOST_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: ROUTE_GHOST_ID,
        type: 'circle',
        source: ROUTE_GHOST_ID,
        paint: {
          'circle-radius': 9,
          'circle-color': palette.cream,
          'circle-stroke-width': 3,
          'circle-stroke-color': palette.ink,
        },
      });
    }

    for (const marker of markers.current) marker.remove();
    markers.current = [];
    const waypoints = overlay?.waypoints ?? [];
    waypoints.forEach((wp, index) => {
      const isEnd = index === 0 || index === waypoints.length - 1;
      const el = waypointElement(index === 0 ? 'S' : String(index + 1), isEnd);
      const marker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([wp[0], wp[1]]).addTo(map);
      let dragged = false;
      marker.on('dragstart', () => {
        dragged = true;
      });
      marker.on('dragend', () => {
        const p = marker.getLngLat();
        latest.current.route?.onMove(index, [p.lng, p.lat]);
      });
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        if (dragged) {
          dragged = false;
          return;
        }
        latest.current.route?.onRemove(index);
      });
      markers.current.push(marker);
    });
  };

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || mapRef.current !== null) return;
    registerPmtiles();

    const map = new maplibregl.Map({
      container,
      // Placeholder until the real style loads, so the first paint is cream.
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': palette.cream } }],
      },
      center: [centre.lng, centre.lat],
      zoom,
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      attributionControl: false,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) {
      // Dev-only handle for diagnostics and the headless verification script.
      (window as unknown as { __pawpathMap?: MapLibreMap }).__pawpathMap = map;
    }

    map.setStyle(MAP_STYLE_URL, MAP_RECOLOUR_BASEMAP ? { transformStyle: warmBasemap } : {});

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: false,
        // Licence requirement (CLAUDE.md §10). The basemap style credits its
        // provider, our vector source credits OSM; this adds only an explicit
        // override for a style that credits nothing.
        // Open-Meteo is CC BY 4.0 and its data shows on the collapsed card too,
        // so its credit lives here, always visible — not only inside the card.
        customAttribution: [
          '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather: Open-Meteo</a>',
          ...(MAP_ATTRIBUTION === undefined ? [] : [MAP_ATTRIBUTION]),
        ],
      }),
      'bottom-right',
    );

    map.on('style.load', () => {
      // The placeholder style also fires this; only the real one counts.
      if (map.getStyle().layers.some((layer) => layer.id === 'bg')) return;
      styleReady.current = true;
      syncPawpath(map);
      syncUser(map);
      syncRoute(map);
    });

    const emitViewport = (): void => {
      const c = map.getCenter();
      latest.current.onViewportChange({ centre: { lat: c.lat, lng: c.lng }, zoom: map.getZoom() });
    };
    map.on('load', emitViewport);
    map.on('moveend', emitViewport);

    // Dragging the route line drops a via point where it is released; a tap
    // on the line does the same. The click that follows must not add a stop.
    let suppressClick = false;
    let lineDrag: { moved: boolean } | undefined;
    const setGhost = (p: maplibregl.LngLat | undefined): void => {
      (map.getSource(ROUTE_GHOST_ID) as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features:
          p === undefined ? [] : [{ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: {} }],
      });
    };
    const startLineDrag = (event: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent): void => {
      if (latest.current.route === undefined) return;
      if ('points' in event && event.points.length !== 1) return;
      event.preventDefault(); // no panning while dragging the line
      lineDrag = { moved: false };
      setGhost(event.lngLat);
      // Released outside the map: the map never sees it. Cancel the drag.
      const release = event.type === 'touchstart' ? 'touchend' : 'mouseup';
      window.addEventListener(
        release,
        () => {
          if (lineDrag === undefined) return;
          lineDrag = undefined;
          setGhost(undefined);
        },
        { once: true },
      );
    };
    const moveLineDrag = (event: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent): void => {
      if (lineDrag === undefined) return;
      lineDrag.moved = true;
      setGhost(event.lngLat);
    };
    const endLineDrag = (event: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent): void => {
      if (lineDrag === undefined) return;
      lineDrag = undefined;
      setGhost(undefined);
      suppressClick = true;
      setTimeout(() => {
        suppressClick = false;
      }, 400);
      latest.current.route?.onInsert([event.lngLat.lng, event.lngLat.lat]);
    };
    map.on('mousedown', ROUTE_LINE_ID, startLineDrag);
    map.on('touchstart', ROUTE_LINE_ID, startLineDrag);
    map.on('mousemove', moveLineDrag);
    map.on('touchmove', moveLineDrag);
    map.on('mouseup', endLineDrag);
    map.on('touchend', endLineDrag);

    map.on('click', (event) => {
      if (!styleReady.current) return;
      if (latest.current.route !== undefined) {
        if (!suppressClick) latest.current.route.onAdd([event.lngLat.lng, event.lngLat.lat]);
        return;
      }
      const layers = ALL_PAWPATH_IDS.filter((id) => map.getLayer(id) !== undefined);
      const [hit] = map.queryRenderedFeatures(event.point, { layers });
      const layer = hit?.sourceLayer;
      if (hit === undefined || layer === undefined || !isLayerKey(layer)) return;
      new maplibregl.Popup({ closeButton: false, maxWidth: '260px' })
        .setLngLat(event.lngLat)
        .setDOMContent(
          popupContent(layer, hit.properties, hit.id, {
            ...(latest.current.pawBySurface === undefined ? {} : { pawBySurface: latest.current.pawBySurface }),
            warnings: latest.current.warnings,
          }),
        )
        .addTo(map);
    });

    map.on('contextmenu', (event) => {
      if (latest.current.route !== undefined) return;
      latest.current.onDropPin({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    });

    // Long-press equivalent for touch, where there is no right-click.
    let longPress: ReturnType<typeof setTimeout> | undefined;
    const clearLongPress = (): void => {
      if (longPress !== undefined) clearTimeout(longPress);
      longPress = undefined;
    };
    map.on('touchstart', (event) => {
      clearLongPress();
      if (latest.current.route !== undefined) return;
      const { lngLat } = event;
      longPress = setTimeout(() => {
        latest.current.onDropPin({ lat: lngLat.lat, lng: lngLat.lng });
      }, 600);
    });
    map.on('touchend', clearLongPress);
    map.on('touchmove', clearLongPress);
    map.on('movestart', clearLongPress);

    return () => {
      clearLongPress();
      for (const marker of markers.current) marker.remove();
      markers.current = [];
      map.remove();
      mapRef.current = null;
      styleReady.current = false;
    };
    // Mount once: centre/zoom are the initial camera; later changes go below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mapRef.current?.easeTo({ center: [centre.lng, centre.lat], zoom, duration: 600 });
  }, [centre.lat, centre.lng, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (map !== null) syncPawpath(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesUrl, enabledLayers, disabledLevels, pawBySurface, warnings]);

  useEffect(() => {
    const map = mapRef.current;
    if (map !== null) syncUser(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userPosition]);

  useEffect(() => {
    const map = mapRef.current;
    if (map !== null) syncRoute(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route?.waypoints, route?.segments, route === undefined]);

  useEffect(() => {
    if (fit === undefined) return;
    mapRef.current?.fitBounds([fit.bounds[0] as [number, number], fit.bounds[1] as [number, number]], {
      padding: { top: 140, bottom: 260, left: 40, right: 60 },
      maxZoom: 16,
      duration: 600,
    });
  }, [fit?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className="h-full w-full" data-testid="map-canvas" />;
}
