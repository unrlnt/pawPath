/**
 * The OpenStreetMap sign-in as React state: finishes a sign-in on load when
 * OSM just sent the walker back, and hands back what the app asked to resume
 * (an open report). Only used by walkers who choose to sign in.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  finishSignIn,
  osmSignInAvailable,
  signOut as revoke,
  startSignIn,
  storedSession,
  type OsmSession,
} from '../../data/sources/osmAuth';

export function useOsmSession(onResume: (resume: unknown) => void) {
  const [session, setSession] = useState<OsmSession | undefined>(() => storedSession());
  const [message, setMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void finishSignIn().then((outcome) => {
      if (!alive || outcome.kind === 'none') return;
      if (outcome.kind === 'signedIn') {
        setSession(outcome.session);
        setMessage(`Signed in to OpenStreetMap as ${outcome.session.user}.`);
      } else {
        setMessage(outcome.message);
      }
      onResume(outcome.resume);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear the one-line message after a while.
  useEffect(() => {
    if (message === undefined) return;
    const timer = setTimeout(() => setMessage(undefined), 6_000);
    return () => clearTimeout(timer);
  }, [message]);

  const signIn = useCallback((resume: unknown) => void startSignIn(resume), []);
  const signOut = useCallback(() => {
    revoke(session);
    setSession(undefined);
    setMessage('Signed out of OpenStreetMap on this device.');
  }, [session]);
  /** The token was refused (expired or revoked): forget it here. */
  const expire = useCallback(() => {
    revoke(undefined);
    setSession(undefined);
  }, []);

  return { available: osmSignInAvailable(), session, message, signIn, signOut, expire };
}

export type OsmSessionState = ReturnType<typeof useOsmSession>;
