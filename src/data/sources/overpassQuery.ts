/**
 * Overpass QL generation.
 *
 * Queries are built entirely from the declarative selectors in `layers.ts`.
 * Nothing here knows what a bench or a forest is, which is what lets a new
 * layer be added without touching query-building code.
 */

import {
  APP_CONTACT_URL,
  APP_CONTACT_URL_UNSET,
  APP_NAME,
  OVERPASS_RESULT_CAP,
  OVERPASS_SERVER_TIMEOUT_S,
} from '../../config';
import type { BBox } from '../../lib/tiles';
import type { TagCondition, TagSelector } from './layers';

export type OverpassOutput = 'center' | 'geom';

export interface BuildQueryOptions {
  readonly bbox: BBox;
  readonly selectors: readonly TagSelector[];
  readonly output: OverpassOutput;
  /** Free-text appended to the identifying comment, e.g. the layer and tile id. */
  readonly context?: string;
  readonly serverTimeoutS?: number;
  readonly resultCap?: number;
}

/** Escapes a value for use inside an Overpass QL double-quoted string. */
export function escapeOverpassString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function renderCondition(condition: TagCondition): string {
  const key = escapeOverpassString(condition.key);
  switch (condition.op) {
    case 'equals':
      return `["${key}"="${escapeOverpassString(condition.value)}"]`;
    case 'notEquals':
      return `["${key}"!="${escapeOverpassString(condition.value)}"]`;
    case 'exists':
      return `["${key}"]`;
    case 'matches':
      return `["${key}"~"${escapeOverpassString(condition.pattern)}"]`;
  }
}

/** `(south,west,north,east)` — Overpass's bbox filter order. */
export function renderBBox(bbox: BBox): string {
  const round = (n: number): string => n.toFixed(6);
  return `(${round(bbox.south)},${round(bbox.west)},${round(bbox.north)},${round(bbox.east)})`;
}

function renderSelector(selector: TagSelector, bbox: BBox): string[] {
  const conditions = selector.conditions.map(renderCondition).join('');
  const filter = renderBBox(bbox);
  return selector.kinds.map((kind) => `  ${kind}${conditions}${filter};`);
}

/**
 * Builds one query covering every given selector as a single union.
 *
 * `out center` returns one representative coordinate per element and is what
 * amenity layers use; `out geom` returns full node lists and is only worth its
 * payload for polygons.
 */
export function buildOverpassQL(options: BuildQueryOptions): string {
  const {
    bbox,
    selectors,
    output,
    context,
    serverTimeoutS = OVERPASS_SERVER_TIMEOUT_S,
    resultCap = OVERPASS_RESULT_CAP,
  } = options;

  if (selectors.length === 0) {
    throw new Error('buildOverpassQL: at least one selector is required');
  }

  // Browsers forbid setting User-Agent, so the spec's "descriptive
  // User-Agent-equivalent" is carried as a query comment instead. Instance
  // operators read these in their logs, so an unset contact URL says exactly
  // that — a placeholder that looks like a real link is worse than none.
  const contact =
    APP_CONTACT_URL === APP_CONTACT_URL_UNSET
      ? 'contact URL not set — see APP_CONTACT_URL in src/config.ts'
      : APP_CONTACT_URL;
  const identity = `// ${APP_NAME} (${contact})${context === undefined ? '' : ` — ${context}`}`;

  const body = selectors.flatMap((selector) => renderSelector(selector, bbox));

  return [
    identity,
    `[out:json][timeout:${serverTimeoutS}];`,
    '(',
    ...body,
    ');',
    `out ${output} ${resultCap};`,
    '',
  ].join('\n');
}
