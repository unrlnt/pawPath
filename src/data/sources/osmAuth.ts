/**
 * Sign in with OpenStreetMap — OAuth 2.0 authorization code with PKCE, all in
 * the browser (owner, 2026-11-28). No server of ours and no accounts of ours:
 * OSM is the account; the access token is kept in this browser only.
 *
 * Flow: `startSignIn()` saves a random verifier and state in sessionStorage
 * and goes to OSM's consent page; OSM sends the walker back to the app root
 * with `?code=…&state=…`; `finishSignIn()` swaps the code for a token
 * (OSM's token endpoint allows this from browsers — iD does the same) and
 * reads the display name.
 */

import { OSM_API_URL, OSM_OAUTH_CLIENT_ID, OSM_OAUTH_SCOPES, OSM_WEBSITE_URL, STORAGE_KEYS } from '../../config';
import { readStored, removeStored, writeStored } from '../../lib/storage';

export interface OsmSession {
  readonly token: string;
  readonly user: string;
}

const PENDING_KEY = 'pawpath.osmSignIn.v1';

const isSession = (v: unknown): v is OsmSession =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as OsmSession).token === 'string' &&
  typeof (v as OsmSession).user === 'string';

export const osmSignInAvailable = (): boolean => OSM_OAUTH_CLIENT_ID !== undefined;

export const storedSession = (): OsmSession | undefined => readStored(STORAGE_KEYS.osmSession, isSession);

/** The app root, exactly as registered as redirect URI on openstreetmap.org. */
export const redirectUri = (): string => `${window.location.origin}/`;

const randomString = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

async function challengeFor(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface Pending {
  readonly verifier: string;
  readonly state: string;
  /** Anything the app wants back after the round trip (e.g. an open report). */
  readonly resume: unknown;
  /** The address bar's hash (a shared route) — OSM drops it on the way back. */
  readonly hash: string;
}

/** Leaves the app for OSM's consent page. */
export async function startSignIn(resume: unknown): Promise<void> {
  if (OSM_OAUTH_CLIENT_ID === undefined) return;
  const verifier = randomString(48);
  const state = randomString(16);
  const pending: Pending = { verifier, state, resume, hash: window.location.hash };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const url = new URL('/oauth2/authorize', OSM_WEBSITE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: OSM_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: OSM_OAUTH_SCOPES,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
  }).toString();
  window.location.assign(url.toString());
}

export type SignInOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'signedIn'; readonly session: OsmSession; readonly resume: unknown }
  | { readonly kind: 'failed'; readonly message: string; readonly resume: unknown };

let finishing: Promise<SignInOutcome> | undefined;

/**
 * On load: completes a sign-in if OSM just sent the walker back, and cleans
 * the URL. Runs once per page load; later callers get the same result (React
 * may run start-up effects twice, and the code can only be used once).
 */
export function finishSignIn(): Promise<SignInOutcome> {
  finishing ??= completeSignIn();
  return finishing;
}

async function completeSignIn(): Promise<SignInOutcome> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (code === null && error === null) return { kind: 'none' };

  let pending: Pending | undefined;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as Pending | undefined;
  } catch {
    pending = undefined;
  }
  sessionStorage.removeItem(PENDING_KEY);
  // Leave a clean address: no code in history, and the route hash restored.
  window.history.replaceState(null, '', `${window.location.pathname}${pending?.hash ?? ''}`);
  if (pending === undefined || pending === null) return { kind: 'none' };
  const resume = pending.resume;

  if (error !== null) {
    return { kind: 'failed', resume, message: error === 'access_denied' ? 'Sign-in cancelled.' : 'OpenStreetMap refused the sign-in.' };
  }
  if (params.get('state') !== pending.state || OSM_OAUTH_CLIENT_ID === undefined || code === null) {
    return { kind: 'failed', resume, message: 'The sign-in could not be checked. Please try again.' };
  }
  try {
    const response = await fetch(new URL('/oauth2/token', OSM_WEBSITE_URL), {
      method: 'POST',
      credentials: 'omit',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        client_id: OSM_OAUTH_CLIENT_ID,
        code_verifier: pending.verifier,
      }),
    });
    if (!response.ok) throw new Error(`token HTTP ${response.status}`);
    const token = ((await response.json()) as { access_token?: unknown }).access_token;
    if (typeof token !== 'string' || token === '') throw new Error('no access_token');
    const user = await displayName(token);
    const session: OsmSession = { token, user };
    writeStored(STORAGE_KEYS.osmSession, session);
    return { kind: 'signedIn', session, resume };
  } catch (cause) {
    console.warn('[osm sign-in] failed', cause);
    return { kind: 'failed', resume, message: 'Could not finish signing in with OpenStreetMap. Please try again.' };
  }
}

async function displayName(token: string): Promise<string> {
  const response = await fetch(new URL('/api/0.6/user/details.json', OSM_API_URL), {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'omit',
  });
  if (!response.ok) throw new Error(`user details HTTP ${response.status}`);
  const name = ((await response.json()) as { user?: { display_name?: unknown } }).user?.display_name;
  return typeof name === 'string' && name !== '' ? name : 'OpenStreetMap user';
}

/** Forgets the token here and asks OSM to revoke it (best effort). */
export function signOut(session: OsmSession | undefined): void {
  removeStored(STORAGE_KEYS.osmSession);
  if (session === undefined || OSM_OAUTH_CLIENT_ID === undefined) return;
  void fetch(new URL('/oauth2/revoke', OSM_WEBSITE_URL), {
    method: 'POST',
    credentials: 'omit',
    body: new URLSearchParams({ token: session.token, client_id: OSM_OAUTH_CLIENT_ID }),
  }).catch(() => undefined);
}
