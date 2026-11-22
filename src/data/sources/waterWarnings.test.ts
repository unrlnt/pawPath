import { describe, expect, it } from 'vitest';

import { parseWaterWarnings } from './waterWarnings';

describe('parseWaterWarnings', () => {
  it('reads the documented format', () => {
    const w = parseWaterWarnings({
      updatedAt: '2026-07-14T08:00:00Z',
      source: 'Example authority',
      warnings: [
        { bwid: 'NLBW07_VRL01', kind: 'bluegreen_algae', message: 'Blue-green algae: avoid contact.', since: '2026-07-12', url: 'https://example.org/notice' },
      ],
    });
    expect(w.byId.get('NLBW07_VRL01')).toEqual({
      bwid: 'NLBW07_VRL01',
      kind: 'bluegreen_algae',
      message: 'Blue-green algae: avoid contact.',
      since: '2026-07-12',
      url: 'https://example.org/notice',
    });
    expect(w.source).toBe('Example authority');
  });

  it('skips entries without an id or a message, and unknown kinds become "other"', () => {
    const w = parseWaterWarnings({
      warnings: [{ bwid: 'A' }, { message: 'x' }, { bwid: 'B', message: 'Closed', kind: 'aliens', url: 'javascript:alert(1)' }],
    });
    expect([...w.byId.keys()]).toEqual(['B']);
    expect(w.byId.get('B')?.kind).toBe('other');
    expect(w.byId.get('B')?.url).toBeUndefined();
  });

  it('treats garbage as "no warnings known"', () => {
    expect(parseWaterWarnings(null).byId.size).toBe(0);
    expect(parseWaterWarnings({ warnings: 'nope' }).byId.size).toBe(0);
  });
});

describe('the empty file the tiles container writes on start', () => {
  it('means no warnings, without errors', () => {
    const parsed = parseWaterWarnings({ updatedAt: null, source: null, warnings: [] });
    expect(parsed.byId.size).toBe(0);
  });
});
