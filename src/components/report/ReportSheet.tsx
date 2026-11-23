/**
 * Report something missing or gone (Phase 12) as an anonymous OSM note.
 * Permanent amenities only; the walker sees exactly what will be sent.
 */

import { useState } from 'react';

import { createNote, noteCooldownS } from '../../data/sources/osmNotes';
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

export default function ReportSheet({
  target,
  where,
  onMoveSpot,
  onClose,
}: {
  target: ReportTarget;
  /** For `missing`: the spot chosen in step 1. */
  where: { lat: number; lng: number } | undefined;
  /** For `missing`: back to step 1 to move the spot. */
  onMoveSpot?: () => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<ReportKind | undefined>(target.change === 'gone' ? target.kind : undefined);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<SendState>({ s: 'editing' });

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

  return (
    <section
      aria-label="Report to OpenStreetMap"
      className="pointer-events-auto mx-2 max-h-[60vh] overflow-y-auto rounded-blob bg-cream/95 p-3 shadow-soft ring-1 ring-creamDeep"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-display text-lg font-semibold leading-tight text-ink">
          {target.change === 'missing' ? 'Report something missing' : 'Not there anymore?'}
        </h2>
        <button type="button" className={`${chip} bg-cream text-ink`} onClick={onClose}>
          {state.s === 'sent' ? 'Done' : 'Cancel'}
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
      ) : (
        <>
          {target.change === 'missing' ? (
            <>
              <div className="flex items-center justify-between gap-2 text-sm text-inkSoft">
                <span>What is at the marked spot?</span>
                {onMoveSpot !== undefined ? (
                  <button type="button" className="min-h-[44px] shrink-0 px-1 font-bold text-ink underline" onClick={onMoveSpot}>
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
          ) : (
            <p className="mt-1 text-sm text-inkSoft">
              Tell OpenStreetMap mappers that this {REPORT_KINDS[target.kind].label.toLowerCase()} seems to be gone.
            </p>
          )}

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

          <p className="mt-2 text-xs leading-snug text-inkSoft">
            This creates a <strong>public, anonymous note</strong> on OpenStreetMap that volunteers check. Don’t add
            personal details. Only for things that are always there — not for temporary problems.
          </p>
          {state.s === 'failed' ? (
            <p className="mt-1 text-sm font-bold text-ink" role="alert">
              {state.message}
            </p>
          ) : null}

          <button
            type="button"
            disabled={report === undefined || point === undefined || state.s === 'sending' || noteCooldownS() > 0}
            onClick={() => void send()}
            className="mt-2 min-h-[44px] w-full rounded-full bg-terracotta px-4 font-display text-lg text-cream shadow-soft active:bg-terracottaDeep disabled:opacity-50"
          >
            {state.s === 'sending' ? 'Sending…' : noteCooldownS() > 0 ? 'One note per minute — wait a moment' : 'Send note'}
          </button>
        </>
      )}
    </section>
  );
}
