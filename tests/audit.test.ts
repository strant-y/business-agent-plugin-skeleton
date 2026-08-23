import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAudit } from '../src/core/audit.js';
import type { DiscoverManifest } from '../src/core/types.js';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ba-audit-'));
}

function manifest(overrides: Partial<DiscoverManifest> = {}): DiscoverManifest {
  return {
    generatedAt: new Date().toISOString(),
    projectRoot: '.',
    filesScanned: 10,
    entities: [
      {
        id: 'entity.order',
        name: 'Order',
        type: 'business_entity',
        description: '订单',
        confidence: 'high',
        evidence: ['src/Order.ts'],
      },
    ],
    rules: [
      {
        id: 'rule.audit-locked',
        name: '审核中订单锁定',
        entity: 'Order',
        rule: ['审核中的订单不能修改'],
        confidence: 'high',
        evidence: ['src/Order.ts:1'],
        status: 'confirmed',
      },
    ],
    relations: [],
    apis: [],
    conflicts: [],
    ...overrides,
  };
}

async function writeJson(root: string, relative: string, value: unknown): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

describe('runAudit', () => {
  it('flags an uninitialized project', async () => {
    const root = await tempRoot();
    const report = await runAudit(root);
    expect(report.healthy).toBe(false);
    expect(report.issues).toBeGreaterThan(0);
    expect(report.checks.find((check) => check.id === 'init')?.status).toBe('error');
  });

  it('reports pending low-confidence candidates and stale knowledge', async () => {
    const root = await tempRoot();
    await writeJson(root, '.agent/business-agent.json', {});
    await writeJson(root, '.agent/memory/discovery-manifest.json', {
      ...manifest({
        rules: [
          ...manifest().rules,
          {
            id: 'rule.noise',
            name: '噪声候选',
            entity: 'Order',
            rule: ['前端交互限制'],
            confidence: 'low',
            evidence: ['src/Order.vue:5'],
            status: 'candidate',
          },
        ],
      }),
    });
    await writeJson(root, '.agent/memory/knowledge-state.json', {
      'rule.audit-locked': {
        id: 'rule.audit-locked',
        type: 'rule',
        subject: 'Order',
        claim: '审核中的订单不能修改',
        confidence: 'high',
        confidenceScore: 0.9,
        status: 'stale',
        source: 'human-confirmed',
        evidence: [],
        relatedTasks: [],
        version: 2,
        firstSeenAt: new Date().toISOString(),
      },
    });
    await writeJson(root, '.agent/memory/hook-errors.log', '2026-08-18T09:00:00Z business-agent capture failed\n');

    const report = await runAudit(root);
    const noise = report.checks.find((check) => check.id === 'noise');
    const knowledge = report.checks.find((check) => check.id === 'knowledge-state');
    const hook = report.checks.find((check) => check.id === 'hook');

    expect(noise?.status).toBe('warn');
    expect(noise?.message).toContain('低置信度');
    expect(knowledge?.status).toBe('warn');
    expect(knowledge?.message).toContain('stale');
    expect(hook?.status).toBe('warn');
    expect(hook?.message).toContain('失败');
  });

  it('flags missing evidence files for confirmed rules', async () => {
    const root = await tempRoot();
    await writeJson(root, '.agent/business-agent.json', {});
    await writeJson(root, '.agent/memory/discovery-manifest.json', manifest());

    const report = await runAudit(root);
    const evidence = report.checks.find((check) => check.id === 'evidence');
    expect(evidence?.status).toBe('error');
    expect(evidence?.message).toContain('证据文件缺失');
  });

  it('warns when knowledge-state evidence has drifted', async () => {
    const root = await tempRoot();
    await writeJson(root, '.agent/business-agent.json', {});
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/Order.ts'), 'export class Order {}\n', 'utf8');
    await writeJson(root, '.agent/memory/discovery-manifest.json', manifest());
    await writeJson(root, '.agent/memory/knowledge-state.json', {
      'rule.audit-locked': {
        id: 'rule.audit-locked',
        type: 'rule',
        subject: 'Order',
        claim: '审核中的订单不能修改',
        confidence: 'high',
        confidenceScore: 0.9,
        status: 'confirmed',
        source: 'human-confirmed',
        evidence: [
          {
            id: 'evidence-order',
            kind: 'source',
            file: 'src/Order.ts',
            snippet: 'class MissingOrder',
            capturedAt: new Date().toISOString(),
          },
        ],
        relatedTasks: [],
        version: 1,
        firstSeenAt: new Date().toISOString(),
      },
    });

    const report = await runAudit(root);
    const drift = report.checks.find((check) => check.id === 'knowledge-evidence-drift');
    expect(drift?.status).toBe('warn');
    expect(drift?.message).toContain('证据漂移');
  });

  it('passes knowledge evidence drift when snippets remain valid', async () => {
    const root = await tempRoot();
    await writeJson(root, '.agent/business-agent.json', {});
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/Order.ts'), 'export class Order {}\n', 'utf8');
    await writeJson(root, '.agent/memory/discovery-manifest.json', manifest());
    await writeJson(root, '.agent/memory/indexes/retrieval-index.json', []);

    const report = await runAudit(root);
    expect(report.healthy).toBe(true);
    expect(report.issues).toBe(0);
    expect(report.checks.find((check) => check.id === 'evidence')?.status).toBe('ok');
    expect(report.checks.find((check) => check.id === 'hook')?.status).toBe('warn');
    expect(report.checks.find((check) => check.id === 'schema')?.status).toBe('ok');
  });

  it('detects a business-agent hook that was overwritten by another tool', async () => {
    const root = await tempRoot();
    await writeJson(root, '.agent/business-agent.json', {});
    await fs.mkdir(path.join(root, '.git/hooks'), { recursive: true });
    await fs.writeFile(path.join(root, '.git/hooks/post-commit'), '#!/bin/sh\n# husky\n', 'utf8');

    const report = await runAudit(root);
    const hook = report.checks.find((check) => check.id === 'hook');
    expect(hook?.status).toBe('warn');
    expect(hook?.message).toContain('不含 business-agent');
  });

  it('reports unfinished task sessions', async () => {
    const root = await tempRoot();
    await writeJson(root, '.agent/business-agent.json', {});
    await writeJson(root, '.agent/memory/active-session.json', {
      taskId: 'task-1',
      sessionId: 'session-1',
      task: '修改订单审核流程',
      status: 'active',
    });

    const report = await runAudit(root);
    const sessions = report.checks.find((check) => check.id === 'sessions');
    expect(sessions?.status).toBe('warn');
    expect(sessions?.message).toContain('未收尾');
  });
});
