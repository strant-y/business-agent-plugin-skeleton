import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImpactReport, impactMarkdown } from '../src/core/impact.js';

const ORDER_DIFF = `diff --git a/src/views/OrderList.vue b/src/views/OrderList.vue
index 1111111..2222222 100644
--- a/src/views/OrderList.vue
+++ b/src/views/OrderList.vue
@@ -10,3 +10,5 @@
- const canEdit = order.status === 'AUDIT';
+ const canEdit = order.status === 'AUDITING';
+ const permission = hasPermission('order.edit');
+ const rules = { required: true };
`;

const API_DIFF = `diff --git a/src/api/orderApi.ts b/src/api/orderApi.ts
index 3333333..4444444 100644
--- a/src/api/orderApi.ts
+++ b/src/api/orderApi.ts
@@ -1,5 +1,5 @@
-export async function saveOrder(params: { id: number }): Promise<Order> {
-  return request('POST', '/api/orders', { params: { id: 1 } });
+export async function saveOrder(params: { id: string }): Promise<OrderDetail> {
+  return request('PATCH', '/api/order-details', { params: { orderId: '1' } });
 }
`;

const DB_DIFF = `diff --git a/db/migrations/001_orders.sql b/db/migrations/001_orders.sql
index 5555555..6666666 100644
--- a/db/migrations/001_orders.sql
+++ b/db/migrations/001_orders.sql
@@ -1,4 +1,4 @@
 CREATE TABLE orders (
-  total_amount DECIMAL(10,2) NOT NULL,
+  total_amount BIGINT NOT NULL,
 );
`;

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
      tests: ['tests/impact.test.ts', 'tests/frontend.test.ts', 'tests/stores.test.ts'],
      pages: [
        {
          id: 'page.orderlist',
          component: 'OrderList',
          permissions: ['order.view'],
          stores: ['OrderStore'],
          apiCalls: ['/api/orders'],
          actions: ['action.orderlist-submit-0'],
          evidence: ['src/views/OrderList.vue'],
        },
      ],
      actions: [
        {
          id: 'action.orderlist-submit-0',
          name: 'submitOrder',
          source: 'OrderList',
          trigger: 'click',
          preconditions: ['order.status !== AUDIT'],
          stateReads: ['AUDIT'],
          stateWrites: ['AUDITING'],
          apiCalls: ['/api/orders'],
          successEffects: ['State changes to AUDITING.'],
          failureEffects: [],
          evidence: ['src/views/OrderList.vue'],
        },
      ],
      workflows: [
        {
          id: 'workflow.orderlist',
          name: 'Order frontend flow',
          description: 'OrderList links actions, stores and APIs.',
          steps: ['Action: submitOrder', 'State: AUDITING', 'API: /api/orders'],
          status: 'draft',
        },
      ],
      rules: [
        {
          id: 'rule.frontend.orderlist',
          name: 'Frontend interaction and validation constraints',
          entity: 'OrderList',
          rule: ['Permission condition: order.edit.', 'Form validation constraints are enforced.'],
          confidence: 'medium',
          evidence: ['src/views/OrderList.vue'],
          status: 'candidate',
        },
      ],
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
    const report = await buildImpactReport(dir, ['src/views/OrderList.vue'], ORDER_DIFF);

    const chain = report.chain.map((step) => `${step.file}:${step.node}@${step.depth}`);
    expect(chain).toEqual(
      expect.arrayContaining(['src/views/OrderList.vue:OrderList@0', 'src/views/OrderList.vue:OrderStore@1']),
    );
    const orderStep = report.chain.find((step) => step.node === 'Order');
    expect(orderStep?.depth).toBe(2);
    expect(orderStep?.relationship).toBe('uses_entity');

    expect(report.entities).toEqual(expect.arrayContaining(['Order', 'OrderStore']));
    expect(report.entities).not.toContain('Customer');

    const ruleIds = report.rules.map((rule) => rule.id);
    expect(ruleIds).toEqual(expect.arrayContaining(['rule.order-locked', 'rule.orderlist-direct']));
    expect(ruleIds).not.toContain('rule.customer-consent');

    expect(report.apis.map((api) => api.path)).toEqual(expect.arrayContaining(['/api/orders']));
    expect(report.workflows.map((workflow) => workflow.name)).toContain('Order frontend flow');
    expect(report.tests.some((test) => test.startsWith('Review tests related to:'))).toBe(true);
    expect(report.diffFindings.map((finding) => finding.kind)).toEqual(
      expect.arrayContaining(['state_removed', 'state_transition_changed', 'permission_changed', 'validation_changed']),
    );
    const permissionMappings = report.diffImpact.filter((mapping) => mapping.finding.kind === 'permission_changed');
    expect(permissionMappings.some((mapping) => mapping.pages.includes('OrderList'))).toBe(true);
    expect(permissionMappings.some((mapping) => mapping.rules.includes('rule.frontend.orderlist'))).toBe(true);
    expect(permissionMappings.some((mapping) => mapping.workflows.includes('Order frontend flow'))).toBe(true);
    expect(report.risks.some((risk) => risk.includes('状态变化'))).toBe(true);
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

  it('renders workflow and suggested tests in the markdown report', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/views/OrderList.vue'], ORDER_DIFF);
    const markdown = impactMarkdown(report);
    expect(markdown).toContain('## Diff Findings');
    expect(markdown).toContain('## Diff To Impact Mapping');
    expect(markdown).toContain('## Affected Chain');
    expect(markdown).toContain('src/views/OrderList.vue = OrderList (changed module)');
    expect(markdown).toContain('→ OrderStore (uses_store, depth 1)');
    expect(markdown).toContain('## Affected Workflows');
    expect(markdown).toContain('## Suggested Tests');
    expect(markdown).toContain('Review tests related to:');
  });

  it('falls back to review hints when no concrete test file matches', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/services/customerService.ts']);
    expect(report.tests.some((test) => test.startsWith('Review tests related to:'))).toBe(true);
  });

  it('detects database field changes and maps the impact chain', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['db/migrations/001_orders.sql'], DB_DIFF);
    expect(report.diffFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'database_field_changed', subject: 'orders.total_amount' }),
      ]),
    );
    const dbMappings = report.diffImpact.filter((mapping) => mapping.finding.kind === 'database_field_changed');
    expect(dbMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entities: expect.arrayContaining(['Order']),
          apis: expect.arrayContaining(['GET /api/orders']),
        }),
      ]),
    );
    expect(report.risks.some((risk) => risk.includes('数据库字段变化'))).toBe(true);
  });

  it('detects pairwise field, api and response changes from diff', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/api/orderApi.ts'], API_DIFF);
    expect(
      report.diffFindings.some((finding) => finding.kind === 'field_type_changed' && finding.subject === 'id'),
    ).toBe(true);
    expect(
      report.diffFindings.some(
        (finding) => finding.kind === 'api_method_changed' && finding.detail.includes('POST to PATCH'),
      ),
    ).toBe(true);
    expect(report.diffFindings.some((finding) => finding.kind === 'response_type_changed')).toBe(true);
    expect(report.risks.some((risk) => risk.includes('字段类型变化'))).toBe(true);
    expect(report.risks.some((risk) => risk.includes('API 变更'))).toBe(true);
  });
});
