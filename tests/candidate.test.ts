import { describe, expect, it } from 'vitest';
import {
  parseCandidate,
  buildRuleFromCandidate,
  buildRelationFromInput,
  candidateSlug,
} from '../src/core/candidate.js';

const SAMPLE = `# Candidate: 审核中的方案不能修改核心险种

Status: candidate

## Hypothesis
- Under audit, core coverage cannot be changed.

## Evidence
- src/PlanService.ts
- src/Approval.ts

## Impact
- UI edit form
- Approval workflow

## Verification
- Confirm with backend team.
`;

describe('parseCandidate', () => {
  it('extracts name and sections', () => {
    const parsed = parseCandidate(SAMPLE, 'fallback');
    expect(parsed.name).toBe('审核中的方案不能修改核心险种');
    expect(parsed.hypothesis).toEqual(['Under audit, core coverage cannot be changed.']);
    expect(parsed.evidence).toEqual(['src/PlanService.ts', 'src/Approval.ts']);
    expect(parsed.impact).toEqual(['UI edit form', 'Approval workflow']);
    // The final section must parse even though no further heading follows it.
    expect(parsed.verification).toEqual(['Confirm with backend team.']);
  });

  it('uses fallback name when missing', () => {
    expect(parseCandidate('no title', 'fallback').name).toBe('fallback');
  });
});

describe('buildRuleFromCandidate', () => {
  it('builds a confirmed rule from a parsed candidate', () => {
    const parsed = parseCandidate(SAMPLE, 'fallback');
    const rule = buildRuleFromCandidate({ name: parsed.name, entity: 'Plan', candidate: parsed });
    expect(rule.status).toBe('confirmed');
    expect(rule.id).toBe('rule.promoted-rule');
    expect(rule.entity).toBe('Plan');
    expect(rule.evidence).toContain('src/PlanService.ts');
  });

  it('falls back to evidence placeholder', () => {
    const rule = buildRuleFromCandidate({
      name: 'X',
      entity: 'Y',
      candidate: parseCandidate('## Hypothesis\n- h', 'X'),
    });
    expect(rule.evidence).toEqual(['Promoted from candidate']);
  });
});

describe('buildRelationFromInput', () => {
  it('builds a relation with default confidence', () => {
    const rel = buildRelationFromInput({
      source: 'Plan',
      target: 'Approval',
      relationship: 'references',
      cardinality: '1:N',
    });
    expect(rel.id).toBe('relation.plan-approval');
    expect(rel.confidence).toBe('medium');
  });
});

describe('candidateSlug', () => {
  it('produces a slug for latin text', () => {
    expect(candidateSlug('My Candidate!')).toBe('my-candidate');
  });

  it('falls back for non-latin text', () => {
    const slug = candidateSlug('审核中的方案');
    expect(slug).toMatch(/^candidate-\d+$/);
  });
});
