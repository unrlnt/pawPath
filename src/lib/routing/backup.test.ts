import { describe, expect, it } from 'vitest';

import { mergeWalks, parseWalksBackup, walksBackup, type SavedRoute } from './io';

const walk = (id: string, savedAt: number): SavedRoute => ({
  id,
  name: `Walk ${id}`,
  waypoints: [
    [5.2, 52.3],
    [5.21, 52.31],
  ],
  roundTrip: false,
  savedAt,
});

describe('walk backups', () => {
  it('round-trips through the file', () => {
    const routes = [walk('a', 2), walk('b', 1)];
    expect(parseWalksBackup(walksBackup(routes))).toEqual(routes);
  });

  it('refuses files that are not a PawPath backup', () => {
    expect(parseWalksBackup('not json')).toBeUndefined();
    expect(parseWalksBackup(JSON.stringify([walk('a', 1)]))).toBeUndefined();
    expect(parseWalksBackup(JSON.stringify({ format: 'other', walks: [] }))).toBeUndefined();
  });

  it('drops broken walks inside a real backup', () => {
    const text = JSON.stringify({
      format: 'pawpath-walks',
      walks: [walk('ok', 1), { id: 'x', name: 'one stop', waypoints: [[5, 52]] }, { id: 'y', name: 'bad', waypoints: [[999, 52], [5, 52]] }],
    });
    expect(parseWalksBackup(text)?.map((w) => w.id)).toEqual(['ok']);
  });

  it('merges by id, newest first, within the cap', () => {
    const merged = mergeWalks([walk('a', 5)], [walk('a', 5), walk('b', 9), walk('c', 1)], 2);
    expect(merged.walks.map((w) => w.id)).toEqual(['b', 'a']);
    expect(merged.added).toBe(1);
    expect(merged.skipped).toBe(2);
  });
});
