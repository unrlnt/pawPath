/**
 * Runtime water warnings (CLAUDE.md §6, Phase 6). Format: docs/water-warnings.md.
 *
 * The file is OPTIONAL. No file, an empty list, or a broken file all mean the
 * same thing to the map: no warning is known, so official sites stay in the
 * neutral "monitored" state — which never claims the water is safe.
 */

import { WATER_WARNINGS_URL } from '../../config';

export type WarningKind = 'bluegreen_algae' | 'bacteria' | 'pollution' | 'swimming_ban' | 'other';

export interface WaterWarning {
  /** EEA bathing water identifier, e.g. "NLBW07_VRL01". */
  readonly bwid: string;
  readonly kind: WarningKind;
  /** Plain-language text from the official source, shown verbatim. */
  readonly message: string;
  /** When the warning was issued (ISO date), if known. */
  readonly since: string | undefined;
  /** Link to the official notice. */
  readonly url: string | undefined;
}

export interface WaterWarnings {
  readonly updatedAt: string | undefined;
  /** Human-readable source credit, e.g. "Landesamt für Gesundheit Berlin". */
  readonly source: string | undefined;
  readonly byId: ReadonlyMap<string, WaterWarning>;
}

export const NO_WARNINGS: WaterWarnings = { updatedAt: undefined, source: undefined, byId: new Map() };

const KINDS: readonly WarningKind[] = ['bluegreen_algae', 'bacteria', 'pollution', 'swimming_ban', 'other'];

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const httpUrl = (v: unknown): string | undefined => {
  const s = text(v);
  return s !== undefined && /^https?:\/\//.test(s) ? s : undefined;
};

/** Defensive parse: an invalid entry is skipped, never trusted half-way. */
export function parseWaterWarnings(raw: unknown): WaterWarnings {
  if (typeof raw !== 'object' || raw === null) return NO_WARNINGS;
  const root = raw as Record<string, unknown>;
  const list = Array.isArray(root['warnings']) ? (root['warnings'] as unknown[]) : [];
  const byId = new Map<string, WaterWarning>();
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const bwid = text(e['bwid']);
    const message = text(e['message']);
    if (bwid === undefined || message === undefined) continue;
    const kind = KINDS.includes(e['kind'] as WarningKind) ? (e['kind'] as WarningKind) : 'other';
    byId.set(bwid, { bwid, kind, message, since: text(e['since']), url: httpUrl(e['url']) });
  }
  return { updatedAt: text(root['updatedAt']), source: text(root['source']), byId };
}

export async function loadWaterWarnings(signal?: AbortSignal): Promise<WaterWarnings> {
  try {
    const response = await fetch(new URL(WATER_WARNINGS_URL, window.location.href), {
      cache: 'no-cache',
      credentials: 'omit',
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return NO_WARNINGS; // 404 is the normal "no feed" case
    return parseWaterWarnings(await response.json());
  } catch {
    return NO_WARNINGS;
  }
}
