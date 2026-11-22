/** Continuous position while "walk it" mode is on; off otherwise (battery). */

import { useEffect, useState } from 'react';

import { GEOLOCATION_TIMEOUT_MS } from '../../config';
import type { LngLat } from '../../lib/routing/route';

export function useWatchPosition(enabled: boolean): { position: LngLat | undefined; error: string | undefined } {
  const [position, setPosition] = useState<LngLat | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      setPosition(undefined);
      setError(undefined);
      return;
    }
    if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
      setError('This browser cannot share your location, so the walk cannot be followed.');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setPosition([p.coords.longitude, p.coords.latitude]);
        setError(undefined);
      },
      (e) =>
        setError(
          e.code === e.PERMISSION_DENIED
            ? 'Location access is blocked, so the walk cannot be followed.'
            : 'Looking for your position…',
        ),
      { enableHighAccuracy: true, timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: 5_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);

  return { position, error };
}
