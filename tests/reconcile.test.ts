import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reconcileReviewState } from '../src/commands/reconcile.js';
import { loadReviewState } from '../src/core/review.js';

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-reconcile-cmd-'));
  tempRoots.push(root);
  const candidates = path.join(root, '.agent', 'memory', 'candidates');
  await fs.mkdir(candidates, { recursive: true });
  await fs.mkdir(path.join(candidates, 'rejected'), { recursive: true });
  return root;
}

async function writeCandidate(root: string, relative: string, title: string, statusLine: string): Promise<void> {
  const file = path.join(root, '.agent', 'memory', 'candidates', relative);
  const body = `# Candidate: ${title}\n${statusLine}\n\n## Entity\nPolicy\n\n## Hypothesis\n- h ${title}\n\n## Evidence\n- src/PolicyEdit.vue\n`;
  await fs.writeFile(file, body, 'utf8');
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('reconcile review-state', () => {
  it('backfills review decisions for resolved candidate files with no audit record', async () => {
    const root = await makeRoot();
    // Legacy flow: file status was rewritten but review-state was never updated.
    await writeCandidate(
      root,
      'rule-approval-display.md',
      '批改申请报批号展示错误',
      'Status: promoted as rule.approval-display',
    );
    await writeCandidate(root, 'rejected/rule-old-noise.md', '旧噪声候选', 'Status: rejected');

    const result = await reconcileReviewState(root);
    expect(result.added).toBe(2);

    const state = await loadReviewState(path.join(root, '.agent'));
    const promoted = state.decisions['candidateId:rule-approval-display'];
    expect(promoted?.status).toBe('promoted');
    expect(promoted?.targetRuleId).toBe('rule.approval-display');
    expect(promoted?.decision).toBe('accepted');
    const rejected = state.decisions['candidateId:rule-old-noise'];
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.decision).toBe('rejected');
  });

  it('is idempotent and leaves existing decisions untouched', async () => {
    const root = await makeRoot();
    await writeCandidate(root, 'rule-existing.md', '已有记录的候选', 'Status: covered by rule.target');

    await reconcileReviewState(root);
    const first = await loadReviewState(path.join(root, '.agent'));
    expect(first.decisions['candidateId:rule-existing']?.reviewedBy).toBe('reconcile');

    // A second run must not duplicate or overwrite.
    const second = await reconcileReviewState(root);
    expect(second.added).toBe(0);
    const stateAfter = await loadReviewState(path.join(root, '.agent'));
    expect(stateAfter.decisions['candidateId:rule-existing']?.reviewedBy).toBe('reconcile');
    expect(stateAfter.decisions['candidateId:rule-existing']?.reason).toContain('covered');
  });

  it('dry-run reports candidates without writing anything', async () => {
    const root = await makeRoot();
    await writeCandidate(root, 'rule-dry.md', '干跑候选', 'Status: rejected');

    const result = await reconcileReviewState(root, { dryRun: true });
    expect(result.added).toBe(1);
    const state = await loadReviewState(path.join(root, '.agent'));
    expect(Object.keys(state.decisions)).toHaveLength(0);
  });

  it('leaves pending candidates alone', async () => {
    const root = await makeRoot();
    await writeCandidate(root, 'rule-pending.md', '待评审候选', 'Status: candidate');

    const result = await reconcileReviewState(root);
    expect(result.added).toBe(0);
  });
});
