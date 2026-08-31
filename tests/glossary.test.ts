import { describe, expect, it } from 'vitest';
import {
  applyGlossaryEnrichment,
  buildAliasArtifacts,
  invertAliasMap,
  resolveCanonicalNameFromIndex,
} from '../src/core/glossary.js';
import { skeletonDescription } from '../src/core/entity-description.js';
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
    const artifacts = buildAliasArtifacts(entities, [
      { term: '订单', aliases: ['OrderDTO', '订单单据'], entity: 'Order' },
    ]);

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

  it('copies glossary terms into tags and enriches skeleton descriptions', () => {
    const entity: Entity = {
      id: 'entity.order',
      name: 'Order',
      type: 'business_entity',
      description: skeletonDescription('Order', ['src/order.ts']),
      confidence: 'low',
      evidence: ['src/order.ts'],
    };
    const enriched = applyGlossaryEnrichment(
      [entity],
      [{ term: '缴费', aliases: ['PremiumPayment'], entity: 'Order' }],
    );

    expect(enriched[0].tags).toEqual(expect.arrayContaining(['缴费', 'PremiumPayment']));
    expect(enriched[0].description).toContain('business aliases: 缴费, PremiumPayment');
    expect(enriched[0].description).toContain('Auto-discovered candidate Order');

    // Idempotent: a second discover run must not duplicate the suffix or tags.
    const again = applyGlossaryEnrichment(enriched, [{ term: '缴费', aliases: ['PremiumPayment'], entity: 'Order' }]);
    expect(again[0].description).toBe(enriched[0].description);
    expect(again[0].tags).toEqual(enriched[0].tags);
  });

  it('leaves human-authored descriptions untouched', () => {
    const entity: Entity = {
      id: 'entity.order',
      name: 'Order',
      type: 'business_entity',
      description: '订单实体，人工编写。',
      confidence: 'high',
      evidence: [],
    };
    const enriched = applyGlossaryEnrichment([entity], [{ term: '缴费', aliases: [], entity: 'Order' }]);
    expect(enriched[0].description).toBe('订单实体，人工编写。');
    expect(enriched[0].tags).toContain('缴费');
  });
});
