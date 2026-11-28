/**
 * Report something missing or gone (Phase 12) as an anonymous OSM note.
 * Permanent amenities only; the walker sees exactly what will be sent.
 */

import { useState } from 'react';

import type { OsmSession } from '../../data/sources/osmAuth';
import { addNode, deleteNode } from '../../data/sources/osmEdit';
import { createNote, noteCooldownS } from '../../data/sources/osmNotes';
import { parseOsmUrl } from '../../lib/osmChange';
import { noteText, REPORT_KIND_KEYS, REPORT_KINDS, type Report, type ReportKind } from '../../lib/notes';

export type ReportTarget =
  | { readonly change: 'missing' }
  | {
      readonly change: 'gone';
      readonly kind: ReportKind;
      readonly lat: number;
      readonly lng: number;
      readonly osmUrl: string | undefined;
    };

const chip =
  'flex min-h-[44px] shrink-0 items-center rounded-full px-3.5 text-sm font-bold shadow-soft ring-1 ring-creamDeep';

type SendState =
  | { readonly s: 'editing' }
  | { readonly s: 'sending' }
  | { readonly s: 'sent'; readonly url: string; readonly id: number }
  | { readonly s: 'edited'; readonly url: string }
  | { readonly s: 'failed'; readonly message: string };

/**
 * Step 1 of reporting something missing: the map moves under a fixed cross;
 * only Cancel and Continue are shown, so the map stays visible.
 */
export function ReportPlaceBar({
  canContinue,
  onCancel,
  onContinue,
}: {
  canContinue: boolean;
  onCancel: () => void;
  onContinue: () => void;
}) {
  return (
    <section
      aria-label="Report to OpenStreetMap"
      className="pointer-events-auto mx-2 rounded-blob bg-cream/95 p-3 shadow-soft ring-1 ring-creamDeep"
    >
      <h2 className="font-display text-lg font-semibold leading-tight text-ink">Where is it?</h2>
      <p className="mt-0.5 text-sm text-inkSoft">Move the map until the cross sits on the spot.</p>
      <div className="mt-2 flex gap-2">
        <button type="button" className={`${chip} bg-cream text-ink`} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!canContinue}
          onClick={onContinue}
          className="min-h-[44px] flex-1 rounded-full bg-terracotta px-4 font-display text-lg text-cream shadow-soft active:bg-terracottaDeep disabled:opacity-50"
        >
          Continue
        </button>
      </div>
    </section>
  );
}

/** What the sheet needs from the OpenStreetMap sign-in (see useOsmSession). */
export interface ReportOsm {
  readonly available: boolean;
  readonly session: OsmSession | undefined;
  readonly signIn: () => void;
  readonly signOut: () => void;
  readonly expire: () => void;
}

const link = 'min-h-[44px] px-1 font-bold text-ink underline';

export default function ReportSheet({
  target,
  where,
  osm,
  onMoveSpot,
  onEdited,
  onClose,
}: {
  target: ReportTarget;
  /** For `missing`: the spot chosen in step 1. */
  where: { lat: number; lng: number } | undefined;
  osm: ReportOsm;
  /** For `missing`: back to step 1 to move the spot. */
  onMoveSpot?: () => void;
  /** A direct edit succeeded (the map shows added points until the next build). */
  onEdited?: () => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<ReportKind | undefined>(target.change === 'gone' ? target.kind : undefined);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<SendState>({ s: 'editing' });
  const [preferNote, setPreferNote] = useState(false);
  const [hint, setHint] = useState<string | undefined>(undefined);

  // Removing needs a plain OSM node; anything else can only be a note.
  const goneNode = target.change === 'gone' ? parseOsmUrl(target.osmUrl) : undefined;
  const canEditDirectly = target.change === 'missing' || goneNode?.type === 'node';
  const direct = osm.session !== undefined && canEditDirectly && !preferNote;

  const report: Report | undefined =
    kind === undefined
      ? undefined
      : { kind, change: target.change, comment, osmUrl: target.change === 'gone' ? target.osmUrl : undefined };
  const text = report === undefined ? '' : noteText(report, window.location.origin);
  const point = target.change === 'gone' ? { lat: target.lat, lng: target.lng } : where;

  const send = async (): Promise<void> => {
    if (report === undefined || point === undefined) return;
    setState({ s: 'sending' });
    const outcome = await createNote(point.lat, point.lng, text);
    setState(outcome.ok ? { s: 'sent', url: outcome.url, id: outcome.id } : { s: 'failed', message: outcome.message });
  };

  const edit = async (): Promise<void> => {
    if (kind === undefined || point === undefined || osm.session === undefined) return;
    setState({ s: 'sending' });
    const { label, osmTags } = REPORT_KINDS[kind];
    const outcome =
      target.change === 'missing'
        ? await addNode(osm.session, point.lat, point.lng, osmTags, label)
        : goneNode === undefined
          ? { ok: false as const, message: 'This one can only be reported as a note.', useNote: true }
          : await deleteNode(osm.session, goneNode.id, osmTags, label, kind === 'toilets');
    if (outcome.ok) {
      setState({ s: 'edited', url: outcome.url });
      onEdited?.();
      return;
    }
    if (outcome.signedOut === true) osm.expire();
    if (outcome.useNote === true) {
      setPreferNote(true);
      setHint(`${outcome.message} You can send a note instead.`);
      setState({ s: 'editing' });
      return;
    }
    setState({ s: 'failed', message: outcome.message });
  };

  const label = kind === undefined ? undefined : REPORT_KINDS[kind].label.toLowerCase();

  return (
    <section
      aria-label="Report to OpenStreetMap"
      className="pointer-events-auto mx-2 max-h-[60vh] overflow-y-auto rounded-blob bg-cream/95 p-3 shadow-soft ring-1 ring-creamDeep"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-display text-lg font-semibold leading-tight text-ink">
          {target.change === 'missing' ? (direct ? 'Add to the map' : 'Report something missing') : 'Not there anymore?'}
        </h2>
        <button type="button" className={`${chip} bg-cream text-ink`} onClick={onClose}>
          {state.s === 'sent' || state.s === 'edited' ? 'Done' : 'Cancel'}
        </button>
      </div>

      {state.s === 'sent' ? (
        <div className="mt-2 text-sm text-ink" role="status">
          <p className="font-bold">Thanks! Your note is on OpenStreetMap.</p>
          <p className="mt-1 text-inkSoft">
            A volunteer mapper will check it. Once it is mapped, it shows up here after the next weekly map update.
          </p>
          <a className="mt-2 inline-block font-bold underline" href={state.url} target="_blank" rel="noopener noreferrer">
            See note #{state.id}
          </a>
        </div>
      ) : state.s === 'edited' ? (
        <div className="mt-2 text-sm text-ink" role="status">
          <p className="font-bold">
            {target.change === 'missing' ? `Thanks! The ${label ?? 'point'} is on OpenStreetMap.` : `Removed from OpenStreetMap. Thanks!`}
          </p>
          <p className="mt-1 text-inkSoft">
            {target.change === 'missing'
              ? 'PawPath shows it for everyone after the next weekly map update; until then it is marked on your map.'
              : 'It disappears from PawPath after the next weekly map update.'}
          </p>
          <a className="mt-2 inline-block font-bold underline" href={state.url} target="_blank" rel="noopener noreferrer">
            See it on OpenStreetMap
          </a>
        </div>
      ) : (
        <>
          {target.change === 'missing' ? (
            <>
              <div className="flex items-center justify-between gap-2 text-sm text-inkSoft">
                <span>What is at the marked spot?</span>
                {onMoveSpot !== undefined ? (
                  <button type="button" className={`${link} shrink-0`} onClick={onMoveSpot}>
                    Move the spot
                  </button>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap gap-2">
                {REPORT_KIND_KEYS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kind === k}
                    className={`${chip} ${kind === k ? 'bg-sageDeep text-cream' : 'bg-cream text-ink'}`}
                    onClick={() => setKind(k)}
                  >
                    {REPORT_KINDS[k].label}
                  </button>
                ))}
              </div>
            </>
          ) : direct ? (
            <p className="mt-1 text-sm text-inkSoft">
              Remove this {REPORT_KINDS[target.kind].label.toLowerCase()} from OpenStreetMap? Only if you are sure it is
              gone — you are standing there, or you checked.
            </p>
          ) : (
            <p className="mt-1 text-sm text-inkSoft">
              Tell OpenStreetMap mappers that this {REPORT_KINDS[target.kind].label.toLowerCase()} seems to be gone.
            </p>
          )}

          {hint !== undefined ? <p className="mt-2 text-sm font-bold text-ink">{hint}</p> : null}

          {direct ? (
            kind !== undefined && target.change === 'missing' ? (
              <details className="mt-2 text-xs text-inkSoft">
                <summary className="cursor-pointer">What will be added</summary>
                <p className="mt-1 whitespace-pre-line rounded-blob bg-creamDeep/60 p-2">
                  {Object.entries(REPORT_KINDS[kind].osmTags)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('\n')}
                  {`\n\nChangeset: “Added a ${label ?? ''} via PawPath”`}
                </p>
              </details>
            ) : null
          ) : (
            <>
              <label className="mt-2 block text-sm font-bold text-ink" htmlFor="note-comment">
                Anything to add? <span className="font-normal text-inkSoft">(optional)</span>
              </label>
              <textarea
                id="note-comment"
                value={comment}
                maxLength={500}
                rows={2}
                onChange={(event) => setComment(event.target.value)}
                placeholder="e.g. next to the playground entrance"
                className="mt-1 w-full rounded-blob bg-cream px-3 py-2 text-base text-ink ring-1 ring-creamDeep focus:outline-none focus:ring-2 focus:ring-sageDeep"
              />
              {text !== '' ? (
                <details className="mt-1 text-xs text-inkSoft">
                  <summary className="cursor-pointer">What will be sent</summary>
                  <p className="mt-1 whitespace-pre-line rounded-blob bg-creamDeep/60 p-2">{text}</p>
                </details>
              ) : null}
            </>
          )}

          <p className="mt-2 text-xs leading-snug text-inkSoft">
            {direct ? (
              <>
                This edits OpenStreetMap <strong>under your account</strong>, for everyone. Only for things that are
                always there.
              </>
            ) : (
              <>
                This creates a <strong>public, anonymous note</strong> on OpenStreetMap that volunteers check. Don’t add
                personal details. Only for things that are always there — not for temporary problems.
              </>
            )}
          </p>
          {state.s === 'failed' ? (
            <p className="mt-1 text-sm font-bold text-ink" role="alert">
              {state.message}
            </p>
          ) : null}

          {direct ? (
            <button
              type="button"
              disabled={kind === undefined || point === undefined || state.s === 'sending'}
              onClick={() => void edit()}
              className="mt-2 min-h-[44px] w-full rounded-full bg-terracotta px-4 font-display text-lg text-cream shadow-soft active:bg-terracottaDeep disabled:opacity-50"
            >
              {state.s === 'sending' ? 'Saving…' : target.change === 'missing' ? 'Add to the map' : 'Remove from the map'}
            </button>
          ) : (
            <button
              type="button"
              disabled={report === undefined || point === undefined || state.s === 'sending' || noteCooldownS() > 0}
              onClick={() => void send()}
              className="mt-2 min-h-[44px] w-full rounded-full bg-terracotta px-4 font-display text-lg text-cream shadow-soft active:bg-terracottaDeep disabled:opacity-50"
            >
              {state.s === 'sending' ? 'Sending…' : noteCooldownS() > 0 ? 'One note per minute — wait a moment' : 'Send note'}
            </button>
          )}

          {/* The sign-in lives here, small: only walkers with an OSM account need it. */}
          {osm.session !== undefined ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-inkSoft">
              <span>OpenStreetMap: {osm.session.user}</span>·
              {canEditDirectly ? (
                <button type="button" className={link} onClick={() => setPreferNote((v) => !v)}>
                  {preferNote ? 'Edit directly' : 'Send a note instead'}
                </button>
              ) : null}
              {canEditDirectly ? '·' : null}
              <button type="button" className={link} onClick={osm.signOut}>
                Sign out
              </button>
            </p>
          ) : osm.available ? (
            <p className="mt-1 text-xs text-inkSoft">
              Have an OpenStreetMap account?{' '}
              <button type="button" className={link} onClick={osm.signIn}>
                Sign in
              </button>{' '}
              to add or remove things directly.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
