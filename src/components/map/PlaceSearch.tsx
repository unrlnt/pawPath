/**
 * Place search — the fallback when geolocation is denied or unavailable.
 *
 * Debounced in the UI for typing comfort; the one-request-per-second policy
 * floor is enforced in `geocodingSource`, not here. A debounce is a UX device
 * and must never be the only thing standing between us and a rate limit.
 */

import { useEffect, useRef, useState } from 'react';

import { NOMINATIM_DEBOUNCE_MS } from '../../config';
import { searchPlaces, type GeocodeResult } from '../../data/sources/geocodingSource';

export interface PlaceSearchProps {
  readonly onPick: (result: GeocodeResult) => void;
}

export default function PlaceSearch({ onPick }: PlaceSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly GeocodeResult[]>([]);
  const [status, setStatus] = useState<'idle' | 'searching' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setStatus('idle');
      return;
    }

    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus('searching');

      void searchPlaces(query, controller.signal).then((outcome) => {
        if (controller.signal.aborted) return;
        if (outcome.ok) {
          setResults(outcome.results);
          setStatus('idle');
          setMessage(outcome.results.length === 0 ? 'No places found.' : '');
        } else {
          setResults([]);
          setStatus('error');
          setMessage(outcome.message);
        }
      });
    }, NOMINATIM_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div className="pointer-events-auto w-full">
      <label className="sr-only" htmlFor="place-search">
        Search for a place
      </label>
      <input
        id="place-search"
        type="search"
        value={query}
        placeholder="Search for a place…"
        autoComplete="off"
        className="min-h-[44px] w-full rounded border-2 border-slate-400 bg-white px-3 text-base shadow"
        onChange={(event) => setQuery(event.target.value)}
      />

      {status === 'searching' ? (
        <p className="mt-1 rounded bg-white/95 px-2 py-1 text-xs text-slate-600">Searching…</p>
      ) : null}

      {message !== '' && status !== 'searching' ? (
        <p
          className={`mt-1 rounded bg-white/95 px-2 py-1 text-xs ${
            status === 'error' ? 'text-red-700' : 'text-slate-600'
          }`}
        >
          {message}
        </p>
      ) : null}

      {results.length > 0 ? (
        <ul className="mt-1 max-h-64 overflow-y-auto rounded border border-slate-300 bg-white shadow-lg">
          {results.map((result) => (
            <li key={`${result.lat},${result.lng},${result.label}`}>
              <button
                type="button"
                className="min-h-[44px] w-full px-3 py-2 text-left text-sm hover:bg-slate-100"
                onClick={() => {
                  onPick(result);
                  setQuery('');
                  setResults([]);
                }}
              >
                {result.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-1 px-1 text-[11px] text-slate-500">Search by Nominatim / OpenStreetMap</p>
    </div>
  );
}
