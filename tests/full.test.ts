import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discover } from '../src/core/discovery.js';

const FULL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/full');

describe('discover --deep with frontend + backend analyzers', () => {
  it('combines Vue, Java and MyBatis XML knowledge in one manifest', async () => {
    const manifest = await discover(FULL, {
      dryRun: true,
      analyzers: ['sql', 'api', 'ast', 'vue', 'java', 'xml', 'linkage'],
    });

    const names = manifest.entities.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['Order', 'Customer', 'OrderList']));

    const order = manifest.entities.find((e) => e.name === 'Order');
    expect(order?.attributes?.map((a) => a.name)).toEqual(expect.arrayContaining(['id', 'total', 'customer']));

    const jpaN1 = manifest.relations.find(
      (r) => r.source === 'Order' && r.target === 'Customer' && r.cardinality === 'N:1',
    );
    expect(jpaN1).toBeDefined();

    expect(
      manifest.rules.some((r) => r.entity === 'Order' && r.rule[0]?.includes('cannot modify an order under audit')),
    ).toBe(true);

    const callsApi = manifest.relations.find(
      (r) => r.relationship === 'calls_api' && r.source === 'OrderList' && r.target === 'Order',
    );
    expect(callsApi).toBeDefined();

    const apis = manifest.apis.map((a) => `${a.method} ${a.path}`);
    expect(apis).toEqual(expect.arrayContaining(['POST /api/orders', 'GET /api/orders/{id}']));
  });
});
