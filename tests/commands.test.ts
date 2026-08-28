import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contextCommand } from '../src/commands/context.js';
import { recordFeedback } from '../src/core/feedback.js';
import { loadKnowledgeState, saveKnowledgeRecord } from '../src/core/knowledge-state.js';
import { buildTaskContext, startTask } from '../src/core/task.js';
import type { KnowledgeRecord } from '../src/core/knowledge-state.js';

async function readContext(root: string): Promise<string> {
  return fs.readFile(path.join(root, '.agent', 'memory', 'active-context.md'), 'utf8');
}

function createKnowledgeRecord(overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    id: 'rule.checkout',
    type: 'rule',
    subject: 'Order',
    claim: 'Order must be approved before checkout',
    confidence: 'medium',
    confidenceScore: 0.6,
    status: 'confirmed',
    source: 'human-confirmed',
    evidence: [
      {
        id: 'e-rule',
        kind: 'source',
        capturedAt: new Date().toISOString(),
        file: 'src/order.ts',
        lineStart: 12,
        lineEnd: 12,
        strength: 'direct',
      },
    ],
    relatedTasks: [],
    version: 1,
    firstSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('command handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('writes context file including graph, conflicts, workflows and alias display', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-context-'));
    await fs.mkdir(path.join(root, '.agent', 'business'), { recursive: true });
    await fs.mkdir(path.join(root, '.agent', 'memory'), { recursive: true });
    await fs.mkdir(path.join(root, '.agent', 'knowledge', 'rules'), { recursive: true });
    await fs.mkdir(path.join(root, '.agent', 'knowledge', 'relations'), { recursive: true });
    await fs.mkdir(path.join(root, '.agent', 'business', 'impact-maps'), { recursive: true });
    await fs.writeFile(path.join(root, '.agent', 'business', 'INDEX.md'), '# Business Index\n');
    await fs.writeFile(
      path.join(root, '.agent', 'memory', 'discovery-manifest.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        projectRoot: root,
        filesScanned: 1,
        entities: [
          {
            id: 'entity.order',
            name: 'Order',
            type: 'business_entity',
            description: 'Order aggregate',
            confidence: 'high',
            evidence: ['src/order.ts'],
          },
        ],
        rules: [],
        relations: [
          {
            id: 'relation.order-page',
            source: 'module:src/views/orderlist.vue',
            target: 'Order',
            relationship: 'renders',
            cardinality: '1:N',
            confidence: 'medium',
            evidence: ['src/views/OrderList.vue'],
          },
        ],
        aliases: { Order: ['订单', 'OrderDTO'] },
        aliasIndex: { order: 'Order', '订单': 'Order', orderdto: 'Order' },
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
        conflicts: [
          {
            id: 'conflict.a-vs-b',
            ruleA: 'rule.a',
            ruleB: 'rule.b',
            entity: 'Order',
            description: 'Rules conflict on approval timing',
            confidence: 'medium',
            evidence: [],
            suggestions: ['Clarify approval source of truth'],
          },
        ],
        states: [
          {
            entity: 'Order',
            states: ['draft', 'approved'],
            transitions: [],
            mermaid: 'stateDiagram-v2\n  [*] --> draft\n  draft --> approved: approve',
          },
        ],
        workflows: [
          {
            id: 'workflow.checkout',
            name: 'Order checkout',
            description: 'Fulfill approved order',
            steps: ['approve', 'pay'],
            status: 'draft',
          },
        ],
        pages: [
          {
            id: 'page.order-list',
            route: '/orders',
            component: 'src/views/OrderList.vue',
            permissions: [],
            stores: ['Order'],
            apiCalls: ['GET /api/orders'],
            actions: ['action.submit-order'],
            evidence: [],
          },
        ],
        actions: [
          {
            id: 'action.submit-order',
            name: 'submitOrder',
            source: 'src/views/OrderList.vue',
            trigger: 'click',
            preconditions: ['Order approved'],
            stateReads: ['Order.status'],
            stateWrites: ['Order.submitted'],
            apiCalls: ['POST /api/orders/submit'],
            stores: ['Order'],
            successEffects: ['Refresh list'],
            failureEffects: ['Show error'],
            evidence: [],
          },
        ],
      }),
    );

    await contextCommand(root, 'Order');
    const content = await readContext(root);
    expect(content).toContain('# Active Business Context');
    expect(content).toContain('Order (high): Order aggregate [aliases: 订单, OrderDTO]');
    expect(content).toContain('## Relevant Relationships');
    expect(content).toContain('```mermaid');
    expect(content).toContain('module_src_views_orderlist_vue -->|renders/1:N| Order');
    expect(content).toContain('## Rule Conflicts');
    expect(content).toContain('Clarify approval source of truth');
    expect(content).toContain('## State Machines');
    expect(content).toContain('stateDiagram-v2');
    expect(content).toContain('## Frontend Pages');
    expect(content).toContain('src/views/OrderList.vue (/orders)');
    expect(content).toContain('## Workflows');
    expect(content).toContain('Order checkout: approve -> pay');
    expect(content).toContain('## User Actions');
    expect(content).toContain('submitOrder [click] on src/views/OrderList.vue: Order approved');
    expect(content).toContain('## Relevant API Routes');
    expect(content).toContain('GET /api/orders');
    expect(content).toContain('## Relevant Impact Maps');
  });

  it('resolves glossary aliases through retrieval fallback in context command', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-context-alias-'));
    await fs.mkdir(path.join(root, '.agent', 'business'), { recursive: true });
    await fs.mkdir(path.join(root, '.agent', 'memory'), { recursive: true });
    await fs.mkdir(path.join(root, '.agent', 'memory', 'indexes'), { recursive: true });
    await fs.mkdir(path.join(root, '.agent', 'knowledge', 'rules'), { recursive: true });
    await fs.mkdir(path.join(root, '.agent', 'knowledge', 'relations'), { recursive: true });
    await fs.mkdir(path.join(root, '.agent', 'business', 'impact-maps'), { recursive: true });
    await fs.writeFile(path.join(root, '.agent', 'business', 'INDEX.md'), '# Business Index\n');
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(root, '.agent', 'memory', 'discovery-manifest.json'),
      JSON.stringify({
        generatedAt: now,
        projectRoot: root,
        filesScanned: 1,
        entities: [
          {
            id: 'entity.order',
            name: 'Order',
            type: 'business_entity',
            description: '订单聚合',
            confidence: 'high',
            evidence: [],
            tags: [],
          },
        ],
        rules: [],
        relations: [],
        apis: [],
        conflicts: [],
        aliases: { Order: ['订单', 'OrderDTO'] },
        aliasIndex: { order: 'Order', '订单': 'Order', orderdto: 'Order' },
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(root, '.agent', 'memory', 'indexes', 'retrieval-index.json'),
      JSON.stringify([
        {
          id: 'entity.order',
          type: 'entity',
          title: 'Order',
          tokens: ['order', '订单'],
          aliases: ['订单', 'OrderDTO'],
          relatedIds: [],
          updatedAt: now,
          confidence: 0.9,
          text: '订单聚合',
          evidence: [],
        },
      ]),
      'utf8',
    );

    await contextCommand(root, '订单');
    const content = await readContext(root);
    expect(content).toContain('Order (high): 订单聚合 [aliases: 订单, OrderDTO]');
    expect(content).toContain('Subject: 订单');
  });

  it('records feedback and transitions knowledge state using the active task session', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-feedback-'));
    await fs.mkdir(path.join(root, '.agent', 'memory'), { recursive: true });
    const { session } = await startTask(root, '复核订单审批规则');
    const record = createKnowledgeRecord();
    await saveKnowledgeRecord(root, record);

    const feedback = await recordFeedback(
      root,
      {
        type: 'mark_stale',
        targetId: 'rule.checkout',
        reason: 'Checkout flow changed after backend refactor',
        correction: 'Re-run discovery and verify approval guard',
        evidence: [
          {
            id: 'e-feedback',
            kind: 'source',
            capturedAt: new Date().toISOString(),
            file: 'src/order.ts',
            lineStart: 12,
            lineEnd: 12,
            strength: 'direct',
          },
        ],
      },
      session.taskId,
      session.sessionId,
      'feedback-1',
    );

    expect(feedback.appliedAt).toBeTruthy();
    const updated = await loadKnowledgeState(root, 'rule.checkout');
    expect(updated?.status).toBe('stale');
    expect(updated?.feedbackNotes).toContain('Checkout flow changed after backend refactor');
    expect(updated?.feedbackNotes).toContain('Re-run discovery and verify approval guard');
    expect(updated?.relatedTasks).toContain(session.taskId);
    expect(updated?.confidenceScore).toBe(0.6);
  });

  it('builds task context from manifest matches and starts a task session', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-task-context-'));
    await fs.mkdir(path.join(root, '.agent', 'memory'), { recursive: true });
    await fs.mkdir(path.join(root, '.agent', 'memory', 'task-history'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.agent', 'memory', 'discovery-manifest.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        projectRoot: root,
        filesScanned: 2,
        entities: [
          {
            id: 'entity.order',
            name: 'Order',
            type: 'business_entity',
            description: '订单审批支付聚合',
            confidence: 'high',
            evidence: ['src/order.ts'],
          },
        ],
        rules: [
          {
            id: 'rule.checkout',
            name: 'Checkout requires approval',
            entity: 'Order',
            rule: ['审批成功后才允许支付'],
            confidence: 'medium',
            evidence: ['src/order.ts:12'],
            status: 'candidate',
          },
        ],
        relations: [
          {
            id: 'relation.order-payment',
            source: 'Order',
            target: 'Payment',
            relationship: 'calls',
            cardinality: '1:N',
            confidence: 'medium',
            evidence: ['src/order.ts:30'],
          },
        ],
        apis: [],
        conflicts: [],
        workflows: [
          {
            id: 'workflow.checkout',
            name: '订单审批支付流',
            description: '审批后进入支付',
            steps: ['审批', '支付'],
            status: 'draft',
          },
        ],
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(root, '.agent', 'memory', 'task-history', 'recent-order.json'),
      JSON.stringify({ intent: '订单审批支付', summary: '最近一次修正了审批支付条件' }),
      'utf8',
    );

    const context = await buildTaskContext(root, '订单审批支付');
    expect(context.entities.map((item) => item.name)).toContain('Order');
    expect(context.rules.map((item) => item.id)).toContain('rule.checkout');
    expect(context.workflows.map((item) => item.name)).toContain('订单审批支付流');
    expect(context.questions).toContain('Verify candidate rule: Checkout requires approval');
    expect(context.history).toContain('recent-order.json');

    const { session } = await startTask(root, '订单审批支付');
    expect(session.status).toBe('active');
    expect(session.phase).toBe('before_task');
    expect(session.context?.entities.map((item) => item.name)).toContain('Order');
  });
});
