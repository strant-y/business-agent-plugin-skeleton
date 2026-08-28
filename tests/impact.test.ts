import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildModuleDescriptor, moduleNodeId } from '../src/core/module-id.js';
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
      modules: [
        buildModuleDescriptor('src/views/OrderList.vue'),
        buildModuleDescriptor('src/stores/orderStore.ts'),
        buildModuleDescriptor('src/api/orderApi.ts'),
        buildModuleDescriptor('src/views/OrderDirectory.vue'),
      ],
      aliases: {
        OrderStore: [moduleNodeId('src/stores/orderStore.ts')],
        Order: ['orders'],
      },
      fieldIndex: {
        'order.status': {
          entity: 'Order',
          field: 'status',
          apis: ['GET /api/orders'],
          stores: ['OrderStore'],
          storeActions: ['submitOrder'],
          pages: ['OrderList'],
          tests: ['tests/frontend.test.ts'],
        },
        'order.total_amount': {
          entity: 'Order',
          field: 'total_amount',
          apis: ['GET /api/orders'],
          stores: ['OrderStore'],
          pages: ['OrderList'],
          tests: ['tests/stores.test.ts'],
        },
      },
      rules: [
        {
          id: 'rule.covered',
          name: 'Covered order rule',
          entity: 'Order',
          rule: ['Covered by an order flow test.'],
          confidence: 'medium',
          evidence: ['src/views/OrderList.vue'],
          coveringTests: ['tests/order-flow.test.ts'],
          status: 'confirmed',
        },
        {
          id: 'rule.uncovered',
          name: 'Uncovered order rule',
          entity: 'Order',
          rule: ['Needs test protection.'],
          confidence: 'low',
          evidence: ['src/views/OrderList.vue'],
          status: 'confirmed',
        },
      ],
      relations: [
        {
          id: 'relation.orderlist-orderstore-uses-store',
          source: moduleNodeId('src/views/OrderList.vue'),
          target: 'OrderStore',
          relationship: 'uses_store',
          cardinality: 'unknown',
          confidence: 'medium',
          evidence: ['src/views/OrderList.vue'],
        },
        {
          id: 'relation.submit-order-store',
          source: 'submitOrder',
          target: 'OrderStore',
          relationship: 'calls',
          subtype: 'action_store_update',
          cardinality: 'unknown',
          confidence: 'high',
          evidence: ['src/views/OrderList.vue'],
        },
        {
          id: 'relation.submit-order-api',
          source: 'submitOrder',
          target: '/api/orders',
          relationship: 'calls',
          subtype: 'action_api_call',
          cardinality: 'unknown',
          confidence: 'high',
          evidence: ['src/views/OrderList.vue'],
        },
        {
          id: 'relation.orderstore-order-uses-entity',
          source: moduleNodeId('src/stores/orderStore.ts'),
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
      tests: ['tests/impact.test.ts', 'tests/frontend.test.ts', 'tests/stores.test.ts', 'tests/order-flow.test.ts'],
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
          stores: ['OrderStore'],
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
      evidence: [
        {
          id: 'evidence-orderlist-direct',
          kind: 'source',
          file: 'src/views/OrderList.vue',
          lineStart: 1,
          snippet: "order.status === 'AUDIT'",
          capturedAt: '2026-08-20T00:00:00.000Z',
        },
      ],
      status: 'confirmed',
    }),
    'utf8',
  );
  await fs.mkdir(path.join(dir, 'src/views'), { recursive: true });
  await fs.mkdir(path.join(dir, 'src/services'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'src/views/OrderList.vue'),
    "const canEdit = order.status === 'AUDIT';\nconst permission = hasPermission('order.view');\n",
    'utf8',
  );
  await fs.writeFile(path.join(dir, 'src/services/orderService.ts'), "throw new Error('locked');\n", 'utf8');
  await fs.writeFile(path.join(dir, 'src/services/customerService.ts'), 'return hasConsent(customer);\n', 'utf8');
  return dir;
}

describe('buildImpactReport (code-level chain)', () => {
  it('traces changed files through the relation graph to affected entities, rules and APIs', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/views/OrderList.vue'], ORDER_DIFF);

    const chain = report.chain.map((step) => `${step.file}:${step.node}@${step.depth}`);
    expect(chain).toEqual(
      expect.arrayContaining([
        `src/views/OrderList.vue:${moduleNodeId('src/views/OrderList.vue')}@0`,
        'src/views/OrderList.vue:OrderStore@1',
        'src/views/OrderList.vue:Order@2',
      ]),
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
    expect(report.tests).toEqual(expect.arrayContaining(['tests/order-flow.test.ts']));
    expect(report.diffFindings.map((finding) => finding.kind)).toEqual(
      expect.arrayContaining(['state_removed', 'state_transition_changed', 'permission_changed', 'validation_changed']),
    );
    const permissionMappings = report.diffImpact.filter((mapping) => mapping.finding.kind === 'permission_changed');
    expect(permissionMappings.some((mapping) => mapping.pages.includes('OrderList'))).toBe(true);
    expect(permissionMappings.some((mapping) => mapping.rules.length > 0)).toBe(true);
    expect(permissionMappings.some((mapping) => mapping.workflows.includes('Order frontend flow'))).toBe(true);
    const markdown = impactMarkdown(report);
    expect(markdown).toContain('actions=submitOrder');
    expect(markdown).toContain('ruleCoveringTests=tests/order-flow.test.ts; tests=tests/order-flow.test.ts');
    expect(markdown).toContain('### Field Tests\n- None identified');
    expect(markdown).not.toContain(
      'fieldPath=Order.status -> GET /api/orders -> OrderStore -> submitOrder -> OrderList -> Review tests related to:',
    );
    expect(report.risks.some((risk) => risk.includes('状态变化'))).toBe(true);
  });

  it('does not build a chain from legacy-free modules when only the old file path changes', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/stores/orderStore.ts']);

    expect(report.chain).toEqual([]);
    expect(report.entities).toEqual([]);
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
    expect(markdown).toContain(`src/views/OrderList.vue = ${moduleNodeId('src/views/OrderList.vue')} (changed module)`);
    expect(markdown).toContain('→ OrderStore (uses_store, depth 1)');
    expect(markdown).toContain('## Affected Rules');
    expect(markdown).toContain('- rule.covered: Covered order rule');
    expect(markdown).toContain('- rule.orderlist-direct: Order list hides draft rows');
    expect(markdown).toContain('## Affected Workflows');
    expect(markdown).toContain('## Impact Graph');
    expect(markdown).toContain('```mermaid');
    expect(markdown).toContain('graph LR');
    expect(markdown).toContain('style module_src_views_orderlist_vue fill:#f96');
    expect(markdown).toContain('module_src_views_orderlist_vue -->|uses_store/unknown| OrderStore');
    expect(markdown).toContain('## Suggested Tests');
    expect(markdown).toContain('### Rule Covering Tests');
    expect(markdown).toContain('tests/order-flow.test.ts');
    expect(markdown).toContain('### Field Tests');
    expect(markdown).toContain('### Field Tests\n- None identified');
    expect(markdown).toContain('### Review Hints');
    expect(markdown).toContain('### Review Hints\n- None identified');
  });

  it('falls back to review hints when no concrete test file matches', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/services/customerService.ts']);
    expect(report.tests.some((test) => test.startsWith('Review tests related to:'))).toBe(true);
  });

  it('prioritizes covering tests from affected rules in suggested tests', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/views/OrderList.vue'], ORDER_DIFF);

    expect(report.tests[0]).toBe('tests/order-flow.test.ts');
    expect(report.tests).toContain('tests/order-flow.test.ts');
    const mapping = report.diffImpact.find((item) => item.finding.kind === 'state_removed');
    expect(mapping?.ruleCoveringTests).toEqual(['tests/order-flow.test.ts']);
    expect(mapping?.fieldTests).toEqual([]);
    expect(mapping?.reviewHints).toEqual([]);
  });

  it('reports likely-modified violations when confirmed rule evidence lines change', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/views/OrderList.vue'], ORDER_DIFF);

    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'rule.orderlist-direct',
          severity: 'likely-modified',
          evidence: 'src/views/OrderList.vue:1',
        }),
      ]),
    );
    expect(report.risks[0]).toContain('rule.orderlist-direct');
    const markdown = impactMarkdown(report);
    expect(markdown).toContain('## Rule Violations');
    expect(markdown).toContain('## Test Coverage');
    expect(markdown).toContain('### Protected Rules');
    expect(markdown).toContain('rule.covered: Covered order rule -> tests/order-flow.test.ts');
    expect(markdown).toContain('### Missing Coverage');
    expect(markdown).toContain('rule.uncovered: Uncovered order rule (建议补测试)');
  });

  it('renders protected and missing rule coverage groups in the impact report', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/views/OrderList.vue'], ORDER_DIFF);
    const markdown = impactMarkdown(report);

    expect(markdown).toContain('## Test Coverage');
    expect(markdown).toContain('### Protected Rules');
    expect(markdown).toContain('rule.covered: Covered order rule -> tests/order-flow.test.ts');
    expect(markdown).toContain('### Missing Coverage');
    expect(markdown).toContain('rule.uncovered: Uncovered order rule (建议补测试)');
  });

  it('reports confirmed-missing violations when confirmed rule evidence files are deleted', async () => {
    const dir = await setupProject();
    await fs.rm(path.join(dir, 'src/services/orderService.ts'));

    const report = await buildImpactReport(dir, ['src/services/orderService.ts']);
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'rule.order-locked',
          severity: 'confirmed-missing',
          evidence: 'src/services/orderService.ts',
        }),
      ]),
    );
  });

  it('does not report violations for unrelated changes', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(dir, ['src/services/customerService.ts']);
    expect(report.violations).toEqual([]);
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
    expect(dbMappings).toHaveLength(2);
    expect(dbMappings.some((mapping) => mapping.entities.includes('Order'))).toBe(true);
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
    expect(
      report.diffFindings.some(
        (finding) => finding.kind === 'api_method_changed' && finding.detail.includes('POST to PATCH'),
      ),
    ).toBe(true);
    expect(report.diffFindings.some((finding) => finding.kind === 'response_type_changed')).toBe(true);
    expect(report.risks.some((risk) => risk.includes('字段类型变化'))).toBe(true);
    expect(report.risks.some((risk) => risk.includes('API 变更'))).toBe(true);
  });

  it('uses configured impact depth for longer dependency chains', async () => {
    const dir = await setupProject();
    await fs.writeFile(
      path.join(dir, '.agent/business-agent.json'),
      JSON.stringify({ impact: { maxDepth: 1 } }),
      'utf8',
    );
    const report = await buildImpactReport(dir, ['src/views/OrderList.vue']);
    expect(report.chain.some((step) => step.node === 'Order')).toBe(false);
    expect(report.chain.some((step) => step.node === 'OrderStore')).toBe(true);
  });

  it('keeps same-name modules separated by module id', async () => {
    const dir = await setupProject();
    const agentRoot = path.join(dir, '.agent');
    const manifest = JSON.parse(await fs.readFile(path.join(agentRoot, 'memory/discovery-manifest.json'), 'utf8'));
    manifest.relations.push({
      id: 'relation.admin-orderlist-orderstore-uses-store',
      source: moduleNodeId('src/admin/OrderList.vue'),
      target: 'Customer',
      relationship: 'uses_entity',
      cardinality: 'unknown',
      confidence: 'medium',
      evidence: ['src/admin/OrderList.vue'],
    });
    manifest.modules.push({
      id: moduleNodeId('src/admin/OrderList.vue'),
      name: 'OrderList',
      file: 'src/admin/OrderList.vue',
    });
    await fs.writeFile(path.join(agentRoot, 'memory/discovery-manifest.json'), JSON.stringify(manifest), 'utf8');

    const report = await buildImpactReport(dir, ['src/views/OrderList.vue']);
    expect(report.entities).toContain('Order');
    expect(report.entities).not.toContain('Customer');
    expect(report.chain.some((step) => step.node === moduleNodeId('src/admin/OrderList.vue'))).toBe(false);
  });

  it('keeps impact chain stable after file rename when manifest module id matches changed file', async () => {
    const dir = await setupProject();
    const agentRoot = path.join(dir, '.agent');
    const manifestPath = path.join(agentRoot, 'memory/discovery-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.modules[0] = {
      id: moduleNodeId('src/views/OrderDirectory.vue'),
      name: 'OrderList',
      file: 'src/views/OrderDirectory.vue',
    };
    manifest.relations[0].source = moduleNodeId('src/views/OrderDirectory.vue');
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const report = await buildImpactReport(dir, ['src/views/OrderDirectory.vue']);
    expect(report.chain.map((step) => step.node)).toEqual(
      expect.arrayContaining([moduleNodeId('src/views/OrderDirectory.vue'), 'OrderStore', 'Order']),
    );
    expect(report.entities).toContain('Order');
  });

  it('does not fall back to legacy module names when manifest has modules', async () => {
    const dir = await setupProject();
    const agentRoot = path.join(dir, '.agent');
    const manifestPath = path.join(agentRoot, 'memory/discovery-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.modules = [buildModuleDescriptor('src/admin/OrderList.vue')];
    manifest.relations[0].source = 'OrderList';
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const report = await buildImpactReport(dir, ['src/views/OrderList.vue']);
    expect(report.chain).toEqual([]);
    expect(report.entities).toContain('Order');
  });

  it('does not resolve ambiguous bare field names to the wrong entity', async () => {
    const dir = await setupProject();
    const report = await buildImpactReport(
      dir,
      ['src/views/OrderList.vue'],
      `diff --git a/src/views/OrderList.vue b/src/views/OrderList.vue\nindex 1111111..2222222 100644\n--- a/src/views/OrderList.vue\n+++ b/src/views/OrderList.vue\n@@ -1,1 +1,1 @@\n- status: string;\n+ status: number;\n`,
    );
    const fieldTypeMapping = report.diffImpact.find((mapping) => mapping.finding.kind === 'field_type_changed');
    expect(fieldTypeMapping?.fieldTests).toEqual(['tests/frontend.test.ts']);
    expect(fieldTypeMapping?.fieldPath?.[0]).toBe('Order.status');
    expect(fieldTypeMapping?.fieldPath).toEqual(
      expect.arrayContaining(['GET /api/orders', 'OrderStore', 'submitOrder', 'OrderList']),
    );
    expect(fieldTypeMapping?.entities).toContain('Order');
    expect(fieldTypeMapping?.entities).not.toContain('Customer');
  });
});
