import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rebuildRetrievalIndex, retrieveTaskContext } from '../src/core/retrieval.js';
import type { RetrievalDocument } from '../src/core/retrieval.js';
import { writeJson } from '../src/utils/fs.js';

async function writeIndex(root: string, documents: RetrievalDocument[]): Promise<void> {
  await fs.mkdir(path.join(root, '.agent/memory/indexes'), { recursive: true });
  await writeJson(path.join(root, '.agent/memory/indexes/retrieval-index.json'), documents);
}

describe('retrieveTaskContext', () => {
  it('ranks task experience alongside entity evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-retrieval-'));
    const now = new Date().toISOString();
    await writeIndex(root, [
      {
        id: 'task-doc',
        type: 'task',
        title: '复用历史结算任务经验',
        tokens: ['订单', '结算', '修复'],
        aliases: ['Order'],
        relatedIds: ['rule.checkout'],
        updatedAt: now,
        text: '历史任务总结了订单结算修复经验',
      },
      {
        id: 'entity-doc',
        type: 'entity',
        title: 'Order',
        tokens: ['order', '订单', '结算'],
        aliases: ['订单'],
        relatedIds: [],
        updatedAt: now,
        confidence: 0.9,
        evidence: [
          {
            id: 'e1',
            kind: 'source',
            capturedAt: now,
            file: 'src/order.ts',
            lineStart: 10,
            lineEnd: 20,
            strength: 'direct',
          },
        ],
      },
    ]);

    const hits = await retrieveTaskContext(root, '订单结算修复');
    const taskHit = hits.find((hit) => hit.id === 'task-doc');
    const entityHit = hits.find((hit) => hit.id === 'entity-doc');
    expect(taskHit).toBeDefined();
    expect(entityHit).toBeDefined();
    expect(taskHit?.reasons).toContain('任务经验：历史任务可复用');
    expect(taskHit?.reasons.some((reason) => reason.startsWith('关键词匹配:'))).toBe(true);
    expect(taskHit!.score).toBeGreaterThan(0.5);
    expect(taskHit!.score).toBeGreaterThan(entityHit!.score);
    expect(hits[0]?.id).toBe('task-doc');
    expect(hits.slice(0, 2).map((hit) => hit.id)).toContain('entity-doc');
  });

  it('uses manifest aliases and alias index for glossary recall', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-alias-'));
    const now = new Date().toISOString();
    await fs.mkdir(path.join(root, '.agent/memory'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.agent/memory/discovery-manifest.json'),
      JSON.stringify({
        generatedAt: now,
        projectRoot: root,
        filesScanned: 1,
        entities: [
          {
            id: 'entity.order',
            name: 'Order',
            type: 'business_entity',
            description: '订单',
            confidence: 'high',
            evidence: [],
            tags: [],
          },
        ],
        rules: [
          {
            id: 'rule.order.dto',
            name: 'Order DTO rule',
            entity: 'OrderDTO',
            rule: ['订单 DTO 需要参与校验'],
            confidence: 'medium',
            evidence: [],
          },
        ],
        relations: [
          {
            id: 'relation.order.dto',
            source: 'OrderDTO',
            target: 'Order',
            relationship: 'maps-to',
            cardinality: '1:1',
            confidence: 'medium',
            evidence: [],
          },
        ],
        apis: [],
        conflicts: [],
        aliases: { Order: ['订单', 'OrderDTO'] },
        aliasIndex: { order: 'Order', '订单': 'Order', orderdto: 'Order' },
      }),
      'utf8',
    );

    const documents = await rebuildRetrievalIndex(root);
    const ruleDoc = documents.find((doc) => doc.id === 'rule.order.dto');
    const relationDoc = documents.find((doc) => doc.id === 'relation.order.dto');
    expect(ruleDoc?.aliases).toContain('Order');
    expect(ruleDoc?.aliases).toContain('订单');
    expect(relationDoc?.aliases).toContain('OrderDTO');

    const hits = await retrieveTaskContext(root, '订单');
    expect(hits.map((hit) => hit.title)).toContain('Order');
    expect(hits.map((hit) => hit.id)).toContain('rule.order.dto');
    expect(hits.map((hit) => hit.id)).toContain('relation.order.dto');
  });

  it('keeps feedback correction records retrievable with explicit reasons and warnings', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-feedback-'));
    const now = new Date().toISOString();
    await writeIndex(root, [
      {
        id: 'rule-doc',
        type: 'rule',
        title: 'Checkout pricing rule',
        tokens: ['checkout', 'pricing', 'correction'],
        aliases: ['Order'],
        relatedIds: ['order'],
        status: 'verified',
        confidence: 0.92,
        updatedAt: now,
        text: 'verified checkout pricing rule with broad source coverage',
        evidence: [
          {
            id: 'e5',
            kind: 'source',
            capturedAt: now,
            file: 'src/checkout.ts',
            lineStart: 10,
            lineEnd: 20,
            strength: 'direct',
          },
          {
            id: 'e7',
            kind: 'source',
            capturedAt: now,
            file: 'src/order.ts',
            lineStart: 30,
            lineEnd: 42,
            strength: 'direct',
          },
        ],
      },
      {
        id: 'feedback-doc',
        type: 'feedback',
        title: '标记 pricing rule 需要复核',
        tokens: ['checkout', 'pricing', 'correction'],
        aliases: [],
        relatedIds: ['rule-doc'],
        status: 'contradicted',
        confidence: 0.4,
        updatedAt: now,
        text: 'correction: pricing rule evidence is outdated',
        evidence: [
          {
            id: 'e6',
            kind: 'review',
            capturedAt: now,
            strength: 'linked',
            description: 'mark_stale because endpoint changed',
          },
        ],
      },
    ]);

    const hits = await retrieveTaskContext(root, 'checkout pricing correction', 5, { includeUnhealthy: true });
    const feedbackHit = hits.find((hit) => hit.id === 'feedback-doc');
    expect(feedbackHit?.reasons).toContain('反馈修正：存在反馈记录');
    expect(feedbackHit?.warnings).toContain('该结果来自反馈修正记录');
    const verifiedHit = hits.find((hit) => hit.id === 'rule-doc');
    expect(verifiedHit?.reasons).toContain('知识状态：verified');
    expect(verifiedHit?.reasons).toContain('证据强度：2条');
  });
});
