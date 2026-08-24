import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { retrieveTaskContext } from '../src/core/retrieval.js';

async function writeIndex(root: string, documents: unknown[]): Promise<void> {
  await fs.mkdir(path.join(root, '.agent/memory/indexes'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.agent/memory/indexes/retrieval-index.json'),
    JSON.stringify(documents, null, 2),
    'utf8',
  );
}

describe('retrieveTaskContext', () => {
  it('ranks verified above stale, contradicted, and deprecated with readable explanations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-retrieval-'));
    const now = new Date().toISOString();
    await writeIndex(root, [
      {
        id: 'verified-doc',
        type: 'entity',
        title: 'Verified Product',
        tokens: ['product', 'checkout'],
        aliases: ['Product'],
        relatedIds: [],
        status: 'verified',
        confidence: 0.95,
        updatedAt: now,
        text: 'verified product knowledge',
        evidence: [
          {
            id: 'e1',
            kind: 'source',
            capturedAt: now,
            file: 'src/Product.ts',
            lineStart: 1,
            lineEnd: 2,
            strength: 'direct',
          },
        ],
      },
      {
        id: 'stale-doc',
        type: 'entity',
        title: 'Stale Product',
        tokens: ['product', 'checkout'],
        aliases: ['Product'],
        relatedIds: [],
        status: 'stale',
        confidence: 0.95,
        updatedAt: now,
        text: 'stale product knowledge',
        evidence: [
          {
            id: 'e-stale',
            kind: 'source',
            capturedAt: now,
            file: 'src/Product.ts',
            lineStart: 5,
            lineEnd: 6,
            strength: 'direct',
          },
        ],
      },
      {
        id: 'contradicted-doc',
        type: 'entity',
        title: 'Contradicted Product',
        tokens: ['product', 'checkout'],
        aliases: ['Product'],
        relatedIds: [],
        status: 'contradicted',
        confidence: 0.95,
        updatedAt: now,
        text: 'contradicted product knowledge',
        evidence: [
          {
            id: 'e2',
            kind: 'source',
            capturedAt: now,
            file: 'src/Product.ts',
            lineStart: 3,
            lineEnd: 4,
            strength: 'direct',
          },
        ],
      },
      {
        id: 'deprecated-doc',
        type: 'entity',
        title: 'Deprecated Product',
        tokens: ['product', 'checkout'],
        aliases: ['Product'],
        relatedIds: [],
        status: 'deprecated',
        confidence: 0.95,
        updatedAt: now,
        text: 'deprecated product knowledge',
        evidence: [
          {
            id: 'e3',
            kind: 'source',
            capturedAt: now,
            file: 'src/Product.ts',
            lineStart: 7,
            lineEnd: 8,
            strength: 'direct',
          },
        ],
      },
    ]);

    const hits = await retrieveTaskContext(root, 'product checkout', 10, { includeUnhealthy: true });
    expect(hits.map((hit) => hit.id).slice(0, 4)).toEqual([
      'verified-doc',
      'stale-doc',
      'contradicted-doc',
      'deprecated-doc',
    ]);
    expect(hits[0].reasons).toContain('知识状态：verified');
    expect(hits[1].reasons).toContain('知识状态：stale');
    expect(hits[1].warnings).toContain('知识已过期，使用前请复核');
    expect(hits[2].reasons).toContain('知识状态：contradicted');
    expect(hits[2].warnings).toContain('知识存在冲突，优先检查更新证据');
    expect(hits[3].reasons).toContain('知识状态：deprecated');
    expect(hits[3].warnings).toContain('知识已弃用，通常不应继续沿用');
    expect(hits[3].score).toBeLessThan(hits[2].score);
  });

  it('filters out unhealthy and low-confidence candidates by default, with opt-in flags', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-filter-'));
    const now = new Date().toISOString();
    await writeIndex(root, [
      {
        id: 'verified-doc',
        type: 'rule',
        title: 'Verified rule',
        tokens: ['order', 'audit'],
        aliases: ['Order'],
        relatedIds: [],
        status: 'verified',
        confidence: 0.95,
        updatedAt: now,
        text: 'verified rule',
      },
      {
        id: 'stale-doc',
        type: 'rule',
        title: 'Stale rule',
        tokens: ['order', 'audit'],
        aliases: ['Order'],
        relatedIds: [],
        status: 'stale',
        confidence: 0.9,
        updatedAt: now,
        text: 'stale rule',
      },
      {
        id: 'candidate-low-doc',
        type: 'rule',
        title: 'Low candidate',
        tokens: ['order', 'audit'],
        aliases: ['Order'],
        relatedIds: [],
        status: 'candidate',
        confidence: 0.3,
        updatedAt: now,
        text: 'low confidence candidate rule',
      },
      {
        id: 'candidate-medium-doc',
        type: 'rule',
        title: 'Medium candidate',
        tokens: ['order', 'audit'],
        aliases: ['Order'],
        relatedIds: [],
        status: 'candidate',
        confidence: 0.7,
        updatedAt: now,
        text: 'medium confidence candidate rule',
      },
    ]);

    const defaults = await retrieveTaskContext(root, 'order audit');
    expect(defaults.map((hit) => hit.id)).toContain('verified-doc');
    expect(defaults.map((hit) => hit.id)).toContain('candidate-medium-doc');
    expect(defaults.map((hit) => hit.id)).not.toContain('stale-doc');
    expect(defaults.map((hit) => hit.id)).not.toContain('candidate-low-doc');

    const everything = await retrieveTaskContext(root, 'order audit', 10, {
      includeUnhealthy: true,
      includeLowConfidence: true,
    });
    expect(everything.map((hit) => hit.id)).toEqual(
      expect.arrayContaining(['verified-doc', 'stale-doc', 'candidate-low-doc', 'candidate-medium-doc']),
    );
  });

  it('keeps task experience recall stable without forcing it to always rank first', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-task-exp-'));
    const now = new Date().toISOString();
    await writeIndex(root, [
      {
        id: 'entity-doc',
        type: 'entity',
        title: 'Product pricing entity',
        tokens: ['product', 'pricing', 'flow', 'tax', 'discount'],
        aliases: ['Product'],
        relatedIds: [],
        status: 'verified',
        confidence: 0.9,
        updatedAt: now,
        text: 'entity doc with current pricing rules',
        evidence: [
          {
            id: 'e3',
            kind: 'source',
            capturedAt: now,
            file: 'src/Product.ts',
            lineStart: 1,
            lineEnd: 2,
            strength: 'direct',
          },
          {
            id: 'e4',
            kind: 'source',
            capturedAt: now,
            file: 'src/Pricing.ts',
            lineStart: 8,
            lineEnd: 18,
            strength: 'direct',
          },
        ],
      },
      {
        id: 'task-doc',
        type: 'task',
        title: 'Pricing flow lesson',
        tokens: ['product', 'pricing', 'flow', 'discount'],
        aliases: ['Product'],
        relatedIds: ['pricing-rule', 'product'],
        updatedAt: now,
        text: 'task experience around product pricing flow and discount edge cases',
      },
    ]);

    const hits = await retrieveTaskContext(root, 'product pricing flow discount');
    const taskHit = hits.find((hit) => hit.id === 'task-doc');
    const entityHit = hits.find((hit) => hit.id === 'entity-doc');
    expect(taskHit).toBeDefined();
    expect(entityHit).toBeDefined();
    expect(taskHit?.reasons).toContain('任务经验：历史任务可复用');
    expect(taskHit?.reasons.some((reason) => reason.startsWith('关键词匹配:'))).toBe(true);
    expect(taskHit!.score).toBeGreaterThan(0.5);
    expect(entityHit!.score).toBeGreaterThanOrEqual(taskHit!.score);
    expect(hits.slice(0, 2).map((hit) => hit.id)).toContain('task-doc');
  });

  it('uses manifest aliases for glossary and synonym recall', async () => {
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
        rules: [],
        relations: [],
        apis: [],
        conflicts: [],
        aliases: { Order: ['订单', 'OrderDTO'] },
      }),
      'utf8',
    );

    const hits = await retrieveTaskContext(root, '订单');
    expect(hits.map((hit) => hit.title)).toContain('Order');
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
        title: 'pricing correction',
        tokens: ['checkout', 'pricing', 'correction'],
        aliases: [],
        relatedIds: ['rule-doc', 'task-1', 'session-1'],
        status: 'verified',
        confidence: 0.92,
        updatedAt: now,
        text: 'correction: use discounted subtotal before tax',
        evidence: [{ id: 'e6', kind: 'human', capturedAt: now, snippet: 'discount before tax', strength: 'linked' }],
      },
    ]);

    const hits = await retrieveTaskContext(root, 'checkout pricing correction');
    const feedbackHit = hits.find((hit) => hit.id === 'feedback-doc');
    expect(feedbackHit).toBeDefined();
    expect(feedbackHit?.reasons).toContain('反馈修正：存在反馈记录');
    expect(feedbackHit?.warnings).toContain('该结果来自反馈修正记录');
    expect(feedbackHit?.reasons).toContain('知识状态：verified');
  });
});
