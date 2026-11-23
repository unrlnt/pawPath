/**
 * "Find nearby": pick what you need, see the three closest with distance and
 * direction, show one on the map or walk there with the route planner.
 */

import { NEARBY_KIND_KEYS, NEARBY_KINDS, type NearbyKind, type NearbyResult } from '../../lib/nearby';
import { formatDistance } from '../../lib/routing/edit';
import type { NearbyState } from './useNearby';

const chip =
  'flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-bold shadow-soft ring-1 ring-creamDeep';

function resultTitle(kind: NearbyKind, r: NearbyResult): string {
  if (r.poi.kind === 'offLeash') {
    const what = r.poi.fenced === true ? 'Dog park' : 'Off-leash area';
    return r.poi.name === undefined ? what : `${what} · ${r.poi.name}`;
  }
  if (kind === 'bin' && r.poi.kind === 'dogBin') return 'Dog-waste bin';
  return r.poi.name ?? NEARBY_KINDS[kind].label;
}

export default function NearbySheet({
  state,
  fromLabel,
  onPick,
  onShow,
  onWalk,
  onClose,
}: {
  state: NearbyState;
  /** "from your location" or "from the map centre". */
  fromLabel: string;
  onPick: (kind: NearbyKind) => void;
  onShow: (result: NearbyResult) => void;
  onWalk: (result: NearbyResult) => void;
  onClose: () => void;
}) {
  const active = state.s === 'idle' ? undefined : state.kind;
  return (
    <section
      aria-label="Find nearby"
      className="pointer-events-auto mx-2 max-h-[60vh] overflow-y-auto rounded-blob bg-cream/95 p-3 shadow-soft ring-1 ring-creamDeep"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-semibold leading-tight text-ink">Find nearby</h2>
          <p className="text-sm text-inkSoft">Closest first, {fromLabel}.</p>
        </div>
        <button type="button" className={`${chip} bg-cream text-ink`} onClick={onClose}>
          Close
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {NEARBY_KIND_KEYS.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={active === kind}
            className={`${chip} ${active === kind ? 'bg-sageDeep text-cream' : 'bg-cream text-ink'}`}
            onClick={() => onPick(kind)}
          >
            <span aria-hidden>{NEARBY_KINDS[kind].icon}</span> {NEARBY_KINDS[kind].label}
          </button>
        ))}
      </div>

      <div className="mt-2" role="status">
        {state.s === 'searching' ? <p className="text-sm text-inkSoft">Sniffing around…</p> : null}
        {state.s === 'none' ? (
          <p className="text-sm text-ink">
            No {NEARBY_KINDS[state.kind].noun} is mapped within a few kilometres. Know one? Report it with ⚑.
          </p>
        ) : null}
        {state.s === 'failed' ? <p className="text-sm font-bold text-ink">{state.message}</p> : null}
        {state.s === 'found' ? (
          <ul className="flex flex-col gap-2">
            {state.results.map((r) => (
              <li
                key={`${r.poi.at[0]},${r.poi.at[1]}`}
                className="flex items-center gap-2 rounded-blob bg-creamDeep/60 p-1.5"
              >
                <button type="button" className="min-h-[44px] min-w-0 flex-1 px-2 text-left" onClick={() => onShow(r)}>
                  <span className="block truncate font-bold text-ink">{resultTitle(state.kind, r)}</span>
                  <span className="block text-xs text-inkSoft">
                    {formatDistance(r.distanceM)} {r.direction} · as the crow flies
                  </span>
                </button>
                <button type="button" className={`${chip} bg-ink text-cream`} onClick={() => onWalk(r)}>
                  Walk there
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
