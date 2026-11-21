/**
 * The conditions card (CLAUDE.md §7): one line collapsed
 * ("Good to walk · UV 4 · paws 12–18 °C"), the full breakdown expanded.
 *
 * Everything shown is computed in `src/lib/conditions/`; this file only
 * words and lays it out. Safety wording stays plain; the estimate is always
 * labelled as one, and always a range.
 */

import { useState } from 'react';

import { STORAGE_KEYS } from '../../config';
import { AQI_LABELS, UV_LABELS } from '../../lib/conditions/bands';
import type { PawBand, PawEstimate } from '../../lib/conditions/paw';
import type { RainOutlook } from '../../lib/conditions/rainWindow';
import type { Severity } from '../../lib/conditions/seasonal';
import { localDate, type ConditionsSummary } from '../../lib/conditions/summary';
import { VERDICT_LABELS, type Verdict } from '../../lib/conditions/verdict';
import type { ScoreReason, WalkWindow } from '../../lib/conditions/walkWindow';
import { readStored, writeStored } from '../../lib/storage';
import Mascot from '../Mascot';
import type { ConditionsState } from './useConditions';

const isOpenFlag = (v: unknown): v is boolean => typeof v === 'boolean';

const VERDICT_DOT: Record<Verdict, string> = {
  good: 'bg-safety-offLeash',
  care: 'bg-safety-leashed',
  wait: 'bg-safety-prohibited',
};

const BAND_PILL: Record<PawBand, string> = {
  fine: 'bg-sage/30 text-ink',
  caution: 'bg-sunny text-ink',
  danger: 'bg-safety-prohibited text-cream',
};

const BAND_WORD: Record<PawBand, string> = { fine: 'fine', caution: 'caution', danger: 'too hot' };

const SEVERITY_PILL: Record<Severity, string> = {
  low: 'bg-creamDeep text-inkSoft',
  moderate: 'bg-sunny/70 text-ink',
  high: 'bg-terracotta text-cream',
};

const REASON_TEXT: Record<ScoreReason, string> = {
  pawDanger: 'Pavement in the sun is hot enough to burn paws.',
  pawCaution: 'Pavement in the sun is getting hot — stick to grass and shade.',
  rainLikely: 'Rain is likely.',
  rainPossible: 'Rain is possible.',
  uvVeryHigh: 'Very high UV — midday sun is hard on light-coated and pink-nosed dogs.',
  uvHigh: 'High UV.',
};

const range = (p: PawEstimate): string => `${p.lowC}–${p.highC} °C`;

/**
 * Clock time at the location, prefixed with "tomorrow" when it falls on the
 * next local day — "18:00–17:00" without it reads as nonsense.
 */
function timeFormatter(timeZone: string, now: number): (t: number) => string {
  const format = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone });
  const today = localDate(now, timeZone);
  return (t) => {
    const date = localDate(t, timeZone);
    const tomorrow = date.month !== today.month || date.day !== today.day;
    return `${tomorrow ? 'tomorrow ' : ''}${format.format(new Date(t))}`;
  };
}

function headline(summary: ConditionsSummary): string {
  const [first] = summary.current.reasons;
  if (first !== undefined) return REASON_TEXT[first];
  return summary.noSun
    ? 'No sun on the pavement — paws are fine.'
    : `Paws are fine — ${range(summary.paw.asphaltSun)} on asphalt.`;
}

function windowText(window: WalkWindow | undefined, fmt: (t: number) => string): string {
  if (window === undefined) return 'No clearly good stretch in the next 24 hours.';
  if (window.startsNow) return `Good now, until about ${fmt(window.end)}.`;
  return `Next good stretch: ${fmt(window.start)} – ${fmt(window.end)}.`;
}

function rainText(rain: RainOutlook | undefined): string | undefined {
  if (rain === undefined) return undefined;
  switch (rain.kind) {
    case 'dry':
      return 'Dry for the next 2 hours, by the forecast.';
    case 'rainSoon':
      return rain.inMinutes <= 5 ? 'Rain expected any minute.' : `Rain expected in about ${rain.inMinutes} min.`;
    case 'rainingNow':
      return rain.dryInMinutes === undefined
        ? 'Raining, and no break in the next 2 hours.'
        : `Raining — a dry spell expected in about ${rain.dryInMinutes} min.`;
  }
}

export default function ConditionsCard({ state }: { state: ConditionsState }) {
  const [open, setOpen] = useState(() => readStored(STORAGE_KEYS.conditionsCard, isOpenFlag) ?? false);
  const toggle = (): void => {
    setOpen((value) => {
      writeStored(STORAGE_KEYS.conditionsCard, !value);
      return !value;
    });
  };

  if (state.status === 'idle') return null;
  if (state.status === 'loading') {
    return (
      <div className="pointer-events-none mx-2 flex min-h-[44px] items-center gap-2 rounded-blob bg-cream/95 px-3 text-sm font-bold text-inkSoft shadow-soft ring-1 ring-creamDeep">
        <Mascot mood="sleepy" size={28} /> Sniffing the weather…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="pointer-events-none mx-2 flex min-h-[44px] items-center gap-2 rounded-blob bg-cream/95 px-3 text-sm font-bold text-inkSoft shadow-soft ring-1 ring-creamDeep">
        <Mascot mood="sleepy" size={28} /> {state.message}
      </div>
    );
  }

  const { summary, conditions } = state;
  const fmt = timeFormatter(conditions.timeZone, Date.now());
  const rain = rainText(summary.rain);

  return (
    <section
      aria-label="Walking conditions"
      className="pointer-events-auto mx-2 overflow-hidden rounded-blob bg-cream/95 shadow-soft ring-1 ring-creamDeep"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex min-h-[48px] w-full items-center gap-2 px-3 text-left"
      >
        <span aria-hidden className={`h-3 w-3 shrink-0 rounded-full ${VERDICT_DOT[summary.verdict]}`} />
        <span className="font-display text-base font-semibold text-ink">{VERDICT_LABELS[summary.verdict]}</span>
        <span className="truncate text-sm text-inkSoft">
          · UV {Math.round(summary.uv.index)} · paws {range(summary.paw.asphaltSun)}
        </span>
        <span aria-hidden className={`ml-auto text-inkSoft transition-transform ${open ? 'rotate-180' : ''}`}>
          ▾
        </span>
      </button>

      {open ? (
        <div className="max-h-[58vh] space-y-3 overflow-y-auto border-t border-creamDeep px-3 pb-3 pt-2 text-sm text-ink">
          <div className="flex items-center gap-3">
            <Mascot mood={summary.verdict === 'wait' ? 'sleepy' : 'happy'} size={52} className="shrink-0" />
            <p className="font-bold leading-snug">{headline(summary)}</p>
          </div>

          <div>
            <h3 className="mb-1 font-display text-sm font-semibold text-inkSoft">Paws (estimate)</h3>
            <ul className="space-y-1">
              {(summary.noSun
                ? ([['Any surface (no sun)', summary.paw.asphaltSun]] as const)
                : ([
                    ['Asphalt in sun', summary.paw.asphaltSun],
                    ['Asphalt in shade', summary.paw.asphaltShade],
                    ['Grass in sun', summary.paw.grassSun],
                  ] as const)
              ).map(([label, estimate]) => (
                <li key={label} className="flex items-center justify-between gap-2">
                  <span>{label}</span>
                  <span className="flex items-center gap-2 tabular-nums">
                    {range(estimate)}
                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${BAND_PILL[estimate.band]}`}>
                      {BAND_WORD[estimate.band]}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-inkSoft">
              Air {Math.round(summary.airC)} °C. Not sure? Hold the back of your hand on the pavement — if you
              can’t keep it there for 7 seconds, it’s too hot for paws.
            </p>
          </div>

          <div>
            <h3 className="mb-1 font-display text-sm font-semibold text-inkSoft">When to go</h3>
            <p>{windowText(summary.walkWindow, fmt)}</p>
            {rain !== undefined ? <p className="mt-0.5">{rain}</p> : null}
            {conditions.sunset !== undefined ? (
              <p className="mt-0.5 text-inkSoft">Sunset {fmt(conditions.sunset)}.</p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <span className="rounded-full bg-creamDeep px-3 py-1">
              UV {Math.round(summary.uv.index)} · {UV_LABELS[summary.uv.band]}
            </span>
            {summary.air !== undefined ? (
              <span className="rounded-full bg-creamDeep px-3 py-1">
                Air {AQI_LABELS[summary.air.band]} · EAQI {Math.round(summary.air.aqi)}
              </span>
            ) : null}
          </div>

          {summary.advisories.length > 0 ? (
            <div>
              <h3 className="mb-1 font-display text-sm font-semibold text-inkSoft">Seasonal heads-up</h3>
              <ul className="space-y-2">
                {summary.advisories.map((advisory) => (
                  <li key={advisory.id}>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${SEVERITY_PILL[advisory.severity]}`}>
                        {advisory.severity}
                      </span>
                      <span className="font-bold">{advisory.title}</span>
                    </div>
                    <p className="mt-0.5 text-inkSoft">{advisory.detail}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="border-t border-creamDeep pt-2 text-[11px] text-inkSoft">
            Estimates for guidance only, for the area around {conditions.lat.toFixed(1)}°,{' '}
            {conditions.lng.toFixed(1)}° — updated {fmt(conditions.fetchedAt)}. Weather data by{' '}
            <a className="underline" href="https://open-meteo.com/" target="_blank" rel="noreferrer noopener">
              Open-Meteo.com
            </a>{' '}
            (CC BY 4.0).
          </p>
        </div>
      ) : null}
    </section>
  );
}
