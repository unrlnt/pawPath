/**
 * PawPath map icons (CLAUDE.md §10 design direction): rounded glyphs with one
 * consistent stroke, on a coloured badge. Defined ONCE as SVG path data:
 *  - the map rasterises them at runtime (`registerIcons`) — no asset files;
 *  - the filter sheet and popups draw the same paths as inline SVG.
 *
 * Every safety level has its own glyph as well as its own colour, so the
 * levels stay distinguishable for colour-blind users.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

import type { FeatureLevel, LayerKey } from '../data/layers';
import { palette, safety } from '../styles/tokens';

/** A glyph on a 24×24 grid: stroked paths (rounded) and/or filled paths. */
export interface Glyph {
  readonly stroke?: readonly string[];
  readonly fill?: readonly string[];
}

const toe = (cx: number, cy: number, r: number): string =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const PAW: readonly string[] = [
  'M12 12.5c2.8 0 5 2.4 5 4.6 0 1.6-1.4 2.4-2.6 2.4-1 0-1.5-.5-2.4-.5s-1.4.5-2.4.5C8.4 19.5 7 18.7 7 17.1c0-2.2 2.2-4.6 5-4.6z',
  toe(7.3, 10, 1.6),
  toe(10.4, 7.2, 1.7),
  toe(13.6, 7.2, 1.7),
  toe(16.7, 10, 1.6),
];

const BIN = ['M6 7.5h12', 'M9.5 7.5V5.5h5v2', 'M7.5 7.5l1 11.5h7l1-11.5'];

export const GLYPHS = {
  bench: { stroke: ['M4 11h16', 'M5.5 11V7.5h13V11', 'M6.5 11v6', 'M17.5 11v6', 'M4.5 14.5h15'] },
  bin: { stroke: [...BIN, 'M10.5 10.5v5.5', 'M13.5 10.5v5.5'] },
  dogBin: { stroke: BIN, fill: [toe(12, 13.6, 1.9), toe(10, 10.8, 0.9), toe(14, 10.8, 0.9)] },
  bag: { stroke: ['M7.5 9h9l1 10h-11z', 'M10 9V7a2 2 0 0 1 4 0v2'] },
  water: { stroke: ['M12 4.5c3 4 5 6.8 5 9.2a5 5 0 0 1-10 0c0-2.4 2-5.2 5-9.2z'] },
  paw: { fill: PAW },
  fence: {
    stroke: ['M6 19V8.5l1.5-2 1.5 2V19', 'M10.5 19V8.5l1.5-2 1.5 2V19', 'M15 19V8.5l1.5-2 1.5 2V19', 'M4.5 11.5h15', 'M4.5 15.5h15'],
  },
  leash: { stroke: ['M6.5 17.5l7-7', 'M15.5 4.5a4 4 0 1 1-2 7.5', 'M6.5 17.5a2 2 0 1 0 0 .1'] },
  noDogs: { fill: PAW, stroke: ['M5 5l14 14'] },
  question: {
    stroke: ['M9.5 9.2a2.5 2.5 0 1 1 3.6 2.3c-.7.4-1.1.9-1.1 1.7v.8'],
    fill: [toe(12, 17.2, 1.1)],
  },
} as const satisfies Record<string, Glyph>;

export type GlyphName = keyof typeof GLYPHS;

/** The badge for one map symbol: glyph + background colour. */
export interface IconSpec {
  readonly glyph: GlyphName;
  readonly colour: string;
}

/** Image id used in MapLibre styles. */
export const iconId = (layer: LayerKey, level: FeatureLevel | 'default'): string => `pp-${layer}-${level}`;

/**
 * Icon per (layer, level). `default` is used for flat layers and as the
 * fallback in style `match` expressions.
 */
export const ICONS: Readonly<Partial<Record<LayerKey, Partial<Record<FeatureLevel | 'default', IconSpec>>>>> = {
  benches: { default: { glyph: 'bench', colour: palette.goldenDeep } },
  drinkingWater: { default: { glyph: 'water', colour: '#3E8FA6' } },
  waste: {
    default: { glyph: 'bin', colour: palette.inkSoft },
    general: { glyph: 'bin', colour: palette.inkSoft },
    dog_bin: { glyph: 'dogBin', colour: palette.terracottaDeep },
    bag_dispenser: { glyph: 'bag', colour: palette.sageDeep },
  },
  offLeash: {
    default: { glyph: 'question', colour: safety.neutral },
    off_leash: { glyph: 'paw', colour: safety.offLeash },
    off_leash_fenced: { glyph: 'fence', colour: safety.offLeash },
    leashed: { glyph: 'leash', colour: safety.leashed },
    prohibited: { glyph: 'noDogs', colour: safety.prohibited },
    allowed_leash_unknown: { glyph: 'question', colour: safety.neutral },
  },
};

/** Logical size of a badge in CSS pixels. */
export const BADGE_SIZE = 28;

/**
 * Draws a badge: coloured disc, cream ring, cream glyph. Uses Path2D, which
 * accepts SVG path strings directly, so the same data drives map and UI.
 */
export function drawBadge(spec: IconSpec, pixelRatio: number): ImageData {
  const size = Math.round(BADGE_SIZE * pixelRatio);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas unavailable');

  const r = size / 2;
  ctx.beginPath();
  ctx.arc(r, r, r - pixelRatio, 0, Math.PI * 2);
  ctx.fillStyle = spec.colour;
  ctx.fill();
  ctx.lineWidth = 2 * pixelRatio;
  ctx.strokeStyle = palette.cream;
  ctx.stroke();

  // Glyph grid is 24×24; inset it so it sits inside the ring.
  const scale = (size * 0.7) / 24;
  ctx.save();
  ctx.translate(size * 0.15, size * 0.15);
  ctx.scale(scale, scale);
  ctx.strokeStyle = palette.cream;
  ctx.fillStyle = palette.cream;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const glyph: Glyph = GLYPHS[spec.glyph];
  for (const d of glyph.fill ?? []) ctx.fill(new Path2D(d));
  for (const d of glyph.stroke ?? []) ctx.stroke(new Path2D(d));
  ctx.restore();

  return ctx.getImageData(0, 0, size, size);
}

/** Hatch patterns for shade, by level (Phase 5). */
export const HATCH = { dense: 'pp-hatch-dense', medium: 'pp-hatch-medium' } as const;

/** A seamless diagonal hatch tile. */
function drawHatch(spacingPx: number, pixelRatio: number): ImageData {
  const size = Math.round(spacingPx * pixelRatio);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas unavailable');
  ctx.strokeStyle = palette.sageDeep;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.6 * pixelRatio;
  ctx.lineCap = 'square';
  // Three strokes so the diagonal continues across tile edges.
  for (const offset of [-size, 0, size]) {
    ctx.beginPath();
    ctx.moveTo(offset, size);
    ctx.lineTo(offset + size, 0);
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, size, size);
}

/** Adds every PawPath icon to the map's style. Idempotent; call after each style load. */
export function registerIcons(map: MapLibreMap): void {
  const pixelRatio = Math.max(2, Math.ceil(window.devicePixelRatio || 1));
  for (const [layer, levels] of Object.entries(ICONS)) {
    for (const [level, spec] of Object.entries(levels ?? {})) {
      const id = `pp-${layer}-${level}`;
      if (spec === undefined || map.hasImage(id)) continue;
      map.addImage(id, drawBadge(spec, pixelRatio), { pixelRatio });
    }
  }
  if (!map.hasImage(HATCH.dense)) map.addImage(HATCH.dense, drawHatch(7, pixelRatio), { pixelRatio });
  if (!map.hasImage(HATCH.medium)) map.addImage(HATCH.medium, drawHatch(12, pixelRatio), { pixelRatio });
}
