/**
 * Place search. Runs on submit only — never per keystroke — to stay inside
 * Photon's fair-use terms (CLAUDE.md §5).
 */

import { useRef, useState } from 'react';

import { searchPlaces, type PlaceResult } from '../../data/sources/photonSource';

export default function SearchBox({
  near,
  onPick,
}: {
  near: { lat: number; lng: number } | undefined;
  onPick: (result: PlaceResult) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly PlaceResult[]>([]);
  const [status, setStatus] = useState<'idle' | 'searching'>('idle');
  const [message, setMessage] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const submit = async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('searching');
    setMessage('');
    const outcome = await searchPlaces(query, near, controller.signal);
    if (controller.signal.aborted) return;
    setStatus('idle');
    if (outcome.ok) {
      setResults(outcome.results);
      if (outcome.results.length === 0) setMessage('No places found — try another spelling?');
    } else {
      setResults([]);
      setMessage(outcome.message);
    }
  };

  return (
    <form
      className="pointer-events-auto mx-2"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="sr-only" htmlFor="place-search">
        Search for a place
      </label>
      <div className="flex gap-2">
        <input
          id="place-search"
          type="search"
          value={query}
          placeholder="Where are you walking?"
          autoComplete="off"
          enterKeyHint="search"
          className="min-h-[44px] w-full rounded-full bg-cream px-4 text-base text-ink shadow-soft ring-1 ring-creamDeep placeholder:text-inkSoft focus:outline-none focus:ring-2 focus:ring-sageDeep"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="submit"
          disabled={status === 'searching'}
          className="min-h-[44px] shrink-0 rounded-full bg-sageDeep px-4 font-display text-cream shadow-soft disabled:opacity-60"
        >
          {status === 'searching' ? '…' : 'Go'}
        </button>
      </div>

      {message !== '' ? (
        <p className="mt-1 rounded-blob bg-cream/95 px-3 py-1 text-sm text-inkSoft">{message}</p>
      ) : null}

      {results.length > 0 ? (
        <ul className="mt-1 max-h-64 overflow-y-auto rounded-blob bg-cream shadow-soft ring-1 ring-creamDeep">
          {results.map((result) => (
            <li key={`${result.lat},${result.lng},${result.label}`}>
              <button
                type="button"
                className="min-h-[44px] w-full px-4 py-2 text-left text-sm text-ink hover:bg-creamDeep"
                onClick={() => {
                  onPick(result);
                  setResults([]);
                  setQuery('');
                }}
              >
                {result.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-1 px-3 text-[11px] text-inkSoft">Search by Photon · © OpenStreetMap contributors</p>
    </form>
  );
}
