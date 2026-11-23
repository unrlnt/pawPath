/**
 * Place search with suggestions while typing (owner, 2026-11-23), like any
 * maps app. Fair to Photon (CLAUDE.md §5): suggestions start at
 * PHOTON_MIN_QUERY_LENGTH letters after a PHOTON_DEBOUNCE_MS pause, a newer
 * keystroke aborts the older request, and the source caches recent queries
 * and enforces a minimum interval.
 */

import { useEffect, useRef, useState } from 'react';

import { PHOTON_DEBOUNCE_MS, PHOTON_MIN_QUERY_LENGTH } from '../../config';
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
  // The bias point changes as the map moves; read it without re-searching.
  const nearRef = useRef(near);
  nearRef.current = near;

  const run = async (text: string): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('searching');
    const outcome = await searchPlaces(text, nearRef.current, controller.signal);
    if (controller.signal.aborted) return;
    setStatus('idle');
    if (outcome.ok) {
      setResults(outcome.results);
      setMessage(outcome.results.length === 0 ? 'No places found — try another spelling?' : '');
    } else {
      setResults([]);
      setMessage(outcome.message);
    }
  };

  // Suggestions while typing, after a short pause.
  useEffect(() => {
    const text = query.trim();
    if (text.length < PHOTON_MIN_QUERY_LENGTH) {
      abortRef.current?.abort();
      setResults([]);
      setMessage('');
      setStatus('idle');
      return;
    }
    const timer = setTimeout(() => void run(text), PHOTON_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const pick = (result: PlaceResult): void => {
    onPick(result);
    setResults([]);
    setQuery('');
    setMessage('');
  };

  return (
    <form
      className="pointer-events-auto mx-2"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        // Enter takes the top suggestion, or searches right away.
        const [first] = results;
        if (first !== undefined) pick(first);
        else if (query.trim().length >= PHOTON_MIN_QUERY_LENGTH) void run(query.trim());
        else setMessage(`Type at least ${PHOTON_MIN_QUERY_LENGTH} letters.`);
      }}
    >
      <label className="sr-only" htmlFor="place-search">
        Search for a place
      </label>
      <div className="relative">
        <input
          id="place-search"
          type="search"
          value={query}
          placeholder="Where are you walking?"
          autoComplete="off"
          autoFocus
          enterKeyHint="search"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="place-suggestions"
          className="min-h-[44px] w-full rounded-full bg-cream py-2 pl-4 pr-10 text-base text-ink shadow-soft ring-1 ring-creamDeep placeholder:text-inkSoft focus:outline-none focus:ring-2 focus:ring-sageDeep"
          onChange={(event) => setQuery(event.target.value)}
        />
        {status === 'searching' ? (
          <span
            aria-hidden
            className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-sageDeep border-t-transparent"
          />
        ) : null}
      </div>

      {results.length > 0 ? (
        <ul
          id="place-suggestions"
          role="listbox"
          className="mt-1 max-h-72 overflow-y-auto rounded-blob bg-cream shadow-soft ring-1 ring-creamDeep"
        >
          {results.map((result) => (
            <li key={`${result.lat},${result.lng},${result.label}`} role="option" aria-selected={false}>
              <button
                type="button"
                className="min-h-[44px] w-full px-4 py-2 text-left text-sm text-ink hover:bg-creamDeep active:bg-creamDeep"
                onClick={() => pick(result)}
              >
                {result.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {message !== '' ? (
        <p className="mt-1 rounded-blob bg-cream/95 px-3 py-1 text-sm text-inkSoft">{message}</p>
      ) : null}
      <p className="mt-1 px-3 text-[11px] text-inkSoft">Search by Photon · © OpenStreetMap contributors</p>
    </form>
  );
}
