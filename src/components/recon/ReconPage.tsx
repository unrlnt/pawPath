/**
 * Phase 1 recon page — dev-only, deliberately plain.
 *
 * It exists to answer one question per layer: is there enough OSM data here to
 * justify a toggle? Everything on the page serves that: per-tag counts, density
 * per km², the exact Overpass QL that produced them, and a paste-ready summary.
 */

import { useCallback, useRef, useState } from 'react';

import {
  APP_NAME,
  OVERPASS_INSTANCES,
  RECON_DEFAULT_RADIUS_KM,
  RECON_DENSITY_THRESHOLDS,
  RECON_MIN_QUERY_INTERVAL_MS,
  RECON_PRESETS,
  RECON_PRESET_INTERVAL_MS,
} from '../../config';
import {
  ALL_LAYERS,
  matchesSelector,
  overpassSource,
  type LayerKey,
  type TagValueCount,
} from '../../data/sources';
import { bboxAreaKm2, bboxAround } from '../../lib/tiles';
import {
  VERDICT_LABELS,
  density,
  formatReconMarkdown,
  verdictFor,
  type LayerResult,
  type ReconLocation,
  type ReconQuery,
  type ReconMode,
  type ReconRun,
  type SelectorResult,
} from '../../lib/recon';

/* ------------------------------------------------------------------ *
 * Run orchestration
 * ------------------------------------------------------------------ */

function pendingLayer(layer: (typeof ALL_LAYERS)[number]): LayerResult {
  return {
    layer: layer.key,
    label: layer.label,
    note: layer.note,
    status: 'pending',
    total: 0,
    durationMs: 0,
    endpoint: undefined,
    truncated: false,
    errorKind: undefined,
    errorMessage: undefined,
    queries: [],
    selectors: [],
  };
}

function countByKind(ids: readonly string[]): { nodes: number; ways: number; relations: number } {
  let nodes = 0;
  let ways = 0;
  let relations = 0;
  for (const id of ids) {
    // Ids are source-prefixed, e.g. `osm:way/123`.
    const local = id.slice(id.indexOf(':') + 1);
    if (local.startsWith('node/')) nodes += 1;
    else if (local.startsWith('way/')) ways += 1;
    else if (local.startsWith('relation/')) relations += 1;
  }
  return { nodes, ways, relations };
}

interface TagDistribution {
  readonly key: string;
  readonly location: string;
  readonly values: readonly TagValueCount[];
  readonly total: number;
  readonly ql: string;
  readonly error?: string;
}

/** Abortable pause. Used for the deliberate gap between presets. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function ReconPage() {
  const firstPreset = RECON_PRESETS[0];
  const [lat, setLat] = useState(String(firstPreset?.lat ?? 52.3508));
  const [lng, setLng] = useState(String(firstPreset?.lng ?? 5.2647));
  const [label, setLabel] = useState<string>(firstPreset?.label ?? 'Custom');
  const [radiusKm, setRadiusKm] = useState(String(RECON_DEFAULT_RADIUS_KM));
  const [mode, setMode] = useState<ReconMode>('perLayer');
  const [runs, setRuns] = useState<ReconRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [distribution, setDistribution] = useState<TagDistribution | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runCounter = useRef(0);

  const patchLayer = useCallback(
    (runId: string, layerKey: LayerKey, patch: Partial<LayerResult>) => {
      setRuns((current) =>
        current.map((run) =>
          run.id !== runId
            ? run
            : {
                ...run,
                layers: run.layers.map((entry) =>
                  entry.layer === layerKey ? { ...entry, ...patch } : entry,
                ),
              },
        ),
      );
    },
    [],
  );

  const runOne = useCallback(
    async (location: ReconLocation, radius: number, activeMode: ReconMode, signal: AbortSignal) => {
      runCounter.current += 1;
      const runId = `run-${runCounter.current}`;
      const bbox = bboxAround(location.lat, location.lng, radius);
      const areaKm2 = bboxAreaKm2(bbox);

      setRuns((current) => [
        ...current,
        {
          id: runId,
          location,
          radiusKm: radius,
          areaKm2,
          mode: activeMode,
          layers: ALL_LAYERS.map(pendingLayer),
        },
      ]);

      for (const layer of ALL_LAYERS) {
        if (signal.aborted) {
          patchLayer(runId, layer.key, { status: 'cancelled' });
          continue;
        }
        setProgress(`${location.label} · ${layer.label}`);
        patchLayer(runId, layer.key, { status: 'running' });

        // `center` output everywhere: counts are identical to `geom` and the
        // payload is a fraction of the size. Geometry is a Phase 5 concern.
        const selectorBatches =
          activeMode === 'perTag'
            ? layer.selectors.map((selector) => [selector])
            : [layer.selectors];

        const seenIds = new Set<string>();
        const selectorResults: SelectorResult[] = [];
        const queries: ReconQuery[] = [];
        let totalDuration = 0;
        let endpoint: string | undefined;
        let truncated = false;
        let failed = false;

        for (const batch of selectorBatches) {
          const result = await overpassSource.probe({
            bbox,
            layer: layer.key,
            selectors: batch,
            output: 'center',
            context: `recon ${location.label} r=${radius}km ${batch.map((s) => s.id).join('+')}`,
            signal,
            minIntervalMs: RECON_MIN_QUERY_INTERVAL_MS,
          });

          totalDuration += result.meta.durationMs;
          endpoint = result.meta.endpoint ?? endpoint;
          truncated = truncated || result.meta.truncated;
          if (result.meta.query !== undefined) {
            queries.push({
              label: batch.map((selector) => selector.label).join(' | '),
              ql: result.meta.query,
              durationMs: result.meta.durationMs,
              endpoint: result.meta.endpoint,
            });
          }

          if (!result.ok) {
            failed = true;
            patchLayer(runId, layer.key, {
              status: result.error.kind === 'aborted' ? 'cancelled' : 'error',
              errorKind: result.error.kind,
              errorMessage: result.error.message,
              durationMs: totalDuration,
              endpoint,
              queries,
            });
            break;
          }

          for (const feature of result.features) seenIds.add(feature.id);

          // In perLayer mode one response covers every tag, so attribution is
          // done here by re-running the same conditions over the tags.
          for (const selector of batch) {
            const matched = result.features.filter((feature) =>
              matchesSelector(feature.tags, selector),
            );
            const ids = matched.map((feature) => feature.id);
            selectorResults.push({
              selectorId: selector.id,
              label: selector.label,
              count: new Set(ids).size,
              ...countByKind([...new Set(ids)]),
              durationMs: activeMode === 'perTag' ? result.meta.durationMs : undefined,
            });
          }
        }

        if (failed) {
          if (signal.aborted) break;
          continue;
        }

        patchLayer(runId, layer.key, {
          status: 'done',
          total: seenIds.size,
          durationMs: totalDuration,
          endpoint,
          truncated,
          queries,
          selectors: selectorResults,
        });
      }
    },
    [patchLayer],
  );

  const start = useCallback(
    async (locations: readonly ReconLocation[]) => {
      const radius = Number(radiusKm);
      if (!Number.isFinite(radius) || radius <= 0) {
        setProgress('Radius must be a positive number.');
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      try {
        for (const [index, location] of locations.entries()) {
          if (controller.signal.aborted) break;
          // A deliberate gap between locations. Run 1 ran them back-to-back and
          // spent most of its time queued behind itself.
          if (index > 0) {
            const seconds = Math.round(RECON_PRESET_INTERVAL_MS / 1000);
            setProgress(`waiting ${seconds}s before ${location.label}`);
            await delay(RECON_PRESET_INTERVAL_MS, controller.signal);
            if (controller.signal.aborted) break;
          }
          await runOne(location, radius, mode, controller.signal);
        }
        setProgress(controller.signal.aborted ? 'Cancelled.' : 'Done.');
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [mode, radiusKm, runOne],
  );

  const runDistribution = useCallback(
    async (key: string) => {
      const parsedLat = Number(lat);
      const parsedLng = Number(lng);
      const radius = Number(radiusKm);
      if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng) || !Number.isFinite(radius)) {
        setProgress('Latitude, longitude and radius must be numbers.');
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setProgress(`tallying ${key}=* at ${label}`);
      try {
        const result = await overpassSource.probeTagDistribution({
          bbox: bboxAround(parsedLat, parsedLng, radius),
          key,
          context: `recon tag distribution ${key} ${label}`,
          signal: controller.signal,
          minIntervalMs: RECON_MIN_QUERY_INTERVAL_MS,
        });
        setDistribution({
          key,
          location: label,
          ql: result.meta.query ?? '',
          ...(result.ok
            ? { values: result.values, total: result.total }
            : { values: [], total: 0, error: `${result.error.kind}: ${result.error.message}` }),
        });
        setProgress(result.ok ? 'Done.' : 'Failed.');
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [label, lat, lng, radiusKm],
  );

  /** Single-preset mode: survey exactly one location, no waiting. */
  const runPreset = useCallback(
    (preset: (typeof RECON_PRESETS)[number]) => {
      setLabel(preset.label);
      setLat(String(preset.lat));
      setLng(String(preset.lng));
      void start([{ ...preset }]);
    },
    [start],
  );

  const runCustom = useCallback(() => {
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      setProgress('Latitude and longitude must be numbers.');
      return;
    }
    void start([{ label: label.trim() || 'Custom', lat: parsedLat, lng: parsedLng }]);
  }, [label, lat, lng, start]);

  const markdown = formatReconMarkdown(runs, new Date());

  return (
    <div className="min-h-full bg-white p-4 text-slate-900">
      <header className="mb-4">
        <h1 className="text-xl font-bold">{APP_NAME} — Overpass recon</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Phase 1 coverage survey. Every run hits the public Overpass instances directly, one
          request at a time, with {Math.round(RECON_MIN_QUERY_INTERVAL_MS / 1000)}s between queries
          and {Math.round(RECON_PRESET_INTERVAL_MS / 1000)}s between presets — a full four-preset
          sweep therefore takes minutes, and that is the point: Run 1's 35–80s query times were our
          own burst queued behind itself, not slow instances. Verdicts:{' '}
          <strong>≥ {RECON_DENSITY_THRESHOLDS.good}/km²</strong> worth a toggle,{' '}
          <strong>≥ {RECON_DENSITY_THRESHOLDS.thin}/km²</strong> sparse, below that not worth a
          toggle.
        </p>
      </header>

      <section className="mb-4 rounded border border-slate-300 p-3">
        <div className="mb-3 flex flex-wrap gap-2">
          {RECON_PRESETS.map((preset) => (
            <span key={preset.label} className="inline-flex overflow-hidden rounded border border-slate-400">
              <button
                type="button"
                className="px-3 py-1.5 text-sm hover:bg-slate-100"
                title="Load into the form"
                onClick={() => {
                  setLabel(preset.label);
                  setLat(String(preset.lat));
                  setLng(String(preset.lng));
                }}
              >
                {preset.label}
              </button>
              <button
                type="button"
                disabled={busy}
                className="border-l border-slate-400 bg-slate-100 px-2 py-1.5 text-sm font-medium hover:bg-slate-200 disabled:opacity-40"
                title={`Survey ${preset.label} only`}
                onClick={() => runPreset(preset)}
              >
                ▶
              </button>
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Label">
            <input
              className="w-40 rounded border border-slate-400 px-2 py-1 text-sm"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Field label="Latitude">
            <input
              className="w-32 rounded border border-slate-400 px-2 py-1 text-sm"
              value={lat}
              inputMode="decimal"
              onChange={(event) => setLat(event.target.value)}
            />
          </Field>
          <Field label="Longitude">
            <input
              className="w-32 rounded border border-slate-400 px-2 py-1 text-sm"
              value={lng}
              inputMode="decimal"
              onChange={(event) => setLng(event.target.value)}
            />
          </Field>
          <Field label="Radius (km)">
            <input
              className="w-24 rounded border border-slate-400 px-2 py-1 text-sm"
              value={radiusKm}
              inputMode="decimal"
              onChange={(event) => setRadiusKm(event.target.value)}
            />
          </Field>
          <Field label="Mode">
            <select
              className="rounded border border-slate-400 px-2 py-1 text-sm"
              value={mode}
              onChange={(event) => setMode(event.target.value as ReconMode)}
            >
              <option value="perLayer">One query per layer (kind to Overpass)</option>
              <option value="perTag">One query per tag (exact timings)</option>
            </select>
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            onClick={runCustom}
          >
            Run this location
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded bg-slate-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            onClick={() => void start(RECON_PRESETS.map((preset) => ({ ...preset })))}
          >
            Run all {RECON_PRESETS.length} presets
          </button>
          <button
            type="button"
            disabled={!busy}
            className="rounded border border-slate-400 px-3 py-1.5 text-sm disabled:opacity-40"
            onClick={() => abortRef.current?.abort()}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded border border-slate-400 px-3 py-1.5 text-sm disabled:opacity-40"
            title="Tally every value of the dog key at this location"
            onClick={() => void runDistribution('dog')}
          >
            Tally dog=* values
          </button>
          <button
            type="button"
            disabled={busy || runs.length === 0}
            className="rounded border border-slate-400 px-3 py-1.5 text-sm disabled:opacity-40"
            onClick={() => setRuns([])}
          >
            Clear results
          </button>
          <span className="self-center text-sm text-slate-600">
            {busy ? `Running… ${progress}` : progress}
          </span>
        </div>

        <p className="mt-2 text-xs text-slate-500">
          Instances tried in order: {OVERPASS_INSTANCES.join(' → ')}
        </p>
      </section>

      {distribution === null ? null : <DistributionPanel distribution={distribution} />}

      {runs.map((run) => (
        <RunTable key={run.id} run={run} />
      ))}

      {runs.length > 0 ? <SummaryBlock markdown={markdown} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

const VERDICT_CLASS: Record<'good' | 'thin' | 'none', string> = {
  good: 'text-green-700 font-medium',
  thin: 'text-amber-700',
  none: 'text-red-700',
};

/**
 * What mappers here actually write for a key, rather than what we assumed they
 * write. Run 1 queried `dog=off_leash` — a value that does not exist in OSM —
 * and read the zeros as missing data.
 */
function DistributionPanel({ distribution }: { distribution: TagDistribution }) {
  return (
    <section className="mb-6 rounded border-2 border-slate-400">
      <h2 className="border-b border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold">
        <code>{distribution.key}=*</code> value distribution · {distribution.location} ·{' '}
        {distribution.total} tagged elements
      </h2>
      {distribution.error === undefined ? (
        distribution.values.length === 0 ? (
          <p className="px-3 py-2 text-sm text-slate-600">
            No element carries <code>{distribution.key}</code> here.
          </p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-100 text-left">
                <Th>Value</Th>
                <Th align="right">Count</Th>
                <Th align="right">Share</Th>
              </tr>
            </thead>
            <tbody>
              {distribution.values.map((entry) => (
                <tr key={entry.value} className="border-t border-slate-200">
                  <Td>
                    <code className="text-xs">
                      {distribution.key}={entry.value}
                    </code>
                  </Td>
                  <Td align="right">{entry.count}</Td>
                  <Td align="right">
                    {distribution.total === 0
                      ? '—'
                      : `${((entry.count / distribution.total) * 100).toFixed(0)}%`}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        <p className="px-3 py-2 text-sm text-red-700">{distribution.error}</p>
      )}
      <details className="border-t border-slate-300 p-3">
        <summary className="cursor-pointer text-sm text-slate-700">Overpass QL</summary>
        <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-2 text-xs text-slate-100">
          {distribution.ql}
        </pre>
      </details>
    </section>
  );
}

function RunTable({ run }: { run: ReconRun }) {
  return (
    <section className="mb-6 rounded border border-slate-300">
      <h2 className="border-b border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold">
        {run.location.label} · {run.location.lat.toFixed(4)}, {run.location.lng.toFixed(4)} ·
        r={run.radiusKm} km · {run.areaKm2.toFixed(1)} km² ·{' '}
        {run.mode === 'perLayer' ? 'one query per layer' : 'one query per tag'}
      </h2>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-slate-100 text-left">
            <Th>Layer</Th>
            <Th>Tag</Th>
            <Th align="right">Count</Th>
            <Th align="right">n / w / r</Th>
            <Th align="right">Per km²</Th>
            <Th>Verdict</Th>
            <Th align="right">Query ms</Th>
          </tr>
        </thead>
        <tbody>
          {run.layers.map((layer) => (
            <LayerRows key={layer.layer} layer={layer} areaKm2={run.areaKm2} />
          ))}
        </tbody>
      </table>

      <div className="border-t border-slate-300 p-3">
        {run.layers
          .filter((layer) => layer.queries.length > 0)
          .map((layer) => (
            <details key={layer.layer} className="mb-1">
              <summary className="cursor-pointer text-sm text-slate-700">
                Overpass QL — {layer.label} ({layer.queries.length}{' '}
                {layer.queries.length === 1 ? 'query' : 'queries'})
              </summary>
              {layer.queries.map((query) => (
                <div key={query.label} className="mt-2">
                  <div className="text-xs text-slate-500">
                    {query.label} · {query.durationMs} ms · {query.endpoint ?? 'no endpoint'}
                  </div>
                  <pre className="overflow-x-auto rounded bg-slate-900 p-2 text-xs text-slate-100">
                    {query.ql}
                  </pre>
                </div>
              ))}
            </details>
          ))}
      </div>
    </section>
  );
}

function LayerRows({ layer, areaKm2 }: { layer: LayerResult; areaKm2: number }) {
  if (layer.status === 'pending' || layer.status === 'running') {
    return (
      <tr className="border-t border-slate-200">
        <Td>{layer.label}</Td>
        <Td colSpan={6}>
          <span className="text-slate-500">{layer.status === 'running' ? 'querying…' : '—'}</span>
        </Td>
      </tr>
    );
  }

  if (layer.status === 'error' || layer.status === 'cancelled') {
    return (
      <tr className="border-t border-slate-200">
        <Td>{layer.label}</Td>
        <Td colSpan={6}>
          <span className="text-red-700">
            {layer.status === 'cancelled' ? 'cancelled' : `${layer.errorKind}: ${layer.errorMessage}`}
          </span>
        </Td>
      </tr>
    );
  }

  const layerVerdict = verdictFor(layer.total, areaKm2);

  return (
    <>
      {layer.selectors.map((selector) => {
        const verdict = verdictFor(selector.count, areaKm2);
        return (
          <tr key={selector.selectorId} className="border-t border-slate-200">
            <Td>{layer.label}</Td>
            <Td>
              <code className="text-xs">{selector.label}</code>
            </Td>
            <Td align="right">{selector.count}</Td>
            <Td align="right">
              <span className="text-xs text-slate-500">
                {selector.nodes} / {selector.ways} / {selector.relations}
              </span>
            </Td>
            <Td align="right">{density(selector.count, areaKm2).toFixed(2)}</Td>
            <Td>
              <span className={VERDICT_CLASS[verdict]}>{VERDICT_LABELS[verdict]}</span>
            </Td>
            <Td align="right">{selector.durationMs ?? layer.durationMs}</Td>
          </tr>
        );
      })}
      <tr className="border-t border-slate-300 bg-slate-50 font-medium">
        <Td>{layer.label}</Td>
        <Td>
          layer total (distinct)
          {layer.truncated ? (
            <span className="ml-2 text-xs text-amber-700">result cap hit — count is a floor</span>
          ) : null}
        </Td>
        <Td align="right">{layer.total}</Td>
        <Td align="right" />
        <Td align="right">{density(layer.total, areaKm2).toFixed(2)}</Td>
        <Td>
          <span className={VERDICT_CLASS[layerVerdict]}>{VERDICT_LABELS[layerVerdict]}</span>
        </Td>
        <Td align="right">{layer.durationMs}</Td>
      </tr>
      {layer.note === undefined ? null : (
        <tr className="border-t border-slate-200">
          <Td />
          <Td colSpan={6}>
            <span className="text-xs text-slate-500">{layer.note}</span>
          </Td>
        </tr>
      )}
    </>
  );
}

function SummaryBlock({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="mb-10 rounded border border-slate-300 p-3">
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-sm font-semibold">Copyable summary (Markdown)</h2>
        <button
          type="button"
          className="rounded border border-slate-400 px-2 py-1 text-xs"
          onClick={() => {
            void navigator.clipboard.writeText(markdown).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <span className="text-xs text-slate-500">Paste into CLAUDE.md §12 “Recon findings”.</span>
      </div>
      <textarea
        readOnly
        className="h-64 w-full rounded border border-slate-300 p-2 font-mono text-xs"
        value={markdown}
      />
    </section>
  );
}

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th className={`px-2 py-1 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  colSpan,
}: {
  children?: React.ReactNode;
  align?: 'left' | 'right';
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={`px-2 py-1 align-top ${align === 'right' ? 'text-right tabular-nums' : ''}`}
    >
      {children}
    </td>
  );
}
