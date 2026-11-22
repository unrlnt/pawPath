/**
 * PawPath design tokens (CLAUDE.md §10, "Design direction").
 *
 * The ONE place colours are defined. Tailwind's theme (tailwind.config.js)
 * and every MapLibre style read from here, so UI and map always agree.
 * Plain data, no imports: tailwind.config.js loads this file through Node.
 */

export const palette = {
  /** Warm paper background. */
  cream: '#FBF6EC',
  creamDeep: '#F3EADB',
  /** Deep warm brown for text: 10:1+ on cream, readable in sunlight. */
  ink: '#3B2A20',
  inkSoft: '#6B5443',
  sage: '#8DA77B',
  sageDeep: '#5E7F4E',
  terracotta: '#D9714E',
  terracottaDeep: '#B5532F',
  sunny: '#F4C151',
  sunnyDeep: '#D99A1B',
  sky: '#9CC3CF',
  /** Golden retriever fur, for the mascot. */
  golden: '#E2A65A',
  goldenDeep: '#C27F35',
} as const;

/**
 * Safety colours: same meaning as everywhere (§6), softened tone, still
 * distinguishable from each other and paired with icons/patterns in Phase 4.
 */
export const safety = {
  offLeash: '#4F9A5B',
  leashed: '#E3A13A',
  prohibited: '#C8553D',
  /** dog=yes — permitted, leash unknown. Neutral, never green. */
  neutral: '#8C8279',
  warning: '#C8553D',
  monitored: '#E9E4DA',
  /** Badge for an official bathing site: neutral grey-blue, never green (§6). */
  monitoredBadge: '#6F8A97',
} as const;

/** Paw-heat risk ramp for surfaces: hot → cool. */
export const pawRisk = {
  high: '#D9714E',
  mid: '#F4C151',
  low: '#8DA77B',
} as const;

export const fonts = {
  display: ['Fredoka', 'ui-rounded', 'system-ui', 'sans-serif'],
  body: ['Nunito', 'system-ui', 'sans-serif'],
} as const;
