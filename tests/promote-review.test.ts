import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { promoteCommand } from '../src/commands/promote.js';
import { reviewCommand } from '../src/commands/review.js';
import { loadRules, loadRelations } from '../src/core/knowledge.js';
import { loadReviewState } from '../src/core/review.js';

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-review-'));
  tempRoots.push(root);
  const agentRoot = path.join(root, '.agent');
  await fs.mkdir(path.join(agentRoot, 'memory', 'candidates'), { recursive: true });
  await fs.mkdir(path.join(agentRoot, 'business', 'rules'), { recursive: true });
  await fs.writeFile(path.join(agentRoot, 'business-agent.json'), '{}', 'utf8');
  return root;
}

async function writeCandidate(root: string, fileName: string, title: string, extra = ''): Promise<string> {
  const agentRoot = path.join(root, '.agent');
  const file = path.join(agentRoot, 'memory', 'candidates', fileName);
  const body = `# Candidate: ${title}
Status: candidate

## Entity
Policy

## Hypothesis
- ${title} 的审核结论（fixture）

## Evidence
- src/views/PolicyEdit.vue

## Impact
- PolicyEdit.vue
${extra}`;
  await fs.writeFile(file, body, 'utf8');
  return file;
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('promote rule id generation (P0-1)', () => {
  it('promotes Chinese-title candidates under their stable file slug, never rule.promoted-rule', async () => {
    const root = await makeRoot();
    await writeCandidate(root, 'approval-display.md', '批改申请报批号展示错误');
    await writeCandidate(root, 'surrender-review.md', '退保申请必须人工复核');

    await promoteCommand(root, 'approval-display', { json: true });
    await promoteCommand(root, 'surrender-review', { json: true });

    const rules = await loadRules(path.join(root, '.agent'));
    const ids = rules.map((r) => r.id);
    expect(ids).not.toContain('rule.promoted-rule');
    expect(ids).toContain('rule.approval-display');
    expect(ids).toContain('rule.surrender-review');

    // Two promotions produced two distinct files; neither overwrote the other.
    const jsonFiles = await listFiles(path.join(root, '.agent', 'business', 'rules'));
    expect(jsonFiles.filter((f) => f.endsWith('.json'))).toHaveLength(2);

    // Candidate markdown is double-marked: front matter + legacy Status line.
    const promotedFile = await fs.readFile(
      path.join(root, '.agent', 'memory', 'candidates', 'approval-display.md'),
      'utf8',
    );
    expect(promotedFile).toContain('status: promoted');
    expect(promotedFile).toContain('targetRuleId: rule.approval-display');
    expect(promotedFile).toContain('Status: promoted as rule.approval-display');
  });

  it('refuses to overwrite a legacy rule.promoted-rule and asks for --id or --into', async () => {
    const root = await makeRoot();
    // Simulate the historical bug: a shared rule.promoted-rule already exists.
    const legacy = {
      id: 'rule.promoted-rule',
      name: 'Legacy promoted rule',
      entity: 'X',
      rule: ['legacy content'],
      confidence: 'medium',
      evidence: ['src/legacy.ts'],
      status: 'confirmed',
    };
    await fs.writeFile(
      path.join(root, '.agent', 'business', 'rules', 'rule.promoted-rule.json'),
      JSON.stringify(legacy),
      'utf8',
    );
    await writeCandidate(root, 'promoted-rule.md', '新中文候选内容不同');

    await expect(promoteCommand(root, 'promoted-rule')).rejects.toThrow(/already exists/);

    // The legacy file must be untouched.
    const rules = await loadRules(path.join(root, '.agent'));
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe('Legacy promoted rule');
  });

  it('honors an explicit --id and still refuses duplicate explicit ids', async () => {
    const root = await makeRoot();
    await writeCandidate(root, 'approval-display.md', '批改申请报批号展示错误');
    await promoteCommand(root, 'approval-display', { id: 'rule.custom-approval-display' });
    const rules = await loadRules(path.join(root, '.agent'));
    expect(rules.map((r) => r.id)).toContain('rule.custom-approval-display');

    // A second candidate explicitly targeting the same id must fail.
    await writeCandidate(root, 'another-approval.md', '另一个批改报批号候选');
    await expect(promoteCommand(root, 'another-approval', { id: 'rule.custom-approval-display' })).rejects.toThrow(
      /already exists|existing/,
    );
  });

  it('merges a candidate into an existing rule with --into and marks it covered', async () => {
    const root = await makeRoot();
    await writeCandidate(root, 'approval-display.md', '批改申请报批号展示错误');
    await promoteCommand(root, 'approval-display', { id: 'rule.approval-display' });
    const before = (await loadRules(path.join(root, '.agent')))[0];
    const evidenceBefore = before.evidence.length;

    const extraFile = await writeCandidate(root, 'approval-extra.md', '报批号空值兜底');
    // Give the merge target a distinct evidence path so the union grows.
    await fs.writeFile(
      extraFile,
      (await fs.readFile(extraFile, 'utf8')).replace(
        '## Evidence\n- src/views/PolicyEdit.vue',
        '## Evidence\n- src/views/PolicyEdit.vue\n- src/services/approval.ts:42',
      ),
      'utf8',
    );
    await promoteCommand(root, 'approval-extra', { into: 'rule.approval-display' });

    const after = (await loadRules(path.join(root, '.agent')))[0];
    expect(after.id).toBe('rule.approval-display');
    expect(after.evidence.length).toBeGreaterThan(evidenceBefore);
    expect(after.rule.length).toBeGreaterThanOrEqual(before.rule.length);

    // The merged candidate is marked covered with a target rule id.
    const mergedFile = await fs.readFile(
      path.join(root, '.agent', 'memory', 'candidates', 'approval-extra.md'),
      'utf8',
    );
    expect(mergedFile).toContain('status: covered');
    expect(mergedFile).toContain('Status: covered by rule.approval-display');
  });
});

describe('review single-candidate mode (P0-2/P1)', () => {
  it('rejects one candidate with --reject and a reason, moving it to rejected/', async () => {
    const root = await makeRoot();
    await writeCandidate(root, 'bad-candidate.md', '废弃的候选');

    await reviewCommand(root, { candidate: 'bad-candidate', rejectFlag: true, reason: '被正式规则覆盖' });

    expect(await listFiles(path.join(root, '.agent', 'memory', 'candidates'))).toEqual(['rejected']);
    expect(await listFiles(path.join(root, '.agent', 'memory', 'candidates', 'rejected'))).toEqual([
      'bad-candidate.md',
    ]);
    const moved = await fs.readFile(
      path.join(root, '.agent', 'memory', 'candidates', 'rejected', 'bad-candidate.md'),
      'utf8',
    );
    expect(moved).toContain('status: rejected');

    const state = await loadReviewState(path.join(root, '.agent'));
    const decision = state.decisions[`candidateId:bad-candidate`];
    expect(decision?.status).toBe('rejected');
    expect(decision?.reason).toBe('被正式规则覆盖');
  });

  it('marks one candidate as covered by an existing rule with --covered-by', async () => {
    const root = await makeRoot();
    await writeCandidate(root, 'dup-candidate.md', '重复候选');
    // Promote a canonical rule first so the coverage target exists.
    await promoteCommand(root, 'dup-candidate', { id: 'rule.canonical-rule' });

    await writeCandidate(root, 'dup-other.md', '同主题候选 B');
    await reviewCommand(root, { candidate: 'dup-other', coveredBy: 'rule.canonical-rule', reason: '并入既有规则' });

    const file = await fs.readFile(path.join(root, '.agent', 'memory', 'candidates', 'dup-other.md'), 'utf8');
    expect(file).toContain('status: covered');
    expect(file).toContain('Status: covered by rule.canonical-rule');

    const state = await loadReviewState(path.join(root, '.agent'));
    const decision = state.decisions['candidateId:dup-other'];
    expect(decision?.status).toBe('covered');
    expect(decision?.targetRuleId).toBe('rule.canonical-rule');

    // The canonical rule set is unchanged (no duplicate was created).
    const ruleJsons = (await listFiles(path.join(root, '.agent', 'business', 'rules'))).filter((f) =>
      f.endsWith('.json'),
    );
    expect(ruleJsons).toHaveLength(1);
  });

  it('resolves legacy Chinese status markers as pending instead of skipping them', async () => {
    const root = await makeRoot();
    await writeCandidate(root, 'cn-status.md', '中文状态候选');
    const file = path.join(root, '.agent', 'memory', 'candidates', 'cn-status.md');
    await fs.writeFile(
      file,
      (await fs.readFile(file, 'utf8')).replace('Status: candidate', '- 状态: candidate'),
      'utf8',
    );

    // Batch review with reject low must surface and reject the Chinese-marked candidate.
    await reviewCommand(root, { nonInteractive: true, reject: 'low' });
    expect(await listFiles(path.join(root, '.agent', 'memory', 'candidates', 'rejected'))).toContain('cn-status.md');
  });

  it('keeps relation promotion working through the reviewed candidate path', async () => {
    const root = await makeRoot();
    await writeCandidate(root, 'order-payment.md', 'Order 依赖 Payment', '');
    await fs.writeFile(
      path.join(root, '.agent', 'memory', 'candidates', 'order-payment.md'),
      `# Candidate: Order 依赖 Payment
Status: candidate

## Hypothesis
- Order 与 Payment 之间的依赖

## Evidence
- src/order.ts
`,
      'utf8',
    );
    await promoteCommand(root, 'order-payment', {
      type: 'relation',
      source: 'Order',
      target: 'Payment',
      relationship: 'calls',
    });
    const relations = await loadRelations(path.join(root, '.agent'));
    expect(relations.map((r) => r.id)).toContain('relation.order-payment');
  });
});
