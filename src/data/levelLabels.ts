/**
 * Human wording for every level — popups, legend and toggles use these.
 * Safety wording stays plain (CLAUDE.md §10, design direction).
 */

import type { FeatureLevel, LayerKey } from './layers';

export const LEVEL_LABELS: Readonly<Record<FeatureLevel, string>> = {
  dense: 'Dense shade (forest)',
  medium: 'Some shade (scrub)',
  light: 'Light shade (tree row)',
  off_leash: 'Off-leash allowed',
  off_leash_fenced: 'Dog park (fenced, off-leash)',
  leashed: 'Leash required',
  prohibited: 'No dogs allowed',
  allowed_leash_unknown: 'Dogs allowed — leash rule unknown, local law applies',
  high: 'Hot surface (asphalt, concrete)',
  mid: 'Warm surface (gravel, compacted)',
  low: 'Cool surface (grass, dirt, sand)',
  general: 'Waste bin',
  dog_bin: 'Dog waste bin',
  bag_dispenser: 'Poop bag dispenser',
  warning: 'Official warning today',
  monitored: 'Official bathing spot — no warning on record. Not a safety guarantee.',
  candidate: 'Water (not monitored)',
};

export const LAYER_ICONS: Readonly<Record<LayerKey, string>> = {
  shade: '🌳',
  offLeash: '🐕',
  surface: '🐾',
  water: '💧',
  benches: '🪑',
  waste: '🗑️',
  drinkingWater: '🚰',
  toilets: '🚻',
};
