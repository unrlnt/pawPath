/**
 * What a popup says about a feature (CLAUDE.md §6: "the exact value in the
 * popup"). Pure: built from the tile feature's properties and id only.
 */

import { LEVEL_LABELS } from '../data/levelLabels';
import { isFeatureLevel, type FeatureLevel, type LayerKey } from '../data/layers';
import { ICONS, type IconSpec } from './icons';

export interface PopupModel {
  readonly icon: IconSpec | undefined;
  readonly title: string;
  readonly name: string | undefined;
  readonly details: readonly string[];
  /** Plain-language caveat, shown emphasised. */
  readonly note: string | undefined;
  /** "Something wrong? Fix it on OpenStreetMap." */
  readonly osmUrl: string | undefined;
}

const OSM_TYPES: Readonly<Record<number, string>> = { 1: 'node', 2: 'way', 3: 'relation' };

/**
 * Planetiler encodes OSM ids as `osmId × 10 + type` (1 node, 2 way,
 * 3 relation) — verified against the Flevoland build.
 */
export function osmUrlFor(featureId: unknown): string | undefined {
  if (typeof featureId !== 'number' || !Number.isSafeInteger(featureId) || featureId <= 0) return undefined;
  const type = OSM_TYPES[featureId % 10];
  if (type === undefined) return undefined;
  return `https://www.openstreetmap.org/${type}/${Math.floor(featureId / 10)}`;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const human = (value: string): string => value.replace(/_/g, ' ');

function detailsFor(layer: LayerKey, p: Record<string, unknown>): string[] {
  const out: string[] = [];
  switch (layer) {
    case 'benches': {
      const backrest = str(p['backrest']);
      if (backrest === 'yes') out.push('With a backrest');
      if (backrest === 'no') out.push('No backrest');
      const material = str(p['material']);
      if (material !== undefined) out.push(`Made of ${human(material)}`);
      break;
    }
    case 'drinkingWater':
      if (str(p['bottle']) === 'yes') out.push('Bottle refill');
      if (str(p['dog']) === 'yes') out.push('Dog-friendly (bowl or low tap)');
      break;
    case 'waste':
      if (str(p['waste'])?.includes('dog_excrement') === true) out.push('Takes dog waste');
      if (str(p['vending']) === 'excrement_bags') out.push('Dispenses poop bags');
      break;
    case 'offLeash': {
      const dog = str(p['dog']);
      if (dog !== undefined) out.push(`Mapped as dog=${dog}`);
      if (str(p['leisure']) === 'dog_park') out.push('Dog park');
      if (str(p['barrier']) !== undefined) out.push(`Barrier: ${human(str(p['barrier']) ?? '')}`);
      break;
    }
    case 'surface': {
      const surface = str(p['surface']);
      if (surface !== undefined) out.push(`Surface: ${human(surface)}`);
      const highway = str(p['highway']);
      if (highway !== undefined) out.push(`Path type: ${human(highway)}`);
      break;
    }
    case 'shade': {
      const leaf = str(p['leaf_type']);
      if (leaf !== undefined) out.push(`Trees: ${human(leaf)}`);
      break;
    }
    case 'water':
      break;
  }
  return out;
}

/** One feature, one thing: "Bench", not the layer name "Benches". */
const SINGULAR: Readonly<Record<LayerKey, string>> = {
  shade: 'Shade',
  offLeash: 'Dog rules',
  surface: 'Path surface',
  water: 'Water',
  benches: 'Bench',
  waste: 'Bin',
  drinkingWater: 'Drinking water',
};

const NOTES: Partial<Record<FeatureLevel, string>> = {
  allowed_leash_unknown:
    'Dogs are allowed here, but no leash rule is mapped. Local law applies — in the Netherlands and Germany that usually means on a leash.',
  off_leash: 'Mapped as off-leash. Check local signs: rules can change by season (e.g. breeding season).',
  monitored: 'An official bathing spot with no warning on record. This is not a safety guarantee.',
};

export function popupModel(layer: LayerKey, properties: Record<string, unknown>, featureId: unknown): PopupModel {
  const rawLevel = str(properties['level']);
  const level = rawLevel !== undefined && isFeatureLevel(rawLevel) ? rawLevel : undefined;
  const icons = ICONS[layer];
  return {
    icon: (level === undefined ? undefined : icons?.[level]) ?? icons?.default,
    title: level === undefined ? SINGULAR[layer] : LEVEL_LABELS[level],
    name: str(properties['name']),
    details: detailsFor(layer, properties),
    note: level === undefined ? undefined : NOTES[level],
    osmUrl: osmUrlFor(featureId),
  };
}
