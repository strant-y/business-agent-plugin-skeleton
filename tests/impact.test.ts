import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImpactReport, impactMarkdown } from '../src/core/impact.js';

async function setupProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-impact-'));
  const agentRoot = path.join(dir, '.agent');
  await fs.mkdir(path.join(agentRoot, 'memory'), { recursive: true });
  await fs.mkdir(path.join(agentRoot, 'business/rules'), { recursive: true });
  await fs.mkdir(path.join(agentRoot, 'business/relationships'), { recursive: true });

  await fs.writeFile(
    path.join(agentRoot, 'memory/discovery-manifest.json'),
    JSON.stringify({
      entities: [
        { name: 'Order', description: 'A purchase', confidence: 'medium', evidence: [] },
        { name: 'OrderStore', description: 'Order state', confidence: 'medium', evidence: [] },
        { name: 'Customer', description: 'A buyer', confidence: 'low', evidence: [] },
      ],
      rules: [],
      relations: [
        {
          id: 'relation.orderlist-orderstore-uses-store',
          source: 'OrderList',
          target: 'OrderStore',
          relationship: 'uses_store',
          cardinality: 'unknown',
          confidence: 'medium',
          evidence: ['src/views/OrderList.vue'],
        },
        {
          id: 'relation.orderstore-order-uses-entity',
          source: 'OrderStore',
          target: 'Order',
          relationship: 'uses_entity',
          cardinality: 'unknown',
          confidence: 'medium',
          evidence: ['src/stores/orderStore.ts'],
        },
      ],
      apis: [
        {
          id: 'api.get-orders',
          method: 'GET',
          path: '/api/orders',
          entity: 'Order',
          kind: 'backend',
          confidence: 'low',
          evidence: [],
        },
      ],
      conflicts: [],
    }),
    'utf8',
  );

  await fs.writeFile(
    path.join(agentRoot, 'business/rules/rule.order-locked.json'),
    JSON.stringify({
      id: 'rule.order-locked',
      name: 'Audited orders are locked',
      entity: 'Order',
      rule: ['orders are locked under audit'],
      confidence: 'low',
      evidence: ['src/services/orderService.ts'],
      status: 'confirmed',
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(agentRoot, 'business/rules/rule.customer-consent.json'),
    JSON.stringify({
      id: 'rule.customer-consent',
      name: 'Customers need consent',
      entity: 'Customer',
      rule: ['customers need consent'],
      confidence: 'low',
      evidence: ['src/services/customerService.ts'],
      status: 'confirmed',
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(agentRoot, 'business/rules/rule.orderlist-direct.json'),
    JSON.stringify({
      id: 'rule.orderlist-direct',
      name: 'Order list hides draft rows',
      entity: 'Order',
      rule: ['draft rows are hidden'],
      confidence: 'low',
      evidence: ['src/views/OrderList.vue'],
      status: 'confirmed',
    }),
    'utf8',
  );
  return dir;
}

describe('buildImpactReport (code-level chain)', () => {
  it('traces changed files through the relation graph to affected entities, rules and APIs', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/views/OrderList.vue']);

    const chain = report.chain.map((step) => `${step.file}:${step.node}@${step.depth}`);
    expect(chain).toEqual(
      expect.arrayContaining(['src/views/OrderList.vue:OrderList@0', 'src/views/OrderList.vue:OrderStore@1']),
    );
    const orderStep = report.chain.find((step) => step.node === 'Order');
    expect(orderStep?.depth).toBe(2);
    expect(orderStep?.relationship).toBe('uses_entity');

    expect(report.entities).toEqual(expect.arrayContaining(['Order', 'OrderStore']));
    expect(report.entities).not.toContain('Customer');

    // Reached via the chain (entity match) and via direct evidence.
    const ruleIds = report.rules.map((rule) => rule.id);
    expect(ruleIds).toEqual(expect.arrayContaining(['rule.order-locked', 'rule.orderlist-direct']));
    expect(ruleIds).not.toContain('rule.customer-consent');

    expect(report.apis.map((api) => api.path)).toEqual(expect.arrayContaining(['/api/orders']));
  });

  it('reports inbound dependents of a changed module', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/stores/orderStore.ts']);

    const inbound = report.chain.find((step) => step.node === 'OrderList' && step.direction === 'in');
    expect(inbound).toBeDefined();
    expect(inbound?.relationship).toBe('uses_store');
    expect(report.entities).toEqual(expect.arrayContaining(['Order', 'OrderStore']));
  });

  it('falls back to file-name evidence when no graph node matches', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/services/orderService.ts']);

    expect(report.entities).toEqual(expect.arrayContaining(['Order']));
    expect(report.rules.map((rule) => rule.id)).toContain('rule.order-locked');
    expect(report.chain).toEqual([]);
  });

  it('renders the chain in the markdown report', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/views/OrderList.vue']);
    const markdown = impactMarkdown(report);
    expect(markdown).toContain('## Affected Chain');
    expect(markdown).toContain('src/views/OrderList.vue = OrderList (changed module)');
    expect(markdown).toContain('→ OrderStore (uses_store, depth 1)');
  });
});
