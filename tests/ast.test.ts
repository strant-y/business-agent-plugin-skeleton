import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/core/scanner.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { astAnalyzer } from '../src/core/analyzers/ast.js';

const DEEP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/deep');

describe('astAnalyzer', () => {
  it('extracts entity attributes from TS interfaces and classes', async () => {
    const scan = await scanProject(DEEP, DEFAULT_CONFIG);
    const result = await astAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [], relations: [] });

    const customer = (result.entities ?? []).find((e) => e.name === 'Customer');
    expect(customer).toBeDefined();
    expect(customer?.confidence).toBe('high');
    expect(customer?.attributes?.map((a) => a.name)).toEqual(
      expect.arrayContaining(['id', 'name', 'status', 'orders']),
    );
    expect(customer?.attributes?.find((a) => a.name === 'status')?.type).toContain('DRAFT');

    const order = (result.entities ?? []).find((e) => e.name === 'Order');
    expect(order?.attributes?.map((a) => a.name)).toEqual(expect.arrayContaining(['id', 'customer', 'total']));
  });

  it('extracts typed references as relations', async () => {
    const scan = await scanProject(DEEP, DEFAULT_CONFIG);
    const result = await astAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [], relations: [] });

    const rel = (result.relations ?? []).find((r) => r.source === 'Customer' && r.target === 'Order');
    expect(rel).toBeDefined();
    expect(rel?.relationship).toBe('references');
  });

  it('does not treat string-literal enum values as type references', async () => {
    const scan = await scanProject(DEEP, DEFAULT_CONFIG);
    const result = await astAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [], relations: [] });

    const targets = (result.relations ?? []).map((r) => r.target);
    expect(targets).not.toContain('DRAFT');
    expect(targets).not.toContain('APPROVED');
  });
});
