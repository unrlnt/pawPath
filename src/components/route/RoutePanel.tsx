/**
 * The route planner sheet (Phase 9): what the walk looks like right now —
 * distance, time, how much is hot for paws, paved or unpaved — and the tools
 * to edit, save, share, export and walk it.
 */

import { useRef, useState } from 'react';

import { ROUTE_WALK_KMH } from '../../config';
import { formatDistance, formatMinutes, type Progress } from '../../lib/routing/edit';
import { toGpx, type SavedRoute } from '../../lib/routing/io';
import { STOP_KINDS, type StopKind } from '../../lib/routing/stops';
import type { RoutePlanner } from './useRoutePlanner';

const pill =
  'flex min-h-[44px] shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 text-sm font-bold shadow-soft disabled:opacity-40';
const quiet = `${pill} bg-cream text-ink ring-1 ring-creamDeep active:bg-creamDeep`;
const strong = `${pill} bg-ink text-cream active:bg-inkSoft`;

/** The paw profile as one stacked bar, with words next to it (not colour alone). */
function ProfileBar({ result }: { result: Extract<RoutePlanner['status'], { kind: 'ready' }>['result'] }) {
  const p = result.profile;
  const total = Math.max(p.lengthM, 1);
  // With weather: how kind to paws each stretch is right now. Without: the
  // material, which still says a lot (paved heats up, unpaved stays cool).
  const parts = (
    p.heatKnown
      ? [
          { m: p.byBand.danger, className: 'bg-terracotta', label: 'too hot for paws now' },
          { m: p.byBand.caution, className: 'bg-sunny', label: 'warm' },
          { m: p.byBand.fine, className: 'bg-sage', label: 'kind to paws' },
          { m: p.unknownSurfaceM, className: 'bg-creamDeep', label: 'surface not mapped' },
        ]
      : [
          { m: p.pavedM, className: 'bg-inkSoft', label: 'paved' },
          { m: p.unpavedM, className: 'bg-sage', label: 'unpaved' },
          { m: p.unknownSurfaceM, className: 'bg-creamDeep', label: 'surface not mapped' },
        ]
  ).filter((part) => part.m >= 1);
  return (
    <div className="mt-2">
      <div className="flex h-3 overflow-hidden rounded-full ring-1 ring-ink/20" aria-hidden>
        {parts.map((part) => (
          <div key={part.label} className={part.className} style={{ width: `${(100 * part.m) / total}%` }} />
        ))}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-inkSoft">
        {parts.map((part) => (
          <li key={part.label}>
            <span className={`mr-1 inline-block h-2 w-2 rounded-full ${part.className}`} aria-hidden />
            {formatDistance(part.m)} {part.label}
          </li>
        ))}
        {p.heatKnown ? (
          <li>
            {formatDistance(p.pavedM)} paved · {formatDistance(p.unpavedM)} unpaved
          </li>
        ) : null}
        <li>
          <span className="mr-1 inline-block h-2 w-3 rounded-full border-2 border-sageDeep" aria-hidden />
          {p.shadeM >= 10 ? `${formatDistance(p.shadeM)} in shade` : 'no mapped shade'}
          {p.denseShadeM >= 10 && p.denseShadeM < p.shadeM - 10 ? ` (${formatDistance(p.denseShadeM)} under trees)` : ''}
        </li>
      </ul>
    </div>
  );
}

function download(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/gpx+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^\w\- ]+/g, '').trim() || 'pawpath-walk'}.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function RoutePanel({
  planner,
  walking,
  progress,
  walkError,
  onToggleWalk,
  onShowSaved,
}: {
  planner: RoutePlanner;
  walking: boolean;
  progress: Progress | undefined;
  walkError: string | undefined;
  onToggleWalk: () => void;
  onShowSaved: () => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const { status, waypoints } = planner;
  const ready = status.kind === 'ready' ? status.result : undefined;

  // One timer: a new message must not be cleared by an older one's timeout.
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flash = (text: string, ms = 2_500): void => {
    setNotice(text);
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(undefined), ms);
  };

  const share = async (): Promise<void> => {
    const url = planner.shareUrl();
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'A PawPath walk', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      flash('Link copied');
    } catch {
      // Share sheet dismissed, or clipboard blocked: show the link instead.
      window.prompt('Copy this link', url);
    }
  };

  return (
    <section
      aria-label="Plan a walk"
      className="pointer-events-auto mx-2 rounded-blob bg-cream/95 p-3 shadow-soft ring-1 ring-creamDeep"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold leading-tight text-ink">
            {walking ? 'Walking' : 'Plan a walk'}
          </h2>
          <p className="text-sm text-inkSoft" role="status">
            {walking && progress !== undefined
              ? progress.offRouteM > 40
                ? `Off the route by ${formatDistance(progress.offRouteM)} · ${formatDistance(progress.remainingM)} to go`
                : `${formatDistance(progress.remainingM)} to go · about ${formatMinutes((progress.remainingM / 1000 / ROUTE_WALK_KMH) * 60)}`
              : walking && walkError !== undefined
                ? walkError
                : waypoints.length === 0
                  ? 'Tap the map where you want to start.'
                  : waypoints.length === 1
                    ? 'Tap where to go next. Add as many stops as you like.'
                    : status.kind === 'routing'
                      ? 'Sniffing out the best paths…'
                      : status.kind === 'failed'
                        ? status.message
                        : ready !== undefined
                          ? `${formatDistance(ready.profile.lengthM)} · about ${formatMinutes(ready.profile.minutes)}${planner.roundTrip ? ' · back to the start' : ''}`
                          : ''}
          </p>
        </div>
        <button type="button" className={quiet} onClick={planner.stop} aria-label="Close the planner">
          Done
        </button>
      </div>

      {ready !== undefined && !walking ? <ProfileBar result={ready} /> : null}
      {ready !== undefined && !walking ? (
        <>
          <p className="mt-2 text-xs font-bold text-inkSoft">Add a stop on the way:</p>
          <div className="mt-1 flex items-center gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none]">
            {(Object.keys(STOP_KINDS) as StopKind[]).map((kind) => (
              <button
                key={kind}
                type="button"
                className={`${quiet} min-h-[40px]`}
                onClick={() => flash(planner.addStop(kind), 4_000)}
                aria-label={`Route via the nearest ${STOP_KINDS[kind].noun}`}
              >
                <span aria-hidden>{STOP_KINDS[kind].icon}</span> {STOP_KINDS[kind].label}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {ready !== undefined && !walking && waypoints.length >= 2 ? (
        <p className="mt-1 text-xs text-inkSoft">
          Drag a stop to move it, tap it to remove it, or drag the line onto another path.
        </p>
      ) : null}

      {naming ? (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            planner.save(name);
            setNaming(false);
            setName('');
            flash('Saved to My walks');
          }}
        >
          <input
            autoFocus
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name this walk"
            aria-label="Name this walk"
            className="min-h-[44px] min-w-0 flex-1 rounded-full bg-cream px-4 text-ink ring-1 ring-creamDeep focus:outline-none focus:ring-2 focus:ring-sageDeep"
          />
          <button type="submit" className={strong}>
            Save
          </button>
        </form>
      ) : (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none]">
          {walking ? (
            <button type="button" className={strong} onClick={onToggleWalk}>
              Stop walking
            </button>
          ) : (
            <>
              <button type="button" className={quiet} onClick={planner.undo} disabled={!planner.canUndo}>
                ↶ Undo
              </button>
              <button
                type="button"
                className={planner.roundTrip ? `${pill} bg-sageDeep text-cream` : quiet}
                aria-pressed={planner.roundTrip}
                onClick={planner.toggleRoundTrip}
                disabled={waypoints.length < 2}
              >
                ⟲ Round trip
              </button>
              <button type="button" className={strong} onClick={onToggleWalk} disabled={ready === undefined}>
                🐾 Walk it
              </button>
              <button type="button" className={quiet} onClick={() => setNaming(true)} disabled={waypoints.length < 2}>
                ♡ Save
              </button>
              <button type="button" className={quiet} onClick={() => void share()} disabled={waypoints.length < 2}>
                Share
              </button>
              <button
                type="button"
                className={quiet}
                disabled={ready === undefined}
                onClick={() => ready !== undefined && download('PawPath walk', toGpx('PawPath walk', ready.line))}
              >
                GPX
              </button>
              <button type="button" className={quiet} onClick={onShowSaved}>
                My walks{planner.saved.length > 0 ? ` (${planner.saved.length})` : ''}
              </button>
              <button type="button" className={quiet} onClick={planner.clear} disabled={waypoints.length === 0}>
                Clear
              </button>
            </>
          )}
        </div>
      )}
      {notice !== undefined ? <p className="mt-1 text-sm font-bold text-sageDeep">{notice}</p> : null}
    </section>
  );
}

export function SavedRoutesSheet({
  saved,
  onOpen,
  onDelete,
  onClose,
}: {
  saved: readonly SavedRoute[];
  onOpen: (route: SavedRoute) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-end bg-ink/30" onClick={onClose}>
      <section
        aria-label="My walks"
        className="max-h-[70%] w-full overflow-y-auto rounded-t-blob bg-cream p-4 shadow-soft"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-semibold text-ink">My walks</h2>
          <button type="button" className={quiet} onClick={onClose}>
            Close
          </button>
        </div>
        <p className="mt-1 text-sm text-inkSoft">Saved on this device only — there are no accounts.</p>
        {saved.length === 0 ? (
          <p className="mt-4 text-sm text-ink">No saved walks yet. Plan one and tap ♡ Save.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {saved.map((route) => (
              <li key={route.id} className="flex items-center gap-2 rounded-blob bg-creamDeep/60 p-2">
                <button
                  type="button"
                  className="min-h-[44px] min-w-0 flex-1 px-2 text-left"
                  onClick={() => onOpen(route)}
                >
                  <span className="block truncate font-bold text-ink">{route.name}</span>
                  <span className="block text-xs text-inkSoft">
                    {route.waypoints.length} stops{route.roundTrip ? ' · round trip' : ''} ·{' '}
                    {new Date(route.savedAt).toLocaleDateString()}
                  </span>
                </button>
                <button
                  type="button"
                  className={quiet}
                  aria-label={`Delete ${route.name}`}
                  onClick={() => {
                    if (window.confirm(`Delete “${route.name}”?`)) onDelete(route.id);
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
