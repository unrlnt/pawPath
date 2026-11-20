/**
 * Dev-only diagnostics: cache inspector, session request budget, instance
 * health, and a connectivity tester.
 *
 * The connectivity tester exists because of how Phase 1 went wrong. When the
 * map fails, the first question is whether the instances are reachable at all —
 * and that question must be answerable without the tile pipeline, the cache,
 * the retry loop or the circuit breaker in the way. One trivial `out count` per
 * instance, no retries, full error detail.
 */

import { useCallback, useState } from 'react';

import { OVERPASS_INSTANCE_CONFIGS } from '../../config';
import {
  allInstanceHealth,
  isParked,
  sessionUsage,
  testInstanceConnectivity,
  tileCache,
  type CacheInventory,
  type ConnectivityResult,
} from '../../data/sources';

export default function DevPanel() {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<CacheInventory | undefined>(undefined);
  const [connectivity, setConnectivity] = useState<readonly ConnectivityResult[]>([]);
  const [testing, setTesting] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    setInventory(await tileCache.inventory());
    setTick((value) => value + 1);
  }, []);

  const runConnectivityTest = useCallback(async () => {
    setTesting(true);
    setConnectivity([]);
    try {
      const results: ConnectivityResult[] = [];
      // Sequential: the usage policy forbids parallel requests from one client,
      // and that applies to our diagnostics too.
      for (const instance of OVERPASS_INSTANCE_CONFIGS) {
        results.push(await testInstanceConnectivity(instance.url, instance.label));
        setConnectivity([...results]);
      }
    } finally {
      setTesting(false);
    }
  }, []);

  if (!open) {
    return (
      <button
        type="button"
        className="pointer-events-auto rounded bg-slate-900/85 px-2 py-1 text-xs font-medium text-white"
        onClick={() => {
          setOpen(true);
          void refresh();
        }}
      >
        dev
      </button>
    );
  }

  const usage = sessionUsage();
  const health = allInstanceHealth();
  const stats = tileCache.cacheStats();
  const requestPercent = Math.round((usage.requests / usage.requestBudget) * 100);
  const bytePercent = Math.round((usage.bytes / usage.byteBudget) * 100);

  return (
    <div
      key={tick}
      className="pointer-events-auto max-h-[70vh] w-[min(92vw,26rem)] overflow-y-auto rounded border border-slate-400 bg-white p-3 text-xs shadow-xl"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold">Diagnostics</h2>
        <button
          type="button"
          className="rounded border border-slate-400 px-2 py-1"
          onClick={() => setOpen(false)}
        >
          close
        </button>
      </div>

      <Section title="Session request budget">
        <Row label="Requests">
          {usage.requests} / {usage.requestBudget} ({requestPercent}%)
        </Row>
        <Row label="Downloaded">
          {(usage.bytes / 1024 / 1024).toFixed(2)} MB / {Math.round(usage.byteBudget / 1024 / 1024)}{' '}
          MB ({bytePercent}%)
        </Row>
        <p className="mt-1 text-[11px] text-slate-500">
          Budgeted against the Overpass usage policy's documented safety margin of roughly 10,000
          requests or 1 GB per user per day. Requests stop when spent; reload to reset.
        </p>
      </Section>

      <Section title="Tile cache">
        <Row label="Entries">{inventory?.entries ?? '—'}</Row>
        <Row label="Approx. size">
          {inventory === undefined ? '—' : `${(inventory.approximateBytes / 1024).toFixed(0)} KB`}
        </Row>
        <Row label="Hits / misses">
          {stats.hits} / {stats.misses}
        </Row>
        <Row label="Writes / evictions">
          {stats.writes} / {stats.evictions}
        </Row>
        <Row label="Errors">{stats.errors}</Row>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className="rounded border border-slate-400 px-2 py-1"
            onClick={() => void refresh()}
          >
            refresh
          </button>
          <button
            type="button"
            className="rounded border border-slate-400 px-2 py-1"
            onClick={() => {
              void tileCache.clear().then(refresh);
            }}
          >
            clear cache
          </button>
        </div>
      </Section>

      <Section title="Instance health">
        <table className="w-full">
          <tbody>
            {health.map((instance) => (
              <tr key={instance.url} className="border-t border-slate-200">
                <td className="py-1 pr-2 font-medium">{instance.label}</td>
                <td className="py-1">
                  {isParked(instance) ? (
                    <span className="text-amber-700">parked by breaker</span>
                  ) : instance.lastSuccessAt !== undefined ? (
                    <span className="text-green-700">ok</span>
                  ) : (
                    <span className="text-slate-500">untried</span>
                  )}
                </td>
                <td className="py-1 text-right text-slate-500">
                  {instance.totalFailures}/{instance.totalRequests} failed
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Connectivity">
        <button
          type="button"
          disabled={testing}
          className="rounded bg-slate-900 px-2 py-1 font-medium text-white disabled:opacity-40"
          onClick={() => void runConnectivityTest()}
        >
          {testing ? 'testing…' : 'test all instances'}
        </button>
        <p className="mt-1 text-[11px] text-slate-500">
          One trivial <code>out count</code> query each, no retries, bypassing the tile pipeline.
        </p>
        <ul className="mt-2 space-y-1">
          {connectivity.map((result) => (
            <li key={result.url} className="border-t border-slate-200 pt-1">
              <div className="flex justify-between font-medium">
                <span>{result.label}</span>
                <span className={result.ok ? 'text-green-700' : 'text-red-700'}>
                  {result.ok ? `ok · ${result.durationMs} ms` : `failed · ${result.durationMs} ms`}
                </span>
              </div>
              <div className="break-words text-[11px] text-slate-600">{result.detail}</div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-3 rounded border border-slate-200 p-2">
      <h3 className="mb-1 font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-600">{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  );
}
