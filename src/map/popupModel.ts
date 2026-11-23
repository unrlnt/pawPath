/**
 * What a popup says about a feature (CLAUDE.md §6: "the exact value in the
 * popup"). Pure: built from the tile feature's properties and id only.
 */

import { LEVEL_LABELS } from '../data/levelLabels';
import { isFeatureLevel, type FeatureLevel, type LayerKey } from '../data/layers';
import { BATHING_SEASON_MONTHS } from '../config';
import type { WaterWarning, WaterWarnings } from '../data/sources/waterWarnings';
import type { PawBand } from '../lib/conditions/paw';
import type { PawsByExposure } from '../lib/conditions/pawBySurface';
import type { Exposure } from '../lib/routing/shade';
import { surfaceKindFor } from '../lib/surface';
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
  /** Official page for non-OSM data ("today's status"). */
  readonly sourceUrl?: string | undefined;
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
    case 'toilets': {
      const access = str(p['access']);
      if (access === 'customers') out.push('For customers only');
      const fee = str(p['fee']);
      if (fee === 'no') out.push('Free');
      else if (fee !== undefined && fee !== 'no') out.push(fee === 'yes' ? 'Costs a fee' : `Fee: ${human(fee)}`);
      if (str(p['wheelchair']) === 'yes') out.push('Wheelchair accessible');
      if (str(p['changing_table']) === 'yes') out.push('Baby changing table');
      const hours = str(p['opening_hours']);
      if (hours !== undefined) out.push(`Open: ${hours}`);
      break;
    }
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
  toilets: 'Public toilet',
};

const NOTES: Partial<Record<FeatureLevel, string>> = {
  allowed_leash_unknown:
    'Dogs are allowed here, but no leash rule is mapped. Local law applies — in the Netherlands and Germany that usually means on a leash.',
  off_leash: 'Mapped as off-leash. Check local signs: rules can change by season (e.g. breeding season).',
  monitored: 'An official bathing spot with no warning on record. This is not a safety guarantee.',
};

export interface PopupContext {
  /** Live paw estimate per shade level and surface kind; absent until conditions load. */
  readonly paws?: PawsByExposure;
  /** This path's shade (map feature-state); absent or 'sun' = full sun. */
  readonly shade?: Exposure;
  /** Runtime water warnings by bathing-site id. */
  readonly warnings?: WaterWarnings;
  /** 1-based month "now", for the bathing-season note. Injectable for tests. */
  readonly month?: number;
}

const WARNING_KIND_TEXT: Readonly<Record<WaterWarning['kind'], string>> = {
  bluegreen_algae: 'Blue-green algae',
  bacteria: 'Bacteria above the limit',
  pollution: 'Pollution',
  swimming_ban: 'Swimming ban',
  other: 'Official warning',
};

/**
 * Bathing sites (EEA): what is known, from whom and when — never "safe".
 * A warning, when the runtime feed names this site, replaces the neutral state.
 */
function bathingSitePopup(properties: Record<string, unknown>, context: PopupContext): PopupModel {
  const bwid = str(properties['bwid']);
  const warning = bwid === undefined ? undefined : context.warnings?.byId.get(bwid);
  const details: string[] = [];
  const category = str(properties['category']);
  if (category !== undefined) details.push(`Official EU bathing spot · ${category.toLowerCase()}`);
  const quality = str(properties['quality']);
  const year = str(properties['quality_year']);
  if (quality !== undefined && year !== undefined) details.push(`EU classification (${year} season): ${quality}`);
  const month = context.month ?? new Date().getMonth() + 1;
  if (month < BATHING_SEASON_MONTHS.start || month > BATHING_SEASON_MONTHS.end) {
    details.push('Outside the bathing season: it is not being monitored right now.');
  }
  if (warning !== undefined) {
    details.unshift(warning.message);
    if (warning.since !== undefined) details.push(`Since ${warning.since}`);
  }
  const profile = str(properties['profile']);
  const sourceUrl = warning?.url ?? (profile !== undefined && /^https?:\/\//.test(profile) ? profile : undefined);
  return {
    icon: ICONS.water?.[warning === undefined ? 'monitored' : 'warning'],
    title: warning === undefined ? 'Official bathing spot' : WARNING_KIND_TEXT[warning.kind],
    name: str(properties['name']),
    details,
    note:
      warning === undefined
        ? 'No warning on record here — this is not a safety guarantee. Check today’s status at the official source before your dog goes in.'
        : 'Keep your dog out of the water. Blue-green algae and bacteria can make dogs seriously ill.',
    // Not OSM data, so no "fix it on OpenStreetMap" link: the official source instead.
    osmUrl: undefined,
    sourceUrl,
  };
}

const SHADE_WORDS: Readonly<Record<Exposure, string>> = {
  sun: 'in the sun',
  light: 'in light shade (trees alongside)',
  medium: 'in partial shade',
  dense: 'in the shade of trees',
};

const LIVE_PAW_TITLE: Readonly<Record<PawBand, string>> = {
  fine: 'Kind to paws right now',
  caution: 'Getting warm for paws',
  danger: 'Too hot for paws right now',
};

export function popupModel(
  layer: LayerKey,
  properties: Record<string, unknown>,
  featureId: unknown,
  context: PopupContext = {},
): PopupModel {
  if (layer === 'water') return bathingSitePopup(properties, context);
  const rawLevel = str(properties['level']);
  const level = rawLevel !== undefined && isFeatureLevel(rawLevel) ? rawLevel : undefined;
  const icons = ICONS[layer];
  const details = detailsFor(layer, properties);
  let title = level === undefined ? SINGULAR[layer] : LEVEL_LABELS[level];

  // Paths: say what the surface is like for paws NOW, not just its material.
  if (layer === 'surface' && context.paws !== undefined) {
    const kind = surfaceKindFor(str(properties['surface']));
    if (kind !== undefined) {
      const shade = context.shade ?? 'sun';
      const paw = context.paws[shade][kind];
      title = LIVE_PAW_TITLE[paw.band];
      details.unshift(`Paws now: about ${paw.lowC}–${paw.highC} °C ${SHADE_WORDS[shade]} (estimate)`);
    }
  }

  return {
    icon: (level === undefined ? undefined : icons?.[level]) ?? icons?.default,
    title,
    name: str(properties['name']),
    details,
    note: level === undefined ? undefined : NOTES[level],
    osmUrl: osmUrlFor(featureId),
  };
}
