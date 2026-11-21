/**
 * Licence credits per data source. Attribution is a licence requirement, not a
 * nicety (CLAUDE.md §10): every source present on screen must be credited.
 * Phase 8 adds regional sources here as they are merged into the tile build.
 */

export interface SourceAttribution {
  readonly label: string;
  readonly licence: string;
  readonly url: string;
}

export const SOURCE_ATTRIBUTION = {
  osm: {
    label: '© OpenStreetMap contributors',
    licence: 'ODbL 1.0',
    url: 'https://www.openstreetmap.org/copyright',
  },
} as const satisfies Record<string, SourceAttribution>;
