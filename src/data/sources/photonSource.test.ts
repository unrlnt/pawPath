import { describe, expect, it } from 'vitest';

import { parsePhotonResponse, photonLabel } from './photonSource';

describe('parsePhotonResponse', () => {
  it('reads Photon GeoJSON into labelled places', () => {
    const results = parsePhotonResponse({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'Almere', state: 'Flevoland', country: 'Nederland' },
          geometry: { type: 'Point', coordinates: [5.2186, 52.3705] },
        },
      ],
    });
    expect(results).toEqual([{ label: 'Almere, Flevoland, Nederland', lat: 52.3705, lng: 5.2186 }]);
  });

  it('skips malformed features instead of throwing', () => {
    expect(parsePhotonResponse(null)).toEqual([]);
    expect(parsePhotonResponse({ features: [{ geometry: { coordinates: ['x', 1] } }, 42] })).toEqual([]);
  });
});

describe('photonLabel', () => {
  it('drops repeated parts, e.g. a city whose name equals its state', () => {
    expect(photonLabel({ name: 'Utrecht', city: 'Utrecht', state: 'Utrecht', country: 'NL' })).toBe(
      'Utrecht, NL',
    );
  });
});
