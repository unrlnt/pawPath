/**
 * Anonymous OpenStreetMap notes (Phase 12). No account, no key: the OSM API
 * accepts anonymous notes. The request is a CORS-safelisted form POST (no
 * preflight). One note per minute per browser, enforced here.
 */

import { NOTE_MIN_INTERVAL_MS, OSM_NOTE_PAGE, OSM_NOTES_URL, STORAGE_KEYS } from '../../config';
import { readStored, writeStored } from '../../lib/storage';

export type NoteOutcome =
  | { readonly ok: true; readonly id: number; readonly url: string }
  | { readonly ok: false; readonly message: string; readonly retryInS?: number };

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Seconds until another note may be sent (0 = now). */
export function noteCooldownS(now = Date.now()): number {
  const last = readStored(STORAGE_KEYS.lastNoteAt, isNumber) ?? 0;
  return Math.max(0, Math.ceil((last + NOTE_MIN_INTERVAL_MS - now) / 1000));
}

export async function createNote(lat: number, lng: number, text: string): Promise<NoteOutcome> {
  const wait = noteCooldownS();
  if (wait > 0) return { ok: false, message: `One note per minute — try again in ${wait} s.`, retryInS: wait };
  try {
    const response = await fetch(OSM_NOTES_URL, {
      method: 'POST',
      credentials: 'omit',
      body: new URLSearchParams({ lat: lat.toFixed(6), lon: lng.toFixed(6), text }),
    });
    if (!response.ok) {
      return { ok: false, message: `OpenStreetMap did not accept the note (HTTP ${response.status}). Try again later.` };
    }
    writeStored(STORAGE_KEYS.lastNoteAt, Date.now());
    const raw: unknown = await response.json();
    const id = (raw as { properties?: { id?: unknown } } | null)?.properties?.id;
    if (!isNumber(id)) return { ok: false, message: 'The note was sent, but OpenStreetMap gave no note number.' };
    return { ok: true, id, url: OSM_NOTE_PAGE.replace('{id}', String(id)) };
  } catch (cause) {
    console.warn('[notes] failed', cause);
    return { ok: false, message: 'Could not reach OpenStreetMap. Check your connection and try again.' };
  }
}
