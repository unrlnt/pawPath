/** "Find nearby": search the tiles around a point, widening until found. */

import { useCallback, useRef, useState } from 'react';

import { NEARBY_TILE_RINGS } from '../../config';
import { walkGraphSourceFor } from '../../data/sources/walkGraphSource';
import { nearest, type NearbyKind, type NearbyResult } from '../../lib/nearby';
import type { LngLat } from '../../lib/routing/route';

export type NearbyState =
  | { readonly s: 'idle' }
  | { readonly s: 'searching'; readonly kind: NearbyKind }
  | { readonly s: 'found'; readonly kind: NearbyKind; readonly results: readonly NearbyResult[] }
  | { readonly s: 'none'; readonly kind: NearbyKind }
  | { readonly s: 'failed'; readonly kind: NearbyKind; readonly message: string };

export function useNearby(tilesUrl: string | undefined) {
  const [state, setState] = useState<NearbyState>({ s: 'idle' });
  const run = useRef(0);

  const search = useCallback(
    async (kind: NearbyKind, from: LngLat): Promise<void> => {
      if (tilesUrl === undefined) {
        setState({ s: 'failed', kind, message: 'Map data is not available yet.' });
        return;
      }
      const id = (run.current += 1);
      setState({ s: 'searching', kind });
      const source = walkGraphSourceFor(tilesUrl);
      for (const ring of NEARBY_TILE_RINGS) {
        const pois = await source.poisNear(from, ring);
        if (id !== run.current) return; // a newer search won
        if (pois === undefined) {
          setState({ s: 'failed', kind, message: 'Map data could not be loaded. Check your connection.' });
          return;
        }
        const results = nearest(pois, from, kind);
        if (results.length > 0) {
          setState({ s: 'found', kind, results });
          return;
        }
      }
      setState({ s: 'none', kind });
    },
    [tilesUrl],
  );

  const reset = useCallback(() => {
    run.current += 1;
    setState({ s: 'idle' });
  }, []);

  return { state, search, reset };
}
