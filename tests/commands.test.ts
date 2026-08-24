import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initCommand } from '../src/commands/init.js';
import { evolveCommand } from '../src/commands/evolve.js';
import { promoteCommand } from '../src/commands/promote.js';
import { contextCommand } from '../src/commands/context.js';
import { validateCommand } from '../src/commands/validate.js';
import { discoverCommand } from '../src/commands/discover.js';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ba-cmd-'));
}

describe('initCommand', () => {
  it('creates the .agent structure', async () => {
    const dir = await tempRoot();
    await initCommand(dir);
    expect(await fs.stat(path.join(dir, '.agent/HARNESS.md'))).toBeDefined();
    expect(await fs.stat(path.join(dir, '.agent/business-agent.json'))).toBeDefined();
    expect(await fs.stat(path.join(dir, '.agent/business/entities'))).toBeDefined();
    expect(await fs.stat(path.join(dir, '.agent/memory/candidates'))).toBeDefined();
  });

  it('keeps an existing .agent unless --force is used', async () => {
    const dir = await tempRoot();
    await initCommand(dir);
    const marker = path.join(dir, '.agent/marker.txt');
    await fs.writeFile(marker, 'user data', 'utf8');

    await initCommand(dir);
    expect(await fs.readFile(marker, 'utf8')).toBe('user data');

    await fs.rm(path.join(dir, '.agent/HARNESS.md'));
    await initCommand(dir, { force: true });
    expect(await fs.stat(path.join(dir, '.agent/HARNESS.md'))).toBeDefined();
    expect(await fs.readFile(marker, 'utf8')).toBe('user data');
  });
});

describe('evolveCommand', () => {
  it('creates a candidate file with Hypothesis/Evidence/Impact/Verification sections', async () => {
    const dir = await tempRoot();
    await evolveCommand(dir, 'Under audit, orders are locked');
    const file = path.join(dir, '.agent/memory/candidates/under-audit-orders-are-locked.md');
    const content = await fs.readFile(file, 'utf8');
    expect(content).toContain('# Candidate: Under audit, orders are locked');
    expect(content).toContain('## Hypothesis');
    expect(content).toContain('## Evidence');
    expect(content).toContain('## Impact');
    expect(content).toContain('## Verification');
  });

  it('does not write anything with --dry-run', async () => {
    const dir = await tempRoot();
    await evolveCommand(dir, 'Dry run candidate', { dryRun: true });
    const candidatesDir = path.join(dir, '.agent/memory/candidates');
    await expect(fs.readdir(candidatesDir)).rejects.toThrow();
  });
});

describe('promoteCommand', () => {
  it('promotes a candidate rule, validates it and marks the candidate promoted', async () => {
    const dir = await tempRoot();
    await evolveCommand(dir, 'Audited orders cannot be edited');
    const candidateFile = path.join(dir, '.agent/memory/candidates/audited-orders-cannot-be-edited.md');

    await promoteCommand(dir, 'audited-orders-cannot-be-edited', { entity: 'Order' });

    const ruleFile = path.join(dir, '.agent/business/rules/rule-audited-orders-cannot-be-edited.json');
    const rule = JSON.parse(await fs.readFile(ruleFile, 'utf8'));
    expect(rule.status).toBe('confirmed');
    expect(rule.entity).toBe('Order');

    const marked = await fs.readFile(candidateFile, 'utf8');
    expect(marked).toContain('Status: promoted as rule.audited-orders-cannot-be-edited');
  });

  it('uses the Entity section of the candidate when --entity is not given', async () => {
    const dir = await tempRoot();
    await evolveCommand(dir, 'Draft plans are mutable');
    const candidateFile = path.join(dir, '.agent/memory/candidates/draft-plans-are-mutable.md');
    const content = await fs.readFile(candidateFile, 'utf8');
    await fs.writeFile(candidateFile, content.replace('## Hypothesis', '## Entity\nPlan\n\n## Hypothesis'), 'utf8');

    await promoteCommand(dir, 'draft-plans-are-mutable');

    const rule = JSON.parse(
      await fs.readFile(path.join(dir, '.agent/business/rules/rule-draft-plans-are-mutable.json'), 'utf8'),
    );
    expect(rule.entity).toBe('Plan');
  });

  it('rejects an invalid cardinality', async () => {
    const dir = await tempRoot();
    await expect(
      promoteCommand(dir, 'x', { type: 'relation', source: 'A', target: 'B', cardinality: 'banana' }),
    ).rejects.toThrow(/--cardinality/);
  });

  it('warns when a candidate was already promoted', async () => {
    const dir = await tempRoot();
    await evolveCommand(dir, 'Warned twice rule');
    await promoteCommand(dir, 'warned-twice-rule', { entity: 'Order' });

    let warning = '';
    const original = console.warn;
    console.warn = (s: string) => {
      warning += s;
    };
    try {
      await promoteCommand(dir, 'warned-twice-rule', { entity: 'Order' });
    } finally {
      console.warn = original;
    }
    expect(warning).toContain('already promoted');
  });

  it('does not write files with --dry-run', async () => {
    const dir = await tempRoot();
    await evolveCommand(dir, 'Dry promoted rule');
    await promoteCommand(dir, 'dry-promoted-rule', { entity: 'Order', dryRun: true });
    await expect(fs.readdir(path.join(dir, '.agent/business/rules'))).rejects.toThrow();
  });
});

describe('contextCommand', () => {
  async function setupContextProject(): Promise<string> {
    const dir = await tempRoot();
    const agentRoot = path.join(dir, '.agent');
    await fs.mkdir(path.join(agentRoot, 'memory'), { recursive: true });
    await fs.mkdir(path.join(agentRoot, 'business/rules'), { recursive: true });
    await fs.mkdir(path.join(agentRoot, 'business/relationships'), { recursive: true });
    await fs.mkdir(path.join(agentRoot, 'business/impact'), { recursive: true });

    await fs.writeFile(path.join(agentRoot, 'business/INDEX.md'), '# Business Index\n', 'utf8');
    await fs.writeFile(
      path.join(agentRoot, 'memory/discovery-manifest.json'),
      JSON.stringify({
        entities: [
          { name: 'Order', description: 'A purchase', confidence: 'high' },
          { name: 'Customer', description: 'A buyer', confidence: 'low' },
        ],
        rules: [
          {
            id: 'rule.order-a',
            name: 'Order rule',
            entity: 'Order',
            evidence: [
              {
                id: 'e-order-a',
                kind: 'source',
                capturedAt: '2026-08-20T00:00:00.000Z',
                file: 'src/order.ts',
                lineStart: 1,
              },
            ],
          },
        ],
        relations: [
          {
            id: 'relation.order-page',
            source: 'module:src/views/orderlist.vue',
            target: 'Order',
            relationship: 'renders',
            cardinality: '1:N',
            confidence: 'medium',
            evidence: ['src/views/OrderList.vue'],
          },
        ],
        aliases: { Order: ['订单', 'OrderDTO'] },
        apis: [
          {
            id: 'api.get-orders',
            method: 'GET',
            path: '/api/orders',
            entity: 'Order',
            kind: 'backend',
            confidence: 'low',
            evidence: [],
          },
        ],
        conflicts: [
          {
            id: 'conflict.a-vs-b',
            ruleA: 'rule.a',
            ruleB: 'rule.b',
            entity: 'Order',
            description: 'Opposing constraints',
            confidence: 'low',
            evidence: [],
          },
        ],
      }),
      'utf8',
    );

    await fs.writeFile(
      path.join(agentRoot, 'business/rules/rule.order-a.json'),
      JSON.stringify({
        id: 'rule.order-a',
        name: 'Order rule',
        entity: 'Order',
        rule: ['orders are locked under audit'],
        confidence: 'low',
        evidence: [
          {
            id: 'e-order-a',
            kind: 'source',
            capturedAt: '2026-08-20T00:00:00.000Z',
            file: 'src/order.ts',
            lineStart: 1,
          },
        ],
        status: 'confirmed',
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(agentRoot, 'business/rules/rule.customer-b.json'),
      JSON.stringify({
        id: 'rule.customer-b',
        name: 'Customer rule',
        entity: 'Customer',
        rule: ['customers need consent'],
        confidence: 'low',
        evidence: [
          {
            id: 'e-customer-b',
            kind: 'source',
            capturedAt: '2026-08-20T00:00:00.000Z',
            file: 'src/customer.ts',
            lineStart: 1,
          },
        ],
        status: 'confirmed',
      }),
      'utf8',
    );
    await fs.writeFile(path.join(agentRoot, 'business/impact/rule-order-a.md'), '# Impact Map: Order rule\n', 'utf8');
    await fs.writeFile(
      path.join(agentRoot, 'business/impact/rule-customer-b.md'),
      '# Impact Map: Customer rule\n',
      'utf8',
    );
    return dir;
  }

  it('filters rules, conflicts, apis and impact maps by subject', async () => {
    const dir = await setupContextProject();
    await contextCommand(dir, 'Order');

    const content = await fs.readFile(path.join(dir, '.agent/memory/active-context.md'), 'utf8');
    expect(content).toContain('Order rule');
    expect(content).not.toContain('Customer rule');
    expect(content).toContain('rule.a vs rule.b');
    expect(content).toContain('GET /api/orders');
    expect(content).toContain('rule-order-a.md');
    expect(content).not.toContain('rule-customer-b.md');
    expect(content).toContain('```mermaid');
    expect(content).toContain('graph LR');
    expect(content).toContain('module_src_views_orderlist_vue -->|renders/1:N| Order');
    expect(content).not.toContain('|renders/unknown|');
  });

  it('supports glossary aliases when filtering business context', async () => {
    const dir = await setupContextProject();
    await contextCommand(dir, '订单');

    const content = await fs.readFile(path.join(dir, '.agent/memory/active-context.md'), 'utf8');
    expect(content).toContain('Order rule');
    expect(content).toContain('[aliases: 订单, OrderDTO]');
  });

  it('emits machine-readable output with --json', async () => {
    const dir = await setupContextProject();
    let output = '';
    const original = console.log;
    console.log = (s: string) => {
      output += s;
    };
    try {
      await contextCommand(dir, 'Order', { json: true });
    } finally {
      console.log = original;
    }
    const parsed = JSON.parse(output) as { rules: Array<{ name: string }>; conflicts: Array<{ id: string }> };
    expect(parsed.rules.map((r) => r.name)).toEqual(['Order rule']);
    expect(parsed.conflicts.map((c) => c.id)).toEqual(['conflict.a-vs-b']);
  });
});

describe('discoverCommand', () => {
  it('treats --deep as additive on top of default analyzers', async () => {
    const dir = await tempRoot();
    const logs: string[] = [];
    const original = console.log;
    console.log = (message: string) => {
      logs.push(message);
    };
    try {
      await discoverCommand(dir, { deep: true, dryRun: true });
    } finally {
      console.log = original;
    }
    expect(logs.some((line) => line.startsWith('Scanned '))).toBe(true);
  });
});

describe('validateCommand', () => {
  it('validates both the manifest and confirmed knowledge files', async () => {
    const dir = await tempRoot();
    const agentRoot = path.join(dir, '.agent');
    await fs.mkdir(path.join(agentRoot, 'memory'), { recursive: true });
    await fs.mkdir(path.join(agentRoot, 'business/rules'), { recursive: true });
    await fs.writeFile(
      path.join(agentRoot, 'memory/discovery-manifest.json'),
      JSON.stringify({
        entities: [],
        rules: [],
        relations: [],
        apis: [],
        conflicts: [],
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(agentRoot, 'business/rules/bad.json'),
      JSON.stringify({
        id: 'rule.bad',
        name: 'Bad',
        entity: 'Plan',
        rule: ['x'],
        confidence: 'certain',
        evidence: [],
      }),
      'utf8',
    );

    const previousExitCode = process.exitCode;
    try {
      await validateCommand(dir, { json: true });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
