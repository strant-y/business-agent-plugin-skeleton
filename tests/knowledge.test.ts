import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeFileId, ruleMarkdown, writeRule, loadRules, buildIndex } from '../src/core/knowledge.js';
import type { BusinessRule, Relation } from '../src/core/types.js';

const RULE: BusinessRule = {
  id: 'rule.discovery.validation-state',
  name: 'State-dependent validation',
  entity: 'Product',
  rule: ['check status'],
  confidence: 'medium',
  evidence: ['src/Product.ts'],
  status: 'candidate',
};

describe('safeFileId', () => {
  it('normalizes dotted ids into filenames', () => {
    expect(safeFileId('rule.discovery.validation-state')).toBe('rule-discovery-validation-state');
  });
});

describe('ruleMarkdown', () => {
  it('contains core sections', () => {
    const md = ruleMarkdown(RULE);
    expect(md).toContain('# State-dependent validation');
    expect(md).toContain('## Entity');
    expect(md).toContain('## Rule');
    expect(md).toContain('## Impact');
    expect(md).toContain('## Evidence');
  });
});

describe('writeRule / loadRules', () => {
  it('writes json, markdown and impact files and loads them back', async () => {
    const agent = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-know-'));
    await writeRule(agent, RULE);

    expect(await fs.stat(path.join(agent, 'business/rules/rule-discovery-validation-state.json'))).toBeDefined();
    expect(await fs.stat(path.join(agent, 'business/rules/rule-discovery-validation-state.md'))).toBeDefined();
    expect(await fs.stat(path.join(agent, 'business/impact/rule-discovery-validation-state.md'))).toBeDefined();

    const rules = await loadRules(agent);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe(RULE.id);
  });

  it('buildIndex writes an index with rules and relationships', async () => {
    const agent = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-idx-'));
    await writeRule(agent, RULE);
    await buildIndex(agent, [{ name: 'Product' }]);
    const index = await fs.readFile(path.join(agent, 'business/INDEX.md'), 'utf8');
    expect(index).toContain('[Product](./entities/product.md)');
    expect(index).toContain('[State-dependent validation](./rules/rule-discovery-validation-state.md)');
  });
});

describe('writeRelation', () => {
  it('writes a relationship knowledge file', async () => {
    const agent = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-rel-'));
    const relation: Relation = {
      id: 'relation.product-order',
      source: 'Product',
      target: 'Order',
      relationship: 'calls',
      subtype: 'api_route_call',
      provenance: 'api_client_module',
      cardinality: '1:N',
      confidence: 'medium',
      evidence: [],
    };
    await import('../src/core/knowledge.js').then(async (k) => {
      await k.writeRelation(agent, relation);
    });
    const json = JSON.parse(
      await fs.readFile(path.join(agent, 'business/relationships/relation-product-order.json'), 'utf8'),
    );
    expect(json.source).toBe('Product');
    expect(json.relationship).toBe('calls');
    expect(json.subtype).toBe('api_route_call');
    expect(json.provenance).toBe('api_client_module');
  });
});
