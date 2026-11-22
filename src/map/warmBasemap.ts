/**
 * Repaints an OpenMapTiles-schema basemap (OpenFreeMap) in PawPath's palette:
 * muted, paper-like, so our own layers carry the colour (CLAUDE.md §10).
 *
 * Works on layer ids and types, and leaves anything it does not recognise
 * alone — a style update upstream degrades to "less warm", never to broken.
 */

import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';

import { palette } from '../styles/tokens';

const WARM = {
  background: palette.cream,
  residential: palette.creamDeep,
  green: '#E2EAD2',
  wood: '#D5E1C4',
  water: '#C3DCE2',
  waterLabel: '#4F7F8C',
  sand: '#F2E4C4',
  building: '#EBDECD',
  road: '#FFFFFF',
  casing: '#E6D8C4',
  rail: '#CDBDAA',
  label: palette.inkSoft,
} as const;

type Paint = Record<string, unknown>;

function setPaint(layer: LayerSpecification, values: Paint): void {
  const holder = layer as unknown as { paint?: Paint };
  holder.paint = { ...(holder.paint ?? {}), ...values };
}

function hide(layer: LayerSpecification): void {
  const holder = layer as unknown as { layout?: Paint };
  holder.layout = { ...(holder.layout ?? {}), visibility: 'none' };
}

function warmLayer(layer: LayerSpecification): void {
  const { id, type } = layer;

  if (type === 'background') return setPaint(layer, { 'background-color': WARM.background });
  if (type === 'raster') return setPaint(layer, { 'raster-saturation': -0.6, 'raster-opacity': 0.6 });
  if (type === 'fill-extrusion') return hide(layer);

  if (type === 'fill') {
    if (id === 'water') return setPaint(layer, { 'fill-color': WARM.water });
    if (id === 'landcover_wood') return setPaint(layer, { 'fill-color': WARM.wood });
    if (id === 'park' || id.startsWith('landcover_grass') || id === 'landuse_pitch')
      return setPaint(layer, { 'fill-color': WARM.green });
    if (id === 'landuse_residential') return setPaint(layer, { 'fill-color': WARM.residential });
    if (id === 'landcover_sand') return setPaint(layer, { 'fill-color': WARM.sand });
    if (id === 'building') return setPaint(layer, { 'fill-color': WARM.building, 'fill-outline-color': WARM.casing });
    return;
  }

  if (type === 'line') {
    if (id.startsWith('waterway')) return setPaint(layer, { 'line-color': WARM.water });
    if (id === 'park_outline') return hide(layer);
    if (id.includes('rail')) return setPaint(layer, { 'line-color': WARM.rail });
    if (/^(road|bridge|tunnel)_/.test(id)) {
      return setPaint(layer, { 'line-color': id.endsWith('_casing') ? WARM.casing : WARM.road });
    }
    return;
  }

  if (type === 'symbol') {
    // Shops and lesser POIs are noise on a dog-walk map.
    if (id === 'poi_r20' || id === 'poi_r7') return hide(layer);
    const isWater = id.startsWith('water');
    return setPaint(layer, {
      'text-color': isWater ? WARM.waterLabel : WARM.label,
      'text-halo-color': WARM.background,
    });
  }
}

/** For `map.setStyle(url, { transformStyle })`. */
export function warmBasemap(
  _previous: StyleSpecification | undefined,
  next: StyleSpecification,
): StyleSpecification {
  const style = structuredClone(next);
  style.layers.forEach(warmLayer);
  return style;
}
