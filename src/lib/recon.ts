/**
 * Shapes and pure helpers for the Phase 1 coverage survey.
 *
 * Kept out of the component so the verdict rules and the summary formatting
 * are testable without a browser or a network.
 */

import { RECON_DENSITY_THRESHOLDS } from '../config';
import type { LayerKey, TileSourceErrorKind } from '../data/sources';

export interface ReconLocation {
  readonly label: string;
  readonly lat: number;
  readonly lng: number;
  readonly country?: string;
}

/** One query per layer is kinder to Overpass; one per tag gives exact timings. */
export type ReconMode = 'perLayer' | 'perTag';

export type ReconStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface SelectorResult {
  readonly selectorId: string;
  readonly label: string;
  readonly count: number;
  readonly nodes: number;
  readonly ways: number;
  readonly relations: number;
  /** Undefined in `perLayer` mode, where the timing belongs to the layer. */
  readonly durationMs: number | undefined;
}

export interface ReconQuery {
  readonly label: string;
  readonly ql: string;
  readonly durationMs: number;
  readonly endpoint: string | undefined;
}

export interface LayerResult {
  readonly layer: LayerKey;
  readonly label: string;
  readonly note: string | undefined;
  readonly status: ReconStatus;
  /** Distinct features across the layer — less than the sum of tags if tags overlap. */
  readonly total: number;
  readonly durationMs: number;
  readonly endpoint: string | undefined;
  readonly truncated: boolean;
  readonly errorKind: TileSourceErrorKind | undefined;
  readonly errorMessage: string | undefined;
  readonly queries: readonly ReconQuery[];
  readonly selectors: readonly SelectorResult[];
}

export interface ReconRun {
  readonly id: string;
  readonly location: ReconLocation;
  readonly radiusKm: number;
  readonly areaKm2: number;
  readonly mode: ReconMode;
  readonly layers: readonly LayerResult[];
}

export type CoverageVerdict = 'good' | 'thin' | 'none';

/** Features per km² → the yes/no answer Phase 1 exists to produce. */
export function coverageVerdict(density: number): CoverageVerdict {
  if (density >= RECON_DENSITY_THRESHOLDS.good) return 'good';
  if (density >= RECON_DENSITY_THRESHOLDS.thin) return 'thin';
  return 'none';
}

export function density(count: number, areaKm2: number): number {
  return areaKm2 <= 0 ? 0 : count / areaKm2;
}

export function verdictFor(count: number, areaKm2: number): CoverageVerdict {
  return count === 0 ? 'none' : coverageVerdict(density(count, areaKm2));
}

export const VERDICT_LABELS: Readonly<Record<CoverageVerdict, string>> = {
  good: 'worth a toggle',
  thin: 'sparse',
  none: 'not worth a toggle',
};

function round(value: number, places = 2): string {
  return value.toFixed(places);
}

/**
 * A Markdown block that can be pasted straight into CLAUDE.md §12 "Recon
 * findings". Optimised for answering "does this layer justify a toggle here",
 * not for looking tidy.
 */
export function formatReconMarkdown(runs: readonly ReconRun[], generatedAt: Date): string {
  if (runs.length === 0) return 'No recon runs yet.';

  const lines: string[] = [
    `# Overpass coverage recon — ${generatedAt.toISOString().slice(0, 10)}`,
    '',
    `Thresholds: ≥ ${RECON_DENSITY_THRESHOLDS.good}/km² = worth a toggle, ` +
      `≥ ${RECON_DENSITY_THRESHOLDS.thin}/km² = sparse, below = not worth a toggle.`,
    '',
  ];

  for (const run of runs) {
    lines.push(
      `## ${run.location.label} — ${round(run.location.lat, 4)}, ${round(run.location.lng, 4)} ` +
        `· r=${run.radiusKm} km · ${round(run.areaKm2, 1)} km² · ${
          run.mode === 'perLayer' ? 'one query per layer' : 'one query per tag'
        }`,
      '',
      '| Layer | Tag | Count | Per km² | Verdict | Query ms |',
      '|---|---|---:|---:|---|---:|',
    );

    for (const layer of run.layers) {
      if (layer.status === 'error') {
        lines.push(
          `| ${layer.label} | — | — | — | **${layer.errorKind ?? 'error'}**: ${
            layer.errorMessage ?? 'failed'
          } | ${layer.durationMs} |`,
        );
        continue;
      }
      if (layer.status !== 'done') continue;

      for (const selector of layer.selectors) {
        const perKm2 = density(selector.count, run.areaKm2);
        lines.push(
          `| ${layer.label} | \`${selector.label}\` | ${selector.count} | ${round(perKm2)} | ${
            VERDICT_LABELS[verdictFor(selector.count, run.areaKm2)]
          } | ${selector.durationMs ?? layer.durationMs} |`,
        );
      }

      const layerDensity = density(layer.total, run.areaKm2);
      lines.push(
        `| **${layer.label}** | **layer total (distinct)** | **${layer.total}** | **${round(
          layerDensity,
        )}** | **${VERDICT_LABELS[verdictFor(layer.total, run.areaKm2)]}** | ${layer.durationMs} |`,
      );
      if (layer.truncated) {
        lines.push(`| ${layer.label} | ⚠️ result cap hit — count is a floor | | | | |`);
      }
    }

    lines.push('');

    const notes = run.layers.filter((layer) => layer.note !== undefined);
    if (notes.length > 0) {
      lines.push('Notes:');
      for (const layer of notes) lines.push(`- **${layer.label}**: ${layer.note ?? ''}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
