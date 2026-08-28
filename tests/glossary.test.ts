import { describe, expect, it } from 'vitest';
import { buildAliasArtifacts, invertAliasMap, resolveCanonicalNameFromIndex } from '../src/core/glossary.js';
import type { Entity } from '../src/core/types.js';

describe('glossary helpers', () => {
  it('builds entity aliases and reverse lookup index', () => {
    const entities: Entity[] = [
      {
        id: 'entity.order',
        name: 'Order',
        type: 'business_entity',
        description: '订单',
        confidence: 'high',
        evidence: [],
        tags: ['OrderEntity'],
      },
    ];
    const artifacts = buildAliasArtifacts(entities, [{ term: '订单', aliases: ['OrderDTO', '订单单据'], entity: 'Order' }]);

    expect(artifacts.aliasesByEntity.Order).toEqual(
      expect.arrayContaining(['订单', 'OrderDTO', 'orders', 'order_entity', 'orderdto', '订单单据']),
    );
    expect(artifacts.aliasesByEntity.Order).not.toContain('Order');
    expect(artifacts.aliasToEntity['订单']).toBe('Order');
    expect(artifacts.aliasToEntity['orderdto']).toBe('Order');
    expect(artifacts.aliasToEntity['orderentity']).toBe('Order');
    expect(resolveCanonicalNameFromIndex('OrderDTO', artifacts.aliasToEntity)).toBe('Order');
    expect(resolveCanonicalNameFromIndex('订单', artifacts.aliasToEntity)).toBe('Order');
  });

  it('can rebuild alias index from legacy manifest aliases', () => {
    const aliasIndex = invertAliasMap({ Order: ['订单', 'OrderDTO'] });
    expect(aliasIndex['order']).toBe('Order');
    expect(aliasIndex['订单']).toBe('Order');
    expect(aliasIndex['orderdto']).toBe('Order');
  });
});
