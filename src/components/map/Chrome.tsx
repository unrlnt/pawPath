/**
 * Non-map furniture: disclaimer, attribution, status line, ad slot.
 *
 * Mobile-first throughout (CLAUDE.md §10): tap targets are at least 44 px,
 * contrast is high enough for direct sunlight, and controls sit within reach of
 * a thumb at the bottom of the screen rather than at the top.
 */

import { useState } from 'react';

import {
  ADS_ENABLED,
  AD_SLOT_HEIGHT_PX,
  MAP_ATTRIBUTION,
  MIN_QUERY_ZOOM,
  STORAGE_KEYS,
} from '../../config';
import { SOURCE_ATTRIBUTION } from '../../data/sources';
import { isTrue, readStored, writeStored } from '../../lib/storage';

/* ------------------------------------------------------------------ *
 * Disclaimer
 * ------------------------------------------------------------------ */

/**
 * First-visit disclaimer. Dismissal is remembered in localStorage; bumping the
 * version in `STORAGE_KEYS.disclaimerAccepted` re-shows a changed one.
 *
 * Water gets its own sentence because it is the case where being wrong is most
 * dangerous, and where OSM data is least able to help (CLAUDE.md §6).
 */
export function Disclaimer() {
  const [accepted, setAccepted] = useState(
    () => readStored(STORAGE_KEYS.disclaimerAccepted, isTrue) === true,
  );
  if (accepted) return null;

  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-30 border-t-2 border-slate-900 bg-white p-4 shadow-2xl">
      <h2 className="text-base font-bold text-slate-900">Guidance only</h2>
      <p className="mt-1 text-sm leading-snug text-slate-700">
        PawPath shows community-mapped data and weather estimates. It is not a safety guarantee.
        Conditions change, and the map may be incomplete or out of date.
      </p>
      <p className="mt-2 text-sm font-medium leading-snug text-slate-900">
        Water especially: almost no water is monitored. Never treat the absence of a warning as a
        sign that water is safe for your dog.
      </p>
      <button
        type="button"
        className="mt-3 min-h-[44px] w-full rounded bg-slate-900 px-4 text-base font-semibold text-white"
        onClick={() => {
          writeStored(STORAGE_KEYS.disclaimerAccepted, true);
          setAccepted(true);
        }}
      >
        Got it
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Attribution
 * ------------------------------------------------------------------ */

/**
 * Attribution shown when there is no map canvas to host MapLibre's own control.
 * Crediting OSM and the tile provider is a licence requirement (CLAUDE.md §10),
 * so it cannot depend on the map having loaded.
 */
export function AttributionBar() {
  return (
    <footer className="pointer-events-auto bg-white/90 px-2 py-1 text-[11px] text-slate-700">
      <a
        className="underline"
        href={SOURCE_ATTRIBUTION.osm.url}
        target="_blank"
        rel="noreferrer noopener"
      >
        {SOURCE_ATTRIBUTION.osm.label}
      </a>
      {' · '}
      {MAP_ATTRIBUTION}
    </footer>
  );
}

/* ------------------------------------------------------------------ *
 * Ad slot
 * ------------------------------------------------------------------ */

/**
 * Phase 7's ad slot, reserved and empty.
 *
 * The space is occupied whether or not `ADS_ENABLED` is set, so switching it on
 * shifts nothing (CLAUDE.md §9). Nothing here loads a third-party script: an ad
 * network in the EU drags a consent banner behind it, and that decision is
 * explicitly deferred.
 */
export function AdSlot() {
  return (
    <div
      style={{ height: AD_SLOT_HEIGHT_PX }}
      className="flex shrink-0 items-center justify-center border-t border-slate-200 bg-slate-50 text-[11px] text-slate-400"
      data-testid="ad-slot"
      aria-hidden={!ADS_ENABLED}
    >
      {ADS_ENABLED ? 'Ad slot (component not implemented until Phase 7)' : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Status line
 * ------------------------------------------------------------------ */

export interface StatusLineProps {
  readonly belowMinZoom: boolean;
  readonly coveragePartial: boolean;
  readonly tilesRequested: number;
  readonly tilesTotal: number;
  readonly busy: boolean;
  readonly backgroundActive: boolean;
  readonly layersAwaitingZoom: readonly string[];
  readonly retryMessage: string | undefined;
  readonly errorMessage: string | undefined;
  readonly featureCount: number;
}

/**
 * One line saying what the data layer is doing.
 *
 * A retry is always announced. A silent 30-second backoff looks exactly like a
 * frozen app, and that ambiguity is what made Phase 1's failures so hard to
 * read.
 */
export function StatusLine({
  belowMinZoom,
  coveragePartial,
  tilesRequested,
  tilesTotal,
  busy,
  backgroundActive,
  layersAwaitingZoom,
  retryMessage,
  errorMessage,
  featureCount,
}: StatusLineProps) {
  if (belowMinZoom) {
    return (
      <Banner tone="info">Zoom in to level {MIN_QUERY_ZOOM} or closer to load map data.</Banner>
    );
  }
  if (busy && retryMessage !== undefined) return <Banner tone="warn">{retryMessage}</Banner>;
  if (busy) return <Banner tone="info">Loading map data…</Banner>;
  // Past the latency budget the UI has stopped waiting, but work continues.
  // Saying so is the difference between "slow" and "broken".
  if (backgroundActive) {
    return (
      <Banner tone="warn">
        Still loading in the background — showing what has arrived so far.
      </Banner>
    );
  }
  if (errorMessage !== undefined) return <Banner tone="error">{errorMessage}</Banner>;
  if (coveragePartial) {
    return (
      <Banner tone="warn">
        Showing the {tilesRequested} closest areas of {tilesTotal}. Zoom in for full coverage.
      </Banner>
    );
  }
  if (layersAwaitingZoom.length > 0) {
    return <Banner tone="info">Zoom in to load: {layersAwaitingZoom.join(', ')}.</Banner>;
  }
  if (featureCount > 0) {
    return <Banner tone="info">{featureCount} features loaded.</Banner>;
  }
  return null;
}

function Banner({
  tone,
  children,
}: {
  tone: 'info' | 'warn' | 'error';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'error'
      ? 'bg-red-700 text-white'
      : tone === 'warn'
        ? 'bg-amber-500 text-slate-900'
        : 'bg-slate-900/85 text-white';
  return (
    <div
      role="status"
      className={`pointer-events-none rounded px-3 py-2 text-sm font-medium shadow ${toneClass}`}
    >
      {children}
    </div>
  );
}
