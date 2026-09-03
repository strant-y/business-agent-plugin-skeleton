import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyCandidateStatus,
  extractTargetRuleId,
  isResolvedCandidateStatus,
  normalizeCandidateStatus,
  parseFrontMatter,
  resolveCandidateId,
  resolveCandidateState,
  scanCandidateDir,
  type CandidateStatus,
} from '../src/core/candidate-status.js';

describe('parseFrontMatter', () => {
  it('parses scalar key/value pairs from a YAML block', () => {
    const content = `---
candidateId: candidate.correct-apply-no-approval-display
status: approved
confidence: high
reviewedAt: 2026-09-03
targetRuleId: rule.correct-apply-no-approval-display
reason: 前端实现、请求 DTO 和接口资料相互印证
---

# Candidate: 批改申请报批号
Status: candidate
`;
    const fm = parseFrontMatter(content);
    expect(fm.candidateId).toBe('candidate.correct-apply-no-approval-display');
    expect(fm.status).toBe('approved');
    expect(fm.reason).toBe('前端实现、请求 DTO 和接口资料相互印证');
    expect(fm.targetRuleId).toBe('rule.correct-apply-no-approval-display');
  });

  it('returns an empty map without a front matter block', () => {
    expect(parseFrontMatter('# Candidate: x\n\nStatus: candidate\n')).toEqual({});
  });
});

describe('normalizeCandidateStatus', () => {
  it.each([
    ['promoted', 'promoted'],
    ['promoted as rule.x', 'promoted'],
    ['approved', 'promoted'],
    ['accepted', 'promoted'],
    ['covered by rule.x', 'covered'],
    ['covered', 'covered'],
    ['rejected', 'rejected'],
    ['needs-verification', 'needs-verification'],
    ['needs verification', 'needs-verification'],
    ['candidate', 'candidate'],
    ['pending', 'candidate'],
    ['已晋级', 'promoted'],
    ['已覆盖', 'covered'],
    ['已拒绝', 'rejected'],
    ['待核验', 'needs-verification'],
    ['候选', 'candidate'],
    ['- 状态: candidate', undefined],
  ] as Array<[string, CandidateStatus | undefined]>)('maps "%s" -> %s', (raw, expected) => {
    expect(normalizeCandidateStatus(raw)).toBe(expected);
  });

  it('returns undefined for unknown spellings', () => {
    expect(normalizeCandidateStatus('mystery-state')).toBeUndefined();
    expect(normalizeCandidateStatus(undefined)).toBeUndefined();
  });
});

describe('extractTargetRuleId', () => {
  it('extracts the rule id from composite status text', () => {
    expect(extractTargetRuleId('promoted as rule.approval-display')).toBe('rule.approval-display');
    expect(extractTargetRuleId('covered by RULE.merge-target')).toBe('rule.merge-target');
    expect(extractTargetRuleId('rejected')).toBeUndefined();
  });
});

describe('resolveCandidateState', () => {
  it('prefers front matter over the legacy status line', () => {
    const content = `---
status: needs-verification
---
# Candidate: x
Status: rejected
`;
    const state = resolveCandidateState(content);
    expect(state.status).toBe('needs-verification');
    expect(state.source).toBe('front-matter');
  });

  it('reads the legacy English status line when no front matter exists', () => {
    expect(resolveCandidateState('# Candidate: x\nStatus: promoted as rule.y\n').status).toBe('promoted');
    expect(resolveCandidateState('# Candidate: x\nStatus: promoted as rule.y\n').targetRuleId).toBe('rule.y');
    expect(resolveCandidateState('# Candidate: x\nStatus: candidate\n').status).toBe('candidate');
  });

  it('reads blockquote and Chinese status lines', () => {
    expect(resolveCandidateState('# Candidate: x\n> Status: rejected\n').status).toBe('rejected');
    expect(resolveCandidateState('# Candidate: x\n- 状态: 已晋级\n').status).toBe('promoted');
  });

  it('defaults to candidate when no marker is present', () => {
    const state = resolveCandidateState('# Candidate: x\n\n## Hypothesis\n- h\n');
    expect(state.status).toBe('candidate');
    expect(state.source).toBe('default');
  });
});

describe('resolveCandidateId', () => {
  it('prefers the front matter candidateId', () => {
    const content = `---
candidateId: candidate.approval-display
---
# Candidate: 批改申请报批号展示错误
`;
    expect(resolveCandidateId('something-else.md', content)).toBe('candidate.approval-display');
  });

  it('falls back to the file slug', () => {
    expect(resolveCandidateId('rule.approval-lock.md', '# Candidate: x\n')).toBe('rule.approval-lock');
  });
});

describe('applyCandidateStatus', () => {
  it('inserts front matter and keeps the legacy Status line in sync', () => {
    const updated = applyCandidateStatus('# Candidate: 批改\nStatus: candidate\n', 'rule.x.md', {
      status: 'promoted',
      targetRuleId: 'rule.x',
      reason: '多方印证',
    });
    const state = resolveCandidateState(updated);
    expect(state.status).toBe('promoted');
    expect(state.targetRuleId).toBe('rule.x');
    expect(state.source).toBe('front-matter');
    expect(updated).toContain('Status: promoted as rule.x');
    expect(resolveCandidateId('rule.x.md', updated)).toBe('rule.x');
  });

  it('updates existing front matter in place', () => {
    const original = `---
candidateId: candidate.keep-me
status: candidate
---
# Candidate: 批改
Status: candidate
`;
    const updated = applyCandidateStatus(original, 'whatever.md', { status: 'rejected', reason: '被正式规则覆盖' });
    expect(resolveCandidateState(updated).status).toBe('rejected');
    // The stable candidateId is preserved across status transitions.
    expect(resolveCandidateId('whatever.md', updated)).toBe('candidate.keep-me');
    expect(updated).not.toContain('status: candidate');
  });
});

describe('isResolvedCandidateStatus', () => {
  it('treats approved/covered/rejected/promoted as resolved and pending states as open', () => {
    expect(isResolvedCandidateStatus('promoted')).toBe(true);
    expect(isResolvedCandidateStatus('approved')).toBe(true);
    expect(isResolvedCandidateStatus('covered')).toBe(true);
    expect(isResolvedCandidateStatus('rejected')).toBe(true);
    expect(isResolvedCandidateStatus('candidate')).toBe(false);
    expect(isResolvedCandidateStatus('needs-verification')).toBe(false);
  });
});

describe('scanCandidateDir (location-aware)', () => {
  it('counts files under rejected/ as resolved even when their status marker still says candidate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-scan-'));
    const dir = path.join(root, 'candidates');
    await fs.mkdir(path.join(dir, 'rejected'), { recursive: true });
    // A legacy reject moved the file without rewriting the marker.
    await fs.writeFile(
      path.join(dir, 'rejected', 'old-noise.md'),
      '# Candidate: 旧噪声\nStatus: candidate\n\n## Entity\nPolicy\n\n## Hypothesis\n- h\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'pending-new.md'),
      '# Candidate: 新候选\nStatus: candidate\n\n## Entity\nPolicy\n\n## Hypothesis\n- h\n',
      'utf8',
    );

    const index = await scanCandidateDir(dir);
    expect(index.total).toBe(2);
    expect(index.pending).toBe(1);
    expect(index.resolved).toBe(1);
    expect(index.byId['old-noise']?.status).toBe('rejected');
    expect(index.byId['old-noise']?.source).toBe('rejected-location');
    expect(index.byId['pending-new']?.status).toBe('candidate');
    await fs.rm(root, { recursive: true, force: true });
  });
});
