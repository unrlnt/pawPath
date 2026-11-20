/**
 * localStorage helpers.
 *
 * All user state lives here — there are no accounts (CLAUDE.md §2). Every
 * access is guarded: Safari in private mode throws on `localStorage.setItem`,
 * and losing a preference must never take the map down with it.
 */

export function readStored<T>(key: string, isValid: (value: unknown) => value is T): T | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode, quota, or storage disabled. Not worth surfacing.
  }
}

export function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // As above.
  }
}

export interface StoredLocation {
  readonly lat: number;
  readonly lng: number;
  readonly zoom: number;
  readonly label?: string;
}

export function isStoredLocation(value: unknown): value is StoredLocation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['lat'] === 'number' &&
    Number.isFinite(candidate['lat']) &&
    Math.abs(candidate['lat']) <= 90 &&
    typeof candidate['lng'] === 'number' &&
    Number.isFinite(candidate['lng']) &&
    typeof candidate['zoom'] === 'number' &&
    Number.isFinite(candidate['zoom'])
  );
}

export function isTrue(value: unknown): value is true {
  return value === true;
}
