import { describe, expect, it } from 'vitest';
import { detectConflicts, ruleSign } from '../src/core/conflicts.js';
import type { BusinessRule } from '../src/core/types.js';

function rule(id: string, entity: string, text: string, preconditions?: string[]): BusinessRule {
  return {
    id,
    name: id,
    entity,
    rule: [text],
    preconditions,
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

  it('marks opposing rules with different roles or preconditions as conditional conflicts', () => {
    const conflicts = detectConflicts([
      rule('rule.a', 'Order', 'cannot modify order', ['status is AUDIT']),
      rule('rule.b', 'Order', 'admin allow modifying order', ['user is admin']),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].description).toContain('different roles or preconditions');
    expect(conflicts[0].suggestions).toContain('确认两者前置条件是否互斥，尤其是角色权限与业务状态。');
  });

  it('recognizes Chinese role conditions as conditional conflicts', () => {
    const conflicts = detectConflicts([
      rule('rule.a', 'Order', '审核中禁止修改订单', ['订单状态为审核中']),
      rule('rule.b', 'Order', '管理员允许修改订单', ['当前用户为管理员']),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].description).toContain('different roles or preconditions');
  });

  it('does not report opposing constraints for different actions', () => {
    const rules = [rule('rule.a', 'Order', 'cannot modify order'), rule('rule.b', 'Order', 'allow deleting order')];
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
