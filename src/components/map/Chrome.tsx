/**
 * Non-map furniture: disclaimer, layer toggles, zoom hint, status, ad slot.
 *
 * Mobile-first (CLAUDE.md §10): 44 px tap targets, sunlight contrast, controls
 * within thumb reach. Look and feel per the design direction: warm, rounded,
 * a little playful — safety wording stays plain.
 */

import { useState } from 'react';

import { ADS_ENABLED, AD_SLOT_HEIGHT_PX, LAYER_MIN_ZOOM, STORAGE_KEYS } from '../../config';
import { LAYER_ICONS } from '../../data/levelLabels';
import { ALL_LAYERS, LAYERS, type LayerKey } from '../../data/layers';
import { isTrue, readStored, writeStored } from '../../lib/storage';
import Mascot from '../Mascot';

/* ------------------------------------------------------------------ *
 * Disclaimer
 * ------------------------------------------------------------------ */

export function Disclaimer() {
  const [accepted, setAccepted] = useState(
    () => readStored(STORAGE_KEYS.disclaimerAccepted, isTrue) === true,
  );
  if (accepted) return null;

  return (
    <div className="pointer-events-auto absolute inset-x-2 bottom-2 z-30 rounded-blob bg-cream p-4 shadow-soft ring-1 ring-creamDeep">
      <div className="flex items-start gap-3">
        <Mascot size={64} className="shrink-0" />
        <div>
          <h2 className="text-lg font-semibold text-ink">Woof! A quick note first</h2>
          <p className="mt-1 text-sm leading-snug text-inkSoft">
            PawPath shows community-mapped data and weather estimates. It is guidance, not a
            safety guarantee — the map can be incomplete or out of date.
          </p>
        </div>
      </div>
      <p className="mt-3 text-sm font-bold leading-snug text-ink">
        Water especially: almost no water is monitored. No warning on the map never means the
        water is safe for your dog.
      </p>
      <button
        type="button"
        className="mt-3 min-h-[44px] w-full rounded-full bg-terracotta px-4 font-display text-lg text-cream shadow-soft active:bg-terracottaDeep"
        onClick={() => {
          writeStored(STORAGE_KEYS.disclaimerAccepted, true);
          setAccepted(true);
        }}
      >
        Got it — let's walk
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Layer toggles
 * ------------------------------------------------------------------ */

export function LayerToggles({
  enabled,
  onToggle,
}: {
  enabled: readonly LayerKey[];
  onToggle: (layer: LayerKey) => void;
}) {
  return (
    <div className="pointer-events-auto flex gap-2 overflow-x-auto px-2 pb-1 [scrollbar-width:none]">
      {ALL_LAYERS.map((layer) => {
        const on = enabled.includes(layer.key);
        return (
          <button
            key={layer.key}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(layer.key)}
            className={`flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-bold shadow-soft transition-colors ${
              on ? 'bg-sageDeep text-cream' : 'bg-cream text-inkSoft ring-1 ring-creamDeep'
            }`}
          >
            <span aria-hidden>{LAYER_ICONS[layer.key]}</span>
            {layer.label}
          </button>
        );
      })}
    </div>
  );
}

/** Enabled layers the current zoom is too far out to show. */
export function layersAwaitingZoom(enabled: readonly LayerKey[], zoom: number): LayerKey[] {
  return enabled.filter((layer) => zoom < LAYER_MIN_ZOOM[layer]);
}

export function ZoomHint({ waiting }: { waiting: readonly LayerKey[] }) {
  if (waiting.length === 0) return null;
  const closest = Math.max(...waiting.map((layer) => LAYER_MIN_ZOOM[layer]));
  return (
    <Banner tone="info">
      Zoom in to see {waiting.map((layer) => LAYERS[layer].label.toLowerCase()).join(', ')}
      {closest > 0 ? ` (level ${closest})` : ''}.
    </Banner>
  );
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

export function Banner({
  tone,
  children,
}: {
  tone: 'info' | 'warn' | 'error';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'error'
      ? 'bg-safety-prohibited text-cream'
      : tone === 'warn'
        ? 'bg-sunny text-ink'
        : 'bg-cream/95 text-ink ring-1 ring-creamDeep';
  return (
    <div
      role="status"
      className={`pointer-events-none mx-2 rounded-blob px-4 py-2 text-sm font-bold shadow-soft ${toneClass}`}
    >
      {children}
    </div>
  );
}

export function DataUnavailable({ message }: { message: string }) {
  return (
    <div className="pointer-events-none mx-2 flex items-center gap-3 rounded-blob bg-cream/95 px-3 py-2 shadow-soft ring-1 ring-creamDeep">
      <Mascot mood="sleepy" size={44} />
      <p className="text-sm font-bold text-ink">{message}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Ad slot (Phase 7) — space reserved either way, so enabling shifts nothing.
 * ------------------------------------------------------------------ */

export function AdSlot() {
  return (
    <div
      style={{ height: AD_SLOT_HEIGHT_PX }}
      className="flex shrink-0 items-center justify-center border-t border-creamDeep bg-cream text-[11px] text-inkSoft"
      data-testid="ad-slot"
      aria-hidden={!ADS_ENABLED}
    >
      {ADS_ENABLED ? 'Ad slot (component not implemented until Phase 7)' : null}
    </div>
  );
}
