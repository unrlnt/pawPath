/**
 * Reporting what's missing (Phase 12): the text of an anonymous OSM note.
 *
 * Permanent features only — never temporary states like algae or a broken
 * tap today: OSM is not for transient conditions, and a "warning" from an
 * unknown user would wrongly look official (CLAUDE.md §6, §11 Phase 12).
 */

import { NOTE_MAX_LENGTH } from '../config';
import type { FeatureLevel, LayerKey } from '../data/layers';

export const REPORT_KINDS = {
  bench: { label: 'Bench', tags: 'amenity=bench' },
  bin: { label: 'Waste bin', tags: 'amenity=waste_basket' },
  dogBin: { label: 'Dog-waste bin', tags: 'amenity=waste_basket + waste=dog_excrement' },
  bagDispenser: { label: 'Poop-bag dispenser', tags: 'vending=excrement_bags' },
  drinkingWater: { label: 'Drinking-water tap', tags: 'amenity=drinking_water' },
} as const;

export type ReportKind = keyof typeof REPORT_KINDS;
export const REPORT_KIND_KEYS = Object.keys(REPORT_KINDS) as ReportKind[];

export interface Report {
  readonly kind: ReportKind;
  /** `missing`: exists but not on the map. `gone`: on the map but not there. */
  readonly change: 'missing' | 'gone';
  /** The mapped object, for `gone`. */
  readonly osmUrl?: string | undefined;
  /** Free text from the walker, optional. */
  readonly comment?: string | undefined;
}

/** Which kind a tapped map feature is, if it can be reported at all. */
export function reportKindFor(layer: LayerKey, level: FeatureLevel | undefined): ReportKind | undefined {
  if (layer === 'benches') return 'bench';
  if (layer === 'drinkingWater') return 'drinkingWater';
  if (layer === 'waste') return level === 'dog_bin' ? 'dogBin' : level === 'bag_dispenser' ? 'bagDispenser' : 'bin';
  return undefined;
}

/** The note as sent: what, where to look, and that a volunteer should check. */
export function noteText(report: Report, appUrl: string): string {
  const kind = REPORT_KINDS[report.kind];
  const head =
    report.change === 'missing'
      ? `${kind.label} here, not yet on the map (suggested tags: ${kind.tags}).`
      : `The ${kind.label.toLowerCase()} mapped here seems to be gone${report.osmUrl === undefined ? '' : `: ${report.osmUrl}`}.`;
  const comment = report.comment?.trim();
  const tail = `Reported anonymously via PawPath (${appUrl}). Please check on the ground before editing.`;
  return [head, comment === undefined || comment === '' ? undefined : comment, tail]
    .filter((part): part is string => part !== undefined)
    .join('\n\n')
    .slice(0, NOTE_MAX_LENGTH);
}
