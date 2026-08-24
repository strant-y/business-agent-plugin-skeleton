import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAliasMap, loadGlossary, resolveCanonicalName } from '../src/core/glossary.js';
import type { Entity } from '../src/core/types.js';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ba-glossary-'));
}

describe('glossary', () => {
  it('parses structured glossary rows with term, aliases and entity', async () => {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, '.agent/business'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.agent/business/glossary.md'),
      '| 术语 | 别名 | 实体 |\n| --- | --- | --- |\n| 缴费 | PremiumPayment, premium_payment | Order |\n',
      'utf8',
    );

    await expect(loadGlossary(dir)).resolves.toEqual([
      { term: '缴费', aliases: ['PremiumPayment', 'premium_payment'], entity: 'Order' },
    ]);
  });

  it('builds alias variants for glossary rows and entity suffixes', () => {
    const entities: Entity[] = [
      {
        id: 'entity.order',
        name: 'Order',
        type: 'business_entity',
        description: 'Order entity',
        confidence: 'medium',
        evidence: [],
      },
    ];
    const aliases = buildAliasMap(entities, [{ term: '缴费', aliases: ['OrderDTO', 'premium_payment'], entity: 'Order' }]);

    expect(aliases.Order).toEqual(expect.arrayContaining(['缴费', 'OrderDTO', 'premium_payment', 'orders']));
    expect(resolveCanonicalName('orders', aliases)).toBe('Order');
    expect(resolveCanonicalName('OrderDTO', aliases)).toBe('Order');
    expect(resolveCanonicalName('缴费', aliases)).toBe('Order');
  });
});
