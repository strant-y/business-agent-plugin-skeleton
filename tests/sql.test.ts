import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/core/scanner.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { sqlAnalyzer } from '../src/core/analyzers/sql.js';

const DEEP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/deep');

describe('sqlAnalyzer', () => {
  it('extracts tables as entities, columns, and foreign keys as relations', async () => {
    const scan = await scanProject(DEEP, DEFAULT_CONFIG);
    const result = await sqlAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const entityNames = (result.entities ?? []).map((e) => e.name);
    expect(entityNames).toContain('Customer');
    expect(entityNames).toContain('Orders');

    const orders = (result.entities ?? []).find((e) => e.name === 'Orders');
    expect(orders?.attributes?.map((a) => a.name)).toEqual(expect.arrayContaining(['id', 'customer_id', 'status']));

    const auditLog = (result.entities ?? []).find((e) => e.name === 'AuditLog');
    expect(auditLog?.attributes?.map((a) => a.name)).toEqual(expect.arrayContaining(['id', 'event_type']));

    const relation = (result.relations ?? []).find((r) => r.source === 'Orders' && r.target === 'Customer');
    expect(relation).toBeDefined();
    expect(relation?.cardinality).toBe('N:1');
    expect(relation?.relationship).toBe('references');
    expect(relation?.confidence).toBe('medium');
    expect(relation?.evidence.some((f) => f.endsWith('schema.sql'))).toBe(true);
  });

  it('extracts SQL CHECK constraints as candidate rules', async () => {
    const scan = await scanProject(DEEP, DEFAULT_CONFIG);
    const result = await sqlAnalyzer.analyze(scan, { config: DEFAULT_CONFIG, entities: [], rules: [] });

    const rules = result.rules ?? [];
    expect(rules.some((rule) => rule.name.includes('CHECK'))).toBe(true);
    expect(rules.some((rule) => rule.rule[0]?.includes('只能取以下业务状态'))).toBe(true);
    expect(rules.some((rule) => rule.rule[0]?.includes('Orders.status') && rule.rule[0]?.includes('DRAFT'))).toBe(true);
    expect(
      rules.some((rule) => rule.rule[0]?.includes('AuditLog.event_type') && rule.rule[0]?.includes('ORDER_UPDATED')),
    ).toBe(true);
  });
});
