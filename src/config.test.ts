import { describe, expect, it } from 'vitest';

import { nonEmptyEnv } from './config';

describe('nonEmptyEnv', () => {
  it('treats empty build args as unset, so defaults apply', () => {
    // docker-compose passes `${VITE_PHOTON_URL:-}` as an empty string.
    const env = nonEmptyEnv({ VITE_PHOTON_URL: '', VITE_MAP_STYLE_URL: '  ', VITE_X: 'https://x.test', DEV: true });
    expect(env['VITE_PHOTON_URL'] ?? 'default').toBe('default');
    expect(env['VITE_MAP_STYLE_URL']).toBeUndefined();
    expect(env['VITE_X']).toBe('https://x.test');
  });
});
