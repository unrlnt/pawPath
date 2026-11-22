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
  eea: {
    label: 'Bathing sites © European Environment Agency',
    licence: 'EEA standard re-use policy (attribution)',
    url: 'https://www.eea.europa.eu/en/legal-notice',
  },
  openMeteo: {
    label: 'Weather: Open-Meteo',
    licence: 'CC BY 4.0',
    url: 'https://open-meteo.com/',
  },
} as const satisfies Record<string, SourceAttribution>;
