/*
 * PawPath service worker (Phase 11, step 1: PWA).
 *
 * Makes the installed app open instantly and work offline in the areas the
 * user has looked at. Hand-written on purpose: the strategies are few, and
 * range requests on .pmtiles need custom handling no generator offers.
 *
 *  - Page (navigation)       network first, cached page when offline
 *  - /assets/*  (hashed)     cache first — file names change per release
 *  - /tiles/*.pmtiles        each byte range cached on its own (immutable
 *                            file names per build), capped
 *  - /tiles/*.json           network first, cached copy when offline
 *  - OpenFreeMap             cache first for tiles/fonts/sprites, capped
 *  - everything else         untouched (weather and search handle offline
 *                            themselves)
 *
 * Bump VERSION when this file's strategies change.
 */
const VERSION = 'v2';
const SHELL = `pawpath-shell-${VERSION}`;
// v2: v1 keyed ranges with a #fragment, which the Cache API ignores — every
// range matched the first one cached. Old range caches are deleted on activate.
const RANGES = 'pawpath-tile-ranges-v2';
const BASEMAP = 'pawpath-basemap';
const JSON_CACHE = 'pawpath-json';
const MAX_RANGES = 600;
const MAX_BASEMAP = 1500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        const staleShell = key.startsWith('pawpath-shell-') && key !== SHELL;
        const staleRanges = key.startsWith('pawpath-tile-ranges') && key !== RANGES;
        if (staleShell || staleRanges) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

/** Keeps a cache at most `max` entries, dropping the oldest first. */
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i += 1) await cache.delete(keys[i]);
}

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(fallbackUrl ?? request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(fallbackUrl ?? request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    if (max) trim(cacheName, max);
  }
  return response;
}

/**
 * The Cache API cannot store 206 responses, and a .pmtiles file is only ever
 * read in byte ranges. Each range is stored as a 200 under a key that
 * includes the range, and answered as 206 again. Safe because every build has
 * its own immutable file name. Keyed by URL + `?pawpath-range=…`.
 */
async function rangeRequest(request) {
  const range = request.headers.get('range');
  // A query parameter, not a #fragment: cache matching ignores fragments.
  const key = new URL(request.url);
  key.searchParams.set('pawpath-range', range);
  const cache = await caches.open(RANGES);
  const cached = await cache.match(key);
  if (cached) {
    return new Response(cached.body, {
      status: 206,
      headers: {
        'Content-Type': cached.headers.get('Content-Type') || 'application/octet-stream',
        'Content-Range': cached.headers.get('X-Content-Range') || '',
        'Content-Length': cached.headers.get('Content-Length') || '',
      },
    });
  }
  const response = await fetch(request);
  if (response.status === 206) {
    const body = await response.clone().arrayBuffer();
    await cache.put(
      key,
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
          'X-Content-Range': response.headers.get('Content-Range') || '',
          'Content-Length': String(body.byteLength),
        },
      }),
    );
    trim(RANGES, MAX_RANGES);
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(networkFirst(request, SHELL, '/'));
    } else if (url.pathname.startsWith('/assets/')) {
      event.respondWith(cacheFirst(request, SHELL));
    } else if (url.pathname.startsWith('/tiles/') && url.pathname.endsWith('.pmtiles') && request.headers.has('range')) {
      event.respondWith(rangeRequest(request));
    } else if (url.pathname.startsWith('/tiles/') && url.pathname.endsWith('.json')) {
      event.respondWith(networkFirst(request, JSON_CACHE));
    }
    return;
  }

  if (url.hostname === 'tiles.openfreemap.org') {
    event.respondWith(cacheFirst(request, BASEMAP, MAX_BASEMAP));
  }
});
