import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_DISABLED_LEVELS } from '../config';
import { renderSchema } from '../../tools/tiles/generateSchema';
import { LAYER_EXAMPLES } from './layerExamples';
import {
  ALL_LAYERS,
  DEFAULT_DISABLED_FEATURE_LEVELS,
  LAYERS,
  layersFor,
  levelFor,
} from './layers';

describe('shared layer examples (also run by `planetiler verify`)', () => {
  for (const example of LAYER_EXAMPLES) {
    it(example.name, () => {
      const expectedLayers = [...new Set(example.expect.map((f) => f.layer))].sort();
      expect([...layersFor(example.tags)].sort()).toEqual(expectedLayers);

      for (const feature of example.expect) {
        expect(levelFor(LAYERS[feature.layer], example.tags)).toBe(feature.level);
      }
    });
  }
});

describe('the dog=yes rule', () => {
  /**
   * The single most consequential rule in the app: reading dog=yes as
   * off-leash would tell someone their dog may run free where it may not.
   */
  it('never yields an off-leash level, whatever else is tagged', () => {
    const extras = [{}, { leisure: 'park' }, { landuse: 'forest' }, { natural: 'beach' }];
    for (const extra of extras) {
      const level = levelFor(LAYERS.offLeash, { dog: 'yes', ...extra });
      expect(level).toBe('allowed_leash_unknown');
    }
  });

  it('is off by default, and config has no typos', () => {
    expect(DEFAULT_DISABLED_FEATURE_LEVELS).toContain('allowed_leash_unknown');
    expect(DEFAULT_DISABLED_FEATURE_LEVELS).toHaveLength(DEFAULT_DISABLED_LEVELS.length);
  });
});

describe('layer table integrity', () => {
  it('gives every matched element of a levelled layer a level', () => {
    // The generated match expression has no fallback, so a selector that no
    // level rule covers would produce level-less features in the tiles.
    for (const layer of ALL_LAYERS) {
      if (layer.levels === undefined) continue;
      for (const selector of layer.selectors) {
        const tags: Record<string, string> = {};
        for (const condition of selector.conditions) {
          tags[condition.key] =
            condition.op === 'equals'
              ? condition.value
              : condition.op === 'oneOf'
                ? (condition.values[0] ?? '')
                : condition.op === 'prefix'
                  ? `${condition.prefix}x`
                  : 'yes';
        }
        expect(levelFor(layer, tags), `${selector.id}`).toBeDefined();
      }
    }
  });

  it('has unique selector ids', () => {
    const ids = ALL_LAYERS.flatMap((layer) => layer.selectors.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('generated Planetiler schema', () => {
  it('is up to date with layers.ts (run `npm run tiles:schema` if this fails)', () => {
    const committed = readFileSync(
      fileURLToPath(new URL('../../tools/tiles/pawpath.schema.yml', import.meta.url)),
      'utf8',
    );
    expect(committed).toBe(renderSchema());
  });
});
