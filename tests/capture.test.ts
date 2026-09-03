import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureCommand } from '../src/commands/capture.js';
import { hookCommand } from '../src/commands/hook.js';
import { saveKnowledgeRecord, loadKnowledgeState } from '../src/core/knowledge-state.js';
import { readText } from '../src/utils/fs.js';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ba-capture-'));
}

describe('captureCommand', () => {
  it('writes a task-history record and an optional learning candidate', async () => {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, '.agent/memory'), { recursive: true });

    const summary = await captureCommand(dir, {
      files: ['src/views/OrderList.vue'],
      message: 'Fixed the order submission flow',
      learn: '审核中的订单不能修改',
      entity: 'Order',
      quiet: true,
    });

    expect(summary.changedFiles).toEqual(['src/views/OrderList.vue']);
    expect(await fs.readFile(summary.record, 'utf8')).toContain('Fixed the order submission flow');
    expect(path.basename(summary.record)).toMatch(/\.md$/);

    const candidates = await fs.readdir(path.join(dir, '.agent/memory/candidates'));
    expect(candidates.length).toBe(1);
    const candidate = await fs.readFile(path.join(dir, '.agent/memory/candidates', candidates[0]), 'utf8');
    expect(candidate).toContain('# Candidate: 审核中的订单不能修改');
    expect(candidate).toContain('## Entity\nOrder');
    expect(candidate).toContain('src/views/OrderList.vue');
  });

  it('respects --dry-run and writes nothing', async () => {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, '.agent/memory'), { recursive: true });

    const summary = await captureCommand(dir, {
      files: ['src/views/OrderList.vue'],
      learn: 'A fact',
      dryRun: true,
      quiet: true,
    });

    await expect(fs.readdir(path.join(dir, '.agent/memory/task-history'))).rejects.toThrow();
    await expect(fs.readdir(path.join(dir, '.agent/memory/candidates'))).rejects.toThrow();
    expect(summary.record.endsWith('.md')).toBe(true);
  });

  it('refreshes stale knowledge from changed evidence when requested', async () => {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, '.agent/memory'), { recursive: true });
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src/Order.ts'), 'export class OrderUpdated {}\n', 'utf8');
    await saveKnowledgeRecord(dir, {
      id: 'rule.order-lock',
      type: 'rule',
      subject: 'Order',
      claim: 'Order is locked under audit',
      confidence: 'high',
      confidenceScore: 0.9,
      status: 'confirmed',
      source: 'human-confirmed',
      evidence: [
        {
          id: 'e-order-lock',
          kind: 'source',
          file: 'src/Order.ts',
          lineStart: 1,
          snippet: 'export class Order {}',
          capturedAt: new Date().toISOString(),
          strength: 'direct',
        },
      ],
      relatedTasks: [],
      version: 1,
      firstSeenAt: new Date().toISOString(),
    });

    const summary = await captureCommand(dir, {
      files: ['src/Order.ts'],
      refreshKnowledge: true,
      quiet: true,
    });

    expect(summary.refreshedKnowledge).toEqual([
      expect.objectContaining({ recordId: 'rule.order-lock', status: 'stale' }),
    ]);
    const updated = await loadKnowledgeState(dir, 'rule.order-lock');
    expect(updated?.status).toBe('stale');
  });

  it('keeps the discovery manifest intact during knowledge refresh (no incremental overwrite)', async () => {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, '.agent', 'business'), { recursive: true });
    await fs.mkdir(path.join(dir, '.agent', 'memory', 'indexes'), { recursive: true });
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'src', 'Order.ts'),
      'export interface Order { id: string; status: string }\n',
      'utf8',
    );
    // A full manifest with discovered knowledge already exists.
    await fs.writeFile(
      path.join(dir, '.agent', 'memory', 'discovery-manifest.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        projectRoot: dir,
        filesScanned: 1,
        entities: [
          {
            id: 'entity.order',
            name: 'Order',
            type: 'business_entity',
            description: 'Order aggregate',
            confidence: 'high',
            evidence: ['src/Order.ts'],
            attributes: [],
            tags: [],
          },
        ],
        rules: [],
        relations: [],
        apis: [],
        conflicts: [],
        aliases: {},
        aliasIndex: {},
      }),
      'utf8',
    );
    await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(dir, 'docs', 'handover.md'), '# handover note\n', 'utf8');

    // A docs-only change (no scannable source) triggers knowledge refresh but
    // must NOT wipe the manifest — that data loss happened in cip-views when
    // the post-commit hook ran capture --refresh-knowledge after md-only commits.
    const summary = await captureCommand(dir, {
      files: ['docs/handover.md'],
      refreshKnowledge: true,
      quiet: true,
    });

    expect(summary.refreshedKnowledge).toEqual([]);
    const manifest = JSON.parse(await readText(path.join(dir, '.agent', 'memory', 'discovery-manifest.json')));
    expect(manifest.entities.some((entity: { name: string }) => entity.name === 'Order')).toBe(true);
    const retrieval = JSON.parse(await readText(path.join(dir, '.agent', 'memory', 'indexes', 'retrieval-index.json')));
    expect(retrieval.some((doc: { title: string }) => doc.title === 'Order')).toBe(true);
  });

  it('writes a refresh log next to hook-errors.log after a knowledge refresh', async () => {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'src', 'Order.ts'),
      'export interface Order { id: string; status: string }\n',
      'utf8',
    );

    const summary = await captureCommand(dir, {
      files: ['src/Order.ts'],
      refreshKnowledge: true,
      quiet: true,
    });

    expect(summary.knowledgeRefresh?.skipped).toBe(false);
    const logFile = path.join(dir, '.agent', 'memory', 'hook-refresh.log');
    const logLine = (await readText(logFile)).trim().split('\n').at(-1) ?? '';
    expect(JSON.parse(logLine)).toMatchObject({ skipped: false, staleRecords: 0 });
    expect(summary.knowledgeRefresh?.logFile).toBe(logFile);
  });

  it('skips the incremental re-discover when the time budget is already exhausted', async () => {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, '.agent', 'memory'), { recursive: true });
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'Order.ts'), 'export interface Order { id: string }\n', 'utf8');
    await saveKnowledgeRecord(dir, {
      id: 'rule.order-lock',
      type: 'rule',
      subject: 'Order',
      claim: 'Order is locked under audit',
      confidence: 'high',
      confidenceScore: 0.9,
      status: 'confirmed',
      source: 'human-confirmed',
      evidence: [
        {
          id: 'e-order-lock',
          kind: 'source',
          file: 'src/Order.ts',
          lineStart: 1,
          snippet: 'export class Order {}',
          capturedAt: new Date().toISOString(),
          strength: 'direct',
        },
      ],
      relatedTasks: [],
      version: 1,
      firstSeenAt: new Date().toISOString(),
    });

    const summary = await captureCommand(dir, {
      files: ['src/Order.ts'],
      refreshKnowledge: true,
      // Any non-zero elapsed time exceeds a zero budget, so the refresh must be skipped.
      refreshBudgetMs: 0,
      quiet: true,
    });

    expect(summary.knowledgeRefresh?.skipped).toBe(true);
    expect(summary.knowledgeRefresh?.reason).toContain('incremental re-discover skipped');
    expect(summary.refreshedKnowledge).toBeUndefined();
    // The rule keeps its status: skipping the refresh must not silently mark knowledge stale.
    const unchanged = await loadKnowledgeState(dir, 'rule.order-lock');
    expect(unchanged?.status).toBe('confirmed');
    const manifestExists = await fs
      .access(path.join(dir, '.agent', 'memory', 'discovery-manifest.json'))
      .then(() => true)
      .catch(() => false);
    expect(manifestExists).toBe(false);

    const logLine =
      (await readText(path.join(dir, '.agent', 'memory', 'hook-refresh.log'))).trim().split('\n').at(-1) ?? '';
    expect(JSON.parse(logLine)).toMatchObject({ skipped: true, staleRecords: 0 });
  });
});

describe('hookCommand', () => {
  async function gitRoot(): Promise<string> {
    const dir = await tempRoot();
    await fs.mkdir(path.join(dir, '.git'));
    return dir;
  }

  it('installs a post-commit hook, reports already-installed, then removes it', async () => {
    const dir = await gitRoot();
    const hookFile = path.join(dir, '.git/hooks/post-commit');

    await hookCommand(dir, 'install');
    const content = await fs.readFile(hookFile, 'utf8');
    expect(content).toContain('capture --since last-commit --quiet --refresh-knowledge');
    expect(content).toContain(`cd "${dir.replace(/\\/g, '/')}"`);
    expect(content).toContain('hook-errors.log');
    expect(content).toContain('|| true');

    await hookCommand(dir, 'install');
    expect(await fs.readFile(hookFile, 'utf8')).toBe(content);

    await hookCommand(dir, 'remove');
    await expect(fs.readFile(hookFile, 'utf8')).rejects.toThrow();
  });

  it('preserves an existing hook and removes only the business-agent lines', async () => {
    const dir = await gitRoot();
    const hookFile = path.join(dir, '.git/hooks/post-commit');
    await fs.mkdir(path.dirname(hookFile), { recursive: true });
    await fs.writeFile(hookFile, '#!/bin/sh\n# my own hook\n', 'utf8');

    await hookCommand(dir, 'install');
    const combined = await fs.readFile(hookFile, 'utf8');
    expect(combined).toContain('# my own hook');
    expect(combined).toContain('business-agent capture');

    await hookCommand(dir, 'remove');
    const remaining = await fs.readFile(hookFile, 'utf8');
    expect(remaining).toContain('# my own hook');
    expect(remaining).not.toContain('business-agent');
  });

  it('installs the hook into the git root when the project is a subdirectory', async () => {
    const repo = await tempRoot();
    await fs.mkdir(path.join(repo, '.git', 'hooks'), { recursive: true });
    const project = path.join(repo, 'packages', 'app');
    await fs.mkdir(project, { recursive: true });

    await hookCommand(project, 'install');
    const hookFile = path.join(repo, '.git/hooks/post-commit');
    const content = await fs.readFile(hookFile, 'utf8');
    expect(content).toContain(`cd "${project.replace(/\\/g, '/')}"`);
    expect(content).toContain('capture --since last-commit');

    await hookCommand(project, 'remove');
    await expect(fs.readFile(hookFile, 'utf8')).rejects.toThrow();
  });

  it('rejects when the directory is not a git repository', async () => {
    const dir = await tempRoot();
    await expect(hookCommand(dir, 'install')).rejects.toThrow(/Not a git repository/);
  });
});
