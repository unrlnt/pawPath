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

import { GEOLOCATION_MAX_AGE_MS, GEOLOCATION_TIMEOUT_MS } from '../../config';

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

const MESSAGES: Record<GeolocationStatus, string> = {
  idle: '',
  prompting: 'Asking your browser for your location…',
  granted: '',
  denied: 'Location access is blocked. Search for a place instead, or allow it in your browser settings.',
  unavailable:
    'This browser cannot share a location here. Location needs a secure (https) page. Search for a place instead.',
  timeout: 'Could not get a fix in time. Try again, or search for a place.',
  positionUnavailable: 'Your device could not determine a position. Try again, or search for a place.',
};

export function useGeolocation(): GeolocationState & { request: () => void } {
  const [state, setState] = useState<GeolocationState>({
    status: 'idle',
    position: undefined,
    message: '',
  });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const request = useCallback(() => {
    // `navigator.geolocation` is absent entirely on insecure origins in some
    // browsers, and present-but-always-failing in others.
    if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
      setState({ status: 'unavailable', position: undefined, message: MESSAGES.unavailable });
      return;
    }

    setState({ status: 'prompting', position: undefined, message: MESSAGES.prompting });

    navigator.geolocation.getCurrentPosition(
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
        setState({ status, position: undefined, message: MESSAGES[status] });
      },
      {
        enableHighAccuracy: true,
        timeout: GEOLOCATION_TIMEOUT_MS,
        maximumAge: GEOLOCATION_MAX_AGE_MS,
      },
    );
  }, []);

  return { ...state, request };
}
