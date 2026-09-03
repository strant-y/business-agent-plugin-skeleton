import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runAudit, type AuditCheck } from '../src/core/audit.js';
import { checkKnowledgeConsistency } from '../src/core/consistency.js';
import { rebuildRetrievalIndex } from '../src/core/retrieval.js';
import { loadReviewState, markReviewed, saveReviewState } from '../src/core/review.js';

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-reconcile-'));
  tempRoots.push(root);
  const agentRoot = path.join(root, '.agent');
  await fs.mkdir(path.join(agentRoot, 'memory', 'candidates'), { recursive: true });
  await fs.mkdir(path.join(agentRoot, 'memory', 'indexes'), { recursive: true });
  await fs.mkdir(path.join(agentRoot, 'business', 'rules'), { recursive: true });
  await fs.mkdir(path.join(agentRoot, 'business', 'relationships'), { recursive: true });
  await fs.mkdir(path.join(agentRoot, 'business', 'impact'), { recursive: true });
  await fs.writeFile(path.join(agentRoot, 'business-agent.json'), '{}', 'utf8');
  return root;
}

async function writeCandidate(root: string, fileName: string, statusLine: string, title = fileName): Promise<void> {
  const agentRoot = path.join(root, '.agent');
  const body = `# Candidate: ${title}\n${statusLine}\n\n## Entity\nPolicy\n\n## Hypothesis\n- h ${title}\n\n## Evidence\n- src/views/PolicyEdit.vue\n`;
  await fs.writeFile(path.join(agentRoot, 'memory', 'candidates', fileName), body, 'utf8');
}

async function writeManifest(root: string, rules: unknown[]): Promise<void> {
  const agentRoot = path.join(root, '.agent');
  await fs.writeFile(
    path.join(agentRoot, 'memory', 'discovery-manifest.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      projectRoot: root,
      filesScanned: 1,
      entities: [],
      rules,
      relations: [],
      apis: [],
      conflicts: [],
    }),
    'utf8',
  );
}

function candidateRule(id: string, status = 'candidate'): Record<string, unknown> {
  return {
    id,
    name: id,
    entity: 'Policy',
    rule: [`hypothesis for ${id}`],
    confidence: 'low',
    evidence: ['src/views/PolicyEdit.vue'],
    status,
  };
}

function checkById(report: { checks: AuditCheck[] }, id: string): AuditCheck {
  const found = report.checks.find((check) => check.id === id);
  if (!found) throw new Error(`audit check "${id}" missing; got ${report.checks.map((c) => c.id).join(',')}`);
  return found;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('audit candidate reconciliation (P1)', () => {
  it('reports a clean picture when nothing is pending anywhere', async () => {
    const root = await makeRoot();
    await writeManifest(root, []);

    const report = await runAudit(root);
    const check = checkById(report, 'candidates');
    expect(check.status).toBe('ok');
    expect(check.data).toMatchObject({ manifestPending: 0, filePending: 0, fileResolved: 0, reviewResolved: 0 });
  });

  it('flags candidates resolved on disk but missing from review-state', async () => {
    const root = await makeRoot();
    // Legacy flow (or hand edit): file marked rejected, no review-state entry.
    await writeCandidate(root, 'rule.old-reject.md', 'Status: rejected', '旧拒绝');
    await writeManifest(root, []);

    const report = await runAudit(root);
    const check = checkById(report, 'candidates');
    expect(check.status).toBe('warn');
    expect(check.data?.missingFromReview).toBeGreaterThan(0);
    expect(check.message).toMatch(/review-state/);
  });

  it('flags a count mismatch between manifest candidates and candidate files', async () => {
    const root = await makeRoot();
    await writeCandidate(root, 'rule.orphan.md', 'Status: candidate', '清单外候选');
    // Manifest has no rules at all, but the file exists → drift.
    await writeManifest(root, []);

    const report = await runAudit(root);
    const check = checkById(report, 'candidates');
    expect(check.status).toBe('warn');
    expect(check.data?.manifestPending).toBe(0);
    expect(check.data?.filePending).toBe(1);
  });
});

describe('retrieval index candidate filtering (P0-3)', () => {
  it('excludes promoted/rejected candidates but keeps pending and needs-verification ones', async () => {
    const root = await makeRoot();
    // Candidate file names equal safeFileId(rule.id): '.' becomes '-'.
    await writeCandidate(root, 'rule-promoted-x.md', 'Status: promoted as rule.promoted-x', '已晋级');
    await writeCandidate(root, 'rule-rejected-y.md', 'Status: rejected', '已拒绝');
    await writeCandidate(root, 'rule-pending-z.md', 'Status: candidate', '待评审');
    await writeCandidate(root, 'rule-verify-w.md', 'Status: needs-verification', '待补证据');
    await writeManifest(root, [
      candidateRule('rule.promoted-x'),
      candidateRule('rule.rejected-y'),
      candidateRule('rule.pending-z'),
      candidateRule('rule.verify-w'),
    ]);

    const documents = await rebuildRetrievalIndex(root);
    const ruleDocs = documents.filter((doc) => doc.type === 'rule').map((doc) => doc.id);
    expect(ruleDocs).not.toContain('rule.promoted-x');
    expect(ruleDocs).not.toContain('rule.rejected-y');
    expect(ruleDocs).toContain('rule.pending-z');
    expect(ruleDocs).toContain('rule.verify-w');
  });

  it('treats resolved review-state decisions as removed even when the file marker lags', async () => {
    const root = await makeRoot();
    await writeCandidate(root, 'rule-decided.md', 'Status: candidate', 'review 已决但文件未标记');
    await writeManifest(root, [candidateRule('rule.decided')]);
    const state = await loadReviewState(path.join(root, '.agent'));
    markReviewed(
      state,
      {
        id: 'rule.decided',
        name: 'review 已决但文件未标记',
        entity: 'Policy',
        rule: ['h'],
        evidence: [],
        confidence: 'low',
      },
      { decision: 'accepted', slug: 'rule-decided', candidateId: 'rule-decided', status: 'promoted' },
    );
    await saveReviewState(path.join(root, '.agent'), state);

    const documents = await rebuildRetrievalIndex(root);
    expect(documents.filter((doc) => doc.type === 'rule').map((doc) => doc.id)).not.toContain('rule.decided');
  });
});

describe('validate knowledge consistency (P1-4)', () => {
  it('reports missing markdown/impact trio and duplicate ids', async () => {
    const root = await makeRoot();
    const agentRoot = path.join(root, '.agent');
    const rulesDir = path.join(agentRoot, 'business', 'rules');
    // Duplicate id across two JSON files, both missing their markdown + impact map.
    await fs.writeFile(path.join(rulesDir, 'a.json'), JSON.stringify(candidateRule('rule.dup', 'confirmed')), 'utf8');
    await fs.writeFile(path.join(rulesDir, 'b.json'), JSON.stringify(candidateRule('rule.dup', 'confirmed')), 'utf8');
    await fs.writeFile(
      path.join(agentRoot, 'business', 'INDEX.md'),
      '# Business Knowledge Index\n\n## Rules\n- [a](./rules/a.md)\n\n## Impact Maps\n- [x](./impact/x.md)\n',
      'utf8',
    );

    const report = await checkKnowledgeConsistency(agentRoot);
    expect(report.duplicateIds).toEqual(['rule.dup']);
    const a = report.rules.find((rule) => rule.file.endsWith('a.json'));
    expect(a?.markdownExists).toBe(false);
    expect(a?.impactExists).toBe(false);
    expect(a?.problems).toContain('规则 Markdown 缺失');
    expect(a?.problems).toContain('impact map 缺失');
    expect(report.indexBrokenLinks).toContain('impact/x.md');
    expect(report.healthy).toBe(false);
  });

  it('passes for a complete and indexed rule trio', async () => {
    const root = await makeRoot();
    const agentRoot = path.join(root, '.agent');
    await fs.writeFile(
      path.join(agentRoot, 'business', 'rules', 'ok.json'),
      JSON.stringify(candidateRule('rule.ok', 'confirmed')),
      'utf8',
    );
    await fs.writeFile(path.join(agentRoot, 'business', 'rules', 'ok.md'), '# ok rule\n', 'utf8');
    await fs.writeFile(path.join(agentRoot, 'business', 'impact', 'ok.md'), '# Impact\n', 'utf8');
    await fs.writeFile(
      path.join(agentRoot, 'business', 'INDEX.md'),
      '# Index\n\n## Rules\n- [ok](./rules/ok.md)\n\n## Impact Maps\n- [ok](./impact/ok.md)\n',
      'utf8',
    );

    const report = await checkKnowledgeConsistency(agentRoot);
    expect(report.duplicateIds).toEqual([]);
    expect(report.indexBrokenLinks).toEqual([]);
    expect(report.rules[0].problems).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it('lists candidates whose status marker is not recognized', async () => {
    const root = await makeRoot();
    await writeCandidate(root, 'rule.weird.md', 'Status: mystery-state', '未知状态');
    const report = await checkKnowledgeConsistency(path.join(root, '.agent'));
    expect(report.unknownCandidateStatuses).toContain('rule.weird.md');
    expect(report.healthy).toBe(false);
  });
});
