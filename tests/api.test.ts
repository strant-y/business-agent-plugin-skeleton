import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/core/scanner.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { apiAnalyzer } from '../src/core/analyzers/api.js';
import type { Entity } from '../src/core/types.js';

const DEEP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/deep');

describe('apiAnalyzer', () => {
  it('extracts routes from express-style handlers', async () => {
    const scan = await scanProject(DEEP, DEFAULT_CONFIG);
    const entities: Entity[] = [
      { id: 'entity.order', name: 'Order', type: 'business_entity', description: '', confidence: 'low', evidence: [] },
    ];
    const result = await apiAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities, rules: [] });

    const apis = result.apis ?? [];
    expect(apis).toHaveLength(3);
    expect(apis.map((a) => `${a.method} ${a.path}`)).toEqual(
      expect.arrayContaining(['GET /api/products', 'POST /api/orders', 'PATCH /api/orders/:id']),
    );
    const orderApi = apis.find((a) => a.path === '/api/orders');
    expect(orderApi?.entity).toBe('Order');
    expect(orderApi?.evidence.some((f) => f.endsWith('routes.ts'))).toBe(true);
  });
});
