import { describe, expect, it } from 'vitest';
import { sanitizeManifest } from '../src/core/manifest-loader.js';

describe('sanitizeManifest', () => {
  it('passes through a well-formed manifest unchanged', () => {
    const raw = {
      generatedAt: '2026-08-31T00:00:00.000Z',
      projectRoot: '/tmp/x',
      filesScanned: 2,
      entities: [{ id: 'entity.order', name: 'Order' }],
      rules: [],
      relations: [],
      apis: [],
      conflicts: [],
      aliases: { Order: ['订单'] },
      fieldIndex: { 'order.status': { entity: 'Order', field: 'status', apis: [], stores: [], pages: [], tests: [] } },
    };
    const warnings: string[] = [];
    const out = sanitizeManifest(raw, (message) => warnings.push(message));
    expect(out.entities).toEqual(raw.entities);
    expect(out.aliases).toEqual(raw.aliases);
    expect(out.fieldIndex).toEqual(raw.fieldIndex);
    expect(warnings).toEqual([]);
  });

  it('rejects a non-object top-level shape with a warning', () => {
    const warnings: string[] = [];
    const out = sanitizeManifest('[1,2]', (message) => warnings.push(message));
    expect(out).toEqual({});
    expect(warnings.length).toBe(1);
  });

  it('discards malformed array and object fields instead of crashing', () => {
    const raw = {
      entities: 'not-an-array',
      rules: [1, 2],
      aliases: 42,
      states: [{ entity: 'Order', states: ['AUDIT'] }],
    };
    const warnings: string[] = [];
    const out = sanitizeManifest(raw, (message) => warnings.push(message));
    expect(out.entities).toBeUndefined();
    expect(out.rules).toEqual([1, 2]);
    expect(out.aliases).toBeUndefined();
    expect(out.states).toEqual(raw.states);
    expect(warnings.filter((message) => message.includes('entities')).length).toBe(1);
    expect(warnings.filter((message) => message.includes('aliases')).length).toBe(1);
  });
});
