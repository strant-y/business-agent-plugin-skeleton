import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/core/scanner.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { xmlAnalyzer } from '../src/core/analyzers/xml.js';

const FULL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/full');

describe('xmlAnalyzer', () => {
  it('extracts resultMap types as entities with fields', async () => {
    const scan = await scanProject(FULL, DEFAULT_CONFIG);
    const result = await xmlAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const order = (result.entities ?? []).find((e) => e.name === 'Order');
    expect(order).toBeDefined();
    expect(order?.attributes?.map((a) => a.name)).toEqual(expect.arrayContaining(['id', 'total']));
    expect(order?.attributes?.find((a) => a.name === 'id')?.description).toContain('Column id');
  });

  it('maps <association> to N:1 relations', async () => {
    const scan = await scanProject(FULL, DEFAULT_CONFIG);
    const result = await xmlAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const rel = (result.relations ?? []).find(
      (r) => r.source === 'Order' && r.target === 'Customer' && r.cardinality === 'N:1',
    );
    expect(rel).toBeDefined();
    expect(rel?.relationship).toBe('references');
  });

  it('extracts relations from SQL inside <select> via the shared parser', async () => {
    const scan = await scanProject(FULL, DEFAULT_CONFIG);
    const result = await xmlAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    expect((result.entities ?? []).map((e) => e.name)).toEqual(expect.arrayContaining(['Orders', 'Customer']));
    const join = (result.relations ?? []).find((r) => r.source === 'Orders' && r.target === 'Customer');
    expect(join).toBeDefined();
    expect(join?.evidence.some((f) => f.endsWith('OrderMapper.xml'))).toBe(true);
  });
});
