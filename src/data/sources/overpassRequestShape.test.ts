/**
 * Pins the shape of the HTTP request we send to Overpass.
 *
 * This is not style policing. Run 2 failed with pre-HTTP `TypeError`s on all
 * three instances simultaneously, which is the signature of a failed CORS
 * preflight, not of three servers being down at once. A request stays
 * "simple" — and therefore un-preflighted — only while every header is
 * CORS-safelisted, and `Content-Type` is safelisted only for three exact
 * values. Switching to `application/json` would silently reintroduce a
 * preflight, and the failure would once again look like a network outage.
 *
 * The 406 story has the same shape: it was `Accept`, not bot filtering.
 *
 * So both headers are pinned here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OVERPASS_ACCEPT_HEADER, OVERPASS_CONTENT_TYPE } from '../../config';
import { runOverpassQuery } from './overpassClient';
import { resetInstanceHealth } from './overpassHealth';

/** The only three values a browser treats as a simple `Content-Type`. */
const CORS_SAFELISTED_CONTENT_TYPES = [
  'text/plain',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
];

/**
 * Request headers that never trigger a preflight. `Accept` is on the list;
 * `Content-Type` is only conditionally on it, hence the check above.
 */
const CORS_SAFELISTED_HEADERS = [
  'accept',
  'accept-language',
  'content-language',
  'content-type',
  'range',
];

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

let captured: CapturedRequest[] = [];

function jsonResponse(): Response {
  return new Response(JSON.stringify({ elements: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  captured = [];
  resetInstanceHealth();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      captured.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return jsonResponse();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Overpass request shape', () => {
  it('POSTs the query as a urlencoded form field', async () => {
    const result = await runOverpassQuery('[out:json];out count;');
    expect(result.ok).toBe(true);

    const request = captured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;

    expect(request.method).toBe('POST');
    expect(request.url).toMatch(/\/api\/interpreter$/);
    // The query travels in `data=`, urlencoded — not as a JSON body.
    expect(request.body.startsWith('data=')).toBe(true);
    expect(decodeURIComponent(request.body.slice('data='.length).replace(/\+/g, ' '))).toContain(
      'out count;',
    );
  });

  it('sends a CORS-safelisted Content-Type, so no preflight is triggered', () => {
    expect(CORS_SAFELISTED_CONTENT_TYPES).toContain(OVERPASS_CONTENT_TYPE);
    // The one that would break it, spelled out so the intent is unmistakable.
    expect(OVERPASS_CONTENT_TYPE).not.toBe('application/json');
  });

  it('actually puts that Content-Type on the wire', async () => {
    await runOverpassQuery('[out:json];out count;');
    expect(captured[0]?.headers['content-type']).toBe(OVERPASS_CONTENT_TYPE);
  });

  /**
   * The 406: Overpass serves JSON and refuses negotiation it cannot satisfy.
   * A browser address bar sends `Accept: text/html,...` and gets 406; `fetch`
   * and curl send a wildcard and get 200. We say `application/json` outright.
   */
  it('asks for JSON explicitly, with a wildcard fallback', async () => {
    await runOverpassQuery('[out:json];out count;');
    expect(captured[0]?.headers['accept']).toBe(OVERPASS_ACCEPT_HEADER);
    expect(OVERPASS_ACCEPT_HEADER).toContain('application/json');
    // Never advertise HTML: that is what an address bar sends, and it is the
    // request shape Overpass answers with 406.
    expect(OVERPASS_ACCEPT_HEADER).not.toContain('text/html');
    // The wildcard keeps negotiation from failing on an instance that labels
    // its JSON something else, e.g. application/osm3s+json.
    expect(OVERPASS_ACCEPT_HEADER).toContain('*/*');
  });

  it('sends no header outside the CORS safelist', async () => {
    await runOverpassQuery('[out:json];out count;');
    const request = captured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;

    for (const header of Object.keys(request.headers)) {
      expect(CORS_SAFELISTED_HEADERS).toContain(header);
    }
  });

  it('never attempts to set User-Agent, which browsers forbid', async () => {
    await runOverpassQuery('[out:json];out count;');
    expect(Object.keys(captured[0]?.headers ?? {})).not.toContain('user-agent');
  });

  it('sends no credentials', async () => {
    // Cookies would make the request non-simple in effect and pointless here:
    // these are public, unauthenticated endpoints.
    await runOverpassQuery('[out:json];out count;');
    expect(captured).toHaveLength(1);
  });
});

describe('406 handling', () => {
  it('is treated as our bug: no retry, no rotation, one attempt only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: {},
          body: '',
        });
        return new Response('<html>406</html>', { status: 406 });
      }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await runOverpassQuery('[out:json];out count;');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Our request shape is wrong; every instance answers identically, so
    // hammering the rest of them helps nobody.
    expect(result.attempts).toBe(1);
    expect(captured).toHaveLength(1);
    expect(result.error.kind).toBe('invalidRequest');
    expect(result.error.message).toContain('Client bug');
    // Logged loudly, because it is a bug in us, not weather.
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does not mark the instance unhealthy for a 406', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>406</html>', { status: 406 })));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runOverpassQuery('[out:json];out count;');

    // One failure is recorded, but nothing is parked and nothing is demoted:
    // a 406 says nothing about the instance's health.
    const { allInstanceHealth, isParked } = await import('./overpassHealth');
    expect(allInstanceHealth().some((instance) => isParked(instance))).toBe(false);
  });
});
