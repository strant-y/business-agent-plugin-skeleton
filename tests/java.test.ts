import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/core/scanner.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { javaAnalyzer } from '../src/core/analyzers/java.js';

const FULL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/full');

describe('javaAnalyzer', () => {
  it('extracts JPA entities with @Table mapping and @Column attributes', async () => {
    const scan = await scanProject(FULL, DEFAULT_CONFIG);
    const result = await javaAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const order = (result.entities ?? []).find((e) => e.name === 'Order');
    expect(order).toBeDefined();
    expect(order?.description).toContain('table orders');
    expect(order?.attributes?.map((a) => a.name)).toEqual(expect.arrayContaining(['id', 'total', 'customer', 'items']));
    expect(order?.attributes?.find((a) => a.name === 'total')?.required).toBe(true);
    expect(order?.attributes?.find((a) => a.name === 'id')?.description).toContain('Column id');
  });

  it('maps @ManyToOne / @OneToMany to relations with cardinality', async () => {
    const scan = await scanProject(FULL, DEFAULT_CONFIG);
    const result = await javaAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const n1 = (result.relations ?? []).find((r) => r.source === 'Order' && r.target === 'Customer');
    expect(n1?.cardinality).toBe('N:1');
    const oneN = (result.relations ?? []).find((r) => r.source === 'Order' && r.target === 'OrderItem');
    expect(oneN?.cardinality).toBe('1:N');
    expect((result.relations ?? []).some((r) => r.source === 'Customer' && r.target === 'Order')).toBe(true);
  });

  it('extracts service-level rules tied to the related entity', async () => {
    const scan = await scanProject(FULL, DEFAULT_CONFIG);
    const result = await javaAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const throwRule = (result.rules ?? []).find((r) => r.rule[0]?.includes('cannot modify an order under audit'));
    expect(throwRule).toBeDefined();
    expect(throwRule?.entity).toBe('Order');
    expect(throwRule?.confidence).toBe('low');
    expect((result.rules ?? []).some((r) => r.name.includes('State-dependent'))).toBe(true);
  });

  it('extracts validation annotations and authorization guards as candidate rules', async () => {
    const scan = await scanProject(FULL, DEFAULT_CONFIG);
    const result = await javaAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const rules = result.rules ?? [];
    expect(rules.some((rule) => rule.rule[0]?.includes('Field constraint on Order.total'))).toBe(true);
    expect(rules.some((rule) => rule.rule[0]?.includes('Field constraint on Order.status'))).toBe(true);
    expect(rules.some((rule) => rule.rule[0]?.includes('nested value must be valid'))).toBe(true);
    const authRule = rules.find((rule) => rule.name.includes('PreAuthorize'));
    expect(authRule?.preconditions).toContain("hasRole('ORDER_VIEWER')");
    const filterRule = rules.find((rule) => rule.name.includes('PreFilter'));
    expect(filterRule?.preconditions).toContain("filterObject.status == 'DRAFT'");
    expect(authRule?.confidence).toBe('low');
    expect(filterRule?.confidence).toBe('low');
    expect(authRule?.status).toBe('candidate');
    expect(filterRule?.status).toBe('candidate');
  });

  it('extracts combined @RestController routes with class prefix', async () => {
    const scan = await scanProject(FULL, DEFAULT_CONFIG);
    const result = await javaAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const apis = result.apis ?? [];
    expect(apis.map((a) => `${a.method} ${a.path}`)).toEqual(
      expect.arrayContaining(['GET /api/orders/{id}', 'POST /api/orders']),
    );
    expect(apis.every((a) => a.confidence === 'low')).toBe(true);
  });
});
