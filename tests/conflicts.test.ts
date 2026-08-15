import { describe, expect, it } from 'vitest';
import { detectConflicts, ruleSign } from '../src/core/conflicts.js';
import type { BusinessRule } from '../src/core/types.js';

function rule(id: string, entity: string, text: string): BusinessRule {
  return {
    id,
    name: id,
    entity,
    rule: [text],
    confidence: 'low',
    evidence: [],
  };
}

describe('detectConflicts', () => {
  it('flags two rules on the same entity with opposing constraints', () => {
    const rules = [
      rule('rule.a', 'Product', 'cannot modify core coverage'),
      rule('rule.b', 'Product', 'allow modifying core coverage'),
    ];
    const conflicts = detectConflicts(rules);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].entity).toBe('Product');
    expect(conflicts[0].ruleA).toBe('rule.a');
    expect(conflicts[0].ruleB).toBe('rule.b');
  });

  it('does not flag rules with the same sign', () => {
    const rules = [rule('rule.a', 'Product', 'must not delete'), rule('rule.b', 'Product', 'cannot archive')];
    expect(detectConflicts(rules)).toHaveLength(0);
  });

  it('ignores rules on different entities', () => {
    const rules = [rule('rule.a', 'Product', 'cannot modify'), rule('rule.b', 'Order', 'allow modifying')];
    expect(detectConflicts(rules)).toHaveLength(0);
  });
});

describe('ruleSign', () => {
  it('detects positive and negative constraint language', () => {
    expect(ruleSign('allow editing')).toBe(1);
    expect(ruleSign('cannot edit')).toBe(-1);
    expect(ruleSign('review state')).toBe(0);
  });
});
