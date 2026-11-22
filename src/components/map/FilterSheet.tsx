/**
 * The filter sheet (Phase 4): every layer, and inside it every level, as a
 * toggle with its map symbol. Persisted in localStorage by the caller.
 *
 * `dog=yes` ("allowed, leash rule unknown") is OFF until the user opts in,
 * and its explanation sits right next to the switch (CLAUDE.md §6).
 */

import { LAYER_ICONS, LEVEL_LABELS } from '../../data/levelLabels';
import { ALL_LAYERS, type FeatureLevel, type LayerKey } from '../../data/layers';
import { GLYPHS, ICONS, type IconSpec } from '../../map/icons';
import { palette } from '../../styles/tokens';

/** Levels the sheet offers per layer; water levels arrive with Phase 6. */
const SHEET_LEVELS: Partial<Record<LayerKey, readonly FeatureLevel[]>> = {
  offLeash: ['off_leash', 'off_leash_fenced', 'leashed', 'prohibited', 'allowed_leash_unknown'],
  waste: ['bag_dispenser', 'dog_bin', 'general'],
};

const LEVEL_HINTS: Partial<Record<FeatureLevel, string>> = {
  allowed_leash_unknown:
    'Dogs are allowed, but no leash rule is mapped — local law applies, which in NL and DE usually means on a leash. Off by default.',
};

export function GlyphBadge({ spec, size = 28 }: { spec: IconSpec; size?: number }) {
  const glyph: { stroke?: readonly string[]; fill?: readonly string[] } = GLYPHS[spec.glyph];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
      className="shrink-0 rounded-full p-1"
      style={{ background: spec.colour }}
    >
      {(glyph.fill ?? []).map((d) => (
        <path key={d} d={d} fill={palette.cream} />
      ))}
      {(glyph.stroke ?? []).map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={palette.cream}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

function Switch({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      aria-hidden
      title={label}
      className={`relative inline-block h-6 w-11 shrink-0 rounded-full transition-colors ${on ? 'bg-sageDeep' : 'bg-creamDeep ring-1 ring-inkSoft/30'}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-cream shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`}
      />
    </span>
  );
}

export default function FilterSheet({
  enabledLayers,
  disabledLevels,
  onToggleLayer,
  onToggleLevel,
  onClose,
}: {
  enabledLayers: readonly LayerKey[];
  disabledLevels: readonly FeatureLevel[];
  onToggleLayer: (layer: LayerKey) => void;
  onToggleLevel: (level: FeatureLevel) => void;
  onClose: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex flex-col justify-end bg-ink/30" onClick={onClose}>
      <section
        role="dialog"
        aria-label="Map filters"
        className="max-h-[80vh] overflow-y-auto rounded-t-[1.75rem] bg-cream px-4 pb-6 pt-3 shadow-soft"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-creamDeep" />
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-ink">What to show</h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] rounded-full bg-sageDeep px-5 font-display text-cream"
          >
            Done
          </button>
        </div>

        <ul className="divide-y divide-creamDeep">
          {ALL_LAYERS.map((layer) => {
            const on = enabledLayers.includes(layer.key);
            const levels = SHEET_LEVELS[layer.key];
            const icon = ICONS[layer.key]?.default;
            return (
              <li key={layer.key} className="py-2">
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onToggleLayer(layer.key)}
                  className="flex min-h-[48px] w-full items-center gap-3 text-left"
                >
                  {icon !== undefined && levels === undefined ? (
                    <GlyphBadge spec={icon} />
                  ) : (
                    <span aria-hidden className="w-7 text-center text-xl">
                      {LAYER_ICONS[layer.key]}
                    </span>
                  )}
                  <span className="flex-1 font-bold text-ink">{layer.label}</span>
                  <Switch on={on} label={on ? 'shown' : 'hidden'} />
                </button>
                {layer.key === 'water' ? (
                  <p className="ml-10 text-xs text-inkSoft">
                    Official bathing spots and warnings arrive soon. Ordinary ponds and ditches are never
                    marked — almost no water is monitored.
                  </p>
                ) : null}
                {on && levels !== undefined ? (
                  <ul className="ml-10 mt-1 space-y-1">
                    {levels.map((level) => {
                      const levelOn = !disabledLevels.includes(level);
                      const spec = ICONS[layer.key]?.[level];
                      const hint = LEVEL_HINTS[level];
                      return (
                        <li key={level}>
                          <button
                            type="button"
                            aria-pressed={levelOn}
                            onClick={() => onToggleLevel(level)}
                            className="flex min-h-[44px] w-full items-center gap-3 text-left"
                          >
                            {spec !== undefined ? <GlyphBadge spec={spec} size={24} /> : null}
                            <span className="flex-1 text-sm text-ink">{LEVEL_LABELS[level]}</span>
                            <Switch on={levelOn} label={levelOn ? 'shown' : 'hidden'} />
                          </button>
                          {hint !== undefined ? <p className="-mt-1 mb-1 text-xs text-inkSoft">{hint}</p> : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
