/**
 * Geolocation with every outcome named.
 *
 * The browser API collapses a lot of very different situations into one error
 * callback, and each needs different words to the user: a denial is permanent
 * until they change a browser setting, a timeout is worth retrying, and an
 * insecure origin cannot work at all. Guessing produces "location unavailable"
 * for all of them, which tells the user nothing about what to do.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { GEOLOCATION_TIMEOUT_MS, GEOLOCATION_WATCH_MAX_AGE_MS } from '../../config';

export type GeolocationStatus =
  | 'idle'
  /** Waiting on the browser, which may be showing a permission prompt. */
  | 'prompting'
  | 'granted'
  /** Refused by the user or by policy. Only they can undo it. */
  | 'denied'
  /** No geolocation API, or an insecure origin. Nothing to retry. */
  | 'unavailable'
  /** The device could not get a fix in time. Worth retrying. */
  | 'timeout'
  /** Hardware or OS-level failure. */
  | 'positionUnavailable';

export interface GeolocationState {
  readonly status: GeolocationStatus;
  readonly position: { lat: number; lng: number; accuracyM: number } | undefined;
  readonly message: string;
}

const MESSAGES: Record<GeolocationStatus | 'insecure', string> = {
  idle: '',
  prompting: 'Asking your browser for your location…',
  granted: '',
  denied: 'Location access is blocked. Search for a place instead, or allow it in your browser settings.',
  unavailable:
    'This browser cannot share a location here. Location needs a secure (https) page. Search for a place instead.',
  insecure:
    'Your location only works on a secure (https) page. This one is plain http, so the browser refuses without asking. Search for a place instead.',
  timeout: 'Could not get a fix in time. Try again, or search for a place.',
  positionUnavailable: 'Your device could not determine a position. Try again, or search for a place.',
};

/**
 * Your position, kept live: after the first request the browser is watched
 * (`watchPosition`) while the page is visible, so the dot moves with you.
 * The watch pauses when the page is hidden (battery) and resumes when it is
 * shown again. Once a position is known, a later timeout keeps the last
 * position instead of showing an error: the watch simply tries again.
 */
export function useGeolocation(): GeolocationState & { request: () => void } {
  const [state, setState] = useState<GeolocationState>({
    status: 'idle',
    position: undefined,
    message: '',
  });
  const mounted = useRef(true);
  const watchId = useRef<number | undefined>(undefined);
  /** Set once the walker asked for their location (on load, or the ◎ button). */
  const wanted = useRef(false);

  const stopWatch = useCallback(() => {
    if (watchId.current !== undefined) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = undefined;
  }, []);

  const startWatch = useCallback(() => {
    stopWatch();
    watchId.current = navigator.geolocation.watchPosition(
      (position) => {
        if (!mounted.current) return;
        setState({
          status: 'granted',
          position: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracyM: position.coords.accuracy,
          },
          message: '',
        });
      },
      (error) => {
        if (!mounted.current) return;
        const status: GeolocationStatus =
          error.code === error.PERMISSION_DENIED
            ? 'denied'
            : error.code === error.TIMEOUT
              ? 'timeout'
              : 'positionUnavailable';
        console.warn('[geolocation] failed', { code: error.code, message: error.message });
        if (status === 'denied') stopWatch();
        // Already have a fix: keep it; the watch keeps trying on its own.
        setState((current) =>
          status !== 'denied' && current.position !== undefined
            ? current
            : { status, position: undefined, message: MESSAGES[status] },
        );
      },
      {
        enableHighAccuracy: true,
        timeout: GEOLOCATION_TIMEOUT_MS,
        maximumAge: GEOLOCATION_WATCH_MAX_AGE_MS,
      },
    );
  }, [stopWatch]);

  useEffect(() => {
    mounted.current = true;
    const onVisibility = (): void => {
      if (!wanted.current) return;
      if (document.visibilityState === 'hidden') stopWatch();
      else startWatch();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      if (watchId.current !== undefined && typeof navigator !== 'undefined') stopWatch();
    };
  }, [startWatch, stopWatch]);

  const request = useCallback(() => {
    // On plain http (e.g. a test domain before TLS is set up) browsers refuse
    // location without ever asking. Say so, instead of "blocked by you".
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setState({ status: 'unavailable', position: undefined, message: MESSAGES.insecure });
      return;
    }
    // `navigator.geolocation` is absent entirely on insecure origins in some
    // browsers, and present-but-always-failing in others.
    if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
      setState({ status: 'unavailable', position: undefined, message: MESSAGES.unavailable });
      return;
    }
    wanted.current = true;
    setState((current) =>
      current.position !== undefined ? current : { status: 'prompting', position: undefined, message: MESSAGES.prompting },
    );
    startWatch();
  }, [startWatch]);

  return { ...state, request };
}
