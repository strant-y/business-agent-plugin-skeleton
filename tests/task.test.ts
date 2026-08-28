import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { taskCommand } from '../src/commands/task.js';
import type { ImpactReport } from '../src/core/impact.js';
import {
  checkpointTask,
  computeAccuracy,
  finishTask,
  loadTaskSession,
  predictTaskImpact,
  handleTaskEvent,
  recordTaskTest,
  runTaskValidation,
  startTask,
  updateTaskSession,
} from '../src/core/task.js';

const DIFF = `diff --git a/src/stores/orderStore.ts b/src/stores/orderStore.ts
index 1111111..2222222 100644
--- a/src/stores/orderStore.ts
+++ b/src/stores/orderStore.ts
@@ -1,3 +1,3 @@
-export const status = 'AUDIT';
+export const status = 'AUDITING';
`;

async function setup(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-task-'));
  await fs.mkdir(path.join(dir, '.agent/memory/task-history'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.agent/memory/discovery-manifest.json'),
    JSON.stringify({
      entities: [
        { name: 'Order', type: 'business_entity', description: 'Order aggregate', confidence: 'high', evidence: [] },
        {
          name: 'OrderStore',
          type: 'frontend_store',
          description: 'Order state store',
          confidence: 'high',
          evidence: [],
        },
      ],
      rules: [
        {
          id: 'rule.order-locked',
          name: 'Audited orders are locked',
          entity: 'Order',
          rule: ['Audited orders cannot be modified'],
          confidence: 'high',
          evidence: ['src/stores/orderStore.ts'],
          status: 'confirmed',
        },
      ],
      relations: [
        {
          id: 'relation.orderstore-order-uses-entity',
          source: 'OrderStore',
          target: 'Order',
          relationship: 'references',
          subtype: 'store_entity_usage',
          cardinality: 'unknown',
          confidence: 'high',
          evidence: ['src/stores/orderStore.ts'],
        },
        {
          id: 'relation.orderstore-order-api',
          source: 'OrderStore',
          target: 'Order',
          relationship: 'calls',
          subtype: 'api_route_call',
          provenance: 'api_client_module',
          cardinality: 'unknown',
          confidence: 'high',
          evidence: ['src/stores/orderStore.ts'],
        },
      ],
      apis: [
        {
          id: 'api.get-orders',
          method: 'GET',
          path: '/api/orders',
          entity: 'Order',
          kind: 'backend',
          confidence: 'high',
          evidence: ['src/stores/orderStore.ts'],
        },
      ],
      conflicts: [],
      tests: ['tests/stores.test.ts'],
      workflows: [
        {
          id: 'workflow.order',
          name: 'Order frontend flow',
          description: 'Order review flow',
          steps: ['Action: submitOrder', 'State: AUDITING', 'API: /api/orders'],
          status: 'draft',
        },
      ],
    }),
    'utf8',
  );
  await fs.mkdir(path.join(dir, '.agent/business/rules'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.agent/business/rules/rule.order-locked.json'),
    JSON.stringify({
      id: 'rule.order-locked',
      name: 'Audited orders are locked',
      entity: 'Order',
      rule: ['Audited orders cannot be modified'],
      confidence: 'high',
      evidence: ['src/stores/orderStore.ts'],
      status: 'confirmed',
    }),
    'utf8',
  );
  return dir;
}

describe('task lifecycle', () => {
  it('matches relationship hits by source, target and relationship, including duplicates', () => {
    const relation = (source: string, target: string, relationship: string) => ({
      source,
      target,
      relationship,
    });
    const predicted = {
      relations: [relation('A', 'B', 'calls'), relation('A', 'B', 'calls'), relation('A', 'C', 'calls')],
    } as ImpactReport;
    const actual = {
      relations: [relation('A', 'B', 'calls'), relation('A', 'C', 'calls'), relation('A', 'D', 'calls')],
    } as ImpactReport;

    expect(computeAccuracy(predicted, actual).relationships).toEqual([
      { relationship: 'calls', predicted: 3, actual: 3, hits: 2 },
    ]);
  });

  it('persists context, impact prediction, checkpoints, tests and completion', async () => {
    const dir = await setup();
    const started = await startTask(dir, '修改 Order 审核状态');

    expect(started.context.entities.map((entity) => entity.name)).toContain('Order');
    expect(started.context.rules.map((rule) => rule.id)).toContain('rule.order-locked');
    expect(started.context.workflows.map((workflow) => workflow.name)).toContain('Order frontend flow');

    let session = await predictTaskImpact(dir, started.session, ['src/stores/orderStore.ts']);
    expect(session.phase).toBe('before_edit');
    expect(session.predictedFiles).toEqual(['src/stores/orderStore.ts']);
    expect(session.predictedImpact?.rules.map((rule) => rule.id)).toContain('rule.order-locked');

    session = await checkpointTask(dir, { ...session, predictedImpact: session.predictedImpact, diff: DIFF }, [
      'src/stores/orderStore.ts',
    ]);
    expect(session.phase).toBe('after_edit');
    expect(session.actualImpact?.rules.map((rule) => rule.id)).toContain('rule.order-locked');
    expect(session.comparison?.actual).toContain('Order');
    expect(session.comparison?.predictedFindings).toBeDefined();
    expect(session.comparison?.actualFindings).toBeDefined();
    expect(session.comparison?.predictedMappedTests).toBeDefined();
    expect(session.comparison?.actualMappedTests).toBeDefined();
    expect(session.diff).toBeDefined();
    expect(session.accuracy).toBeDefined();

    session = await recordTaskTest(session, { command: 'npm test', passed: true, summary: 'All tests passed' });
    expect(session.tests[0]?.passed).toBe(true);

    session = await finishTask(session, '完成订单审核状态调整', '审核中的订单不能修改');
    session = await finishTask(session, '重复完成不应重复持久化', '审核中的订单不能修改');
    expect(session.status).toBe('completed');
    expect(session.learnedFacts).toContain('审核中的订单不能修改');

    const accuracySummary = JSON.parse(
      await fs.readFile(path.join(dir, '.agent/memory/impact-accuracy.json'), 'utf8'),
    ) as {
      tasks: number;
      averageEntityPrecision: number;
      averageFindingPrecision: number;
      averageMappedTestPrecision: number;
    };
    expect(accuracySummary.tasks).toBe(1);
    expect(accuracySummary.averageEntityPrecision).toBeGreaterThanOrEqual(0);
    expect(accuracySummary.averageFindingPrecision).toBeGreaterThanOrEqual(0);
    expect(accuracySummary.averageMappedTestPrecision).toBeGreaterThanOrEqual(0);

    const loaded = await loadTaskSession(dir, session.sessionId);
    expect(loaded.status).toBe('completed');
    expect(await fs.stat(path.join(dir, '.agent/memory/sessions', `${session.sessionId}.json`))).toBeDefined();
    expect(await fs.stat(path.join(dir, '.agent/business/experiences', `${session.sessionId}.json`))).toBeDefined();
    const candidates = await fs.readdir(path.join(dir, '.agent/memory/candidates'));
    expect(candidates).toHaveLength(1);
  });

  it('deduplicates finishTask side effects under concurrent completion attempts', async () => {
    const dir = await setup();
    const started = await startTask(dir, '并发完成 Order 任务');
    let session = await predictTaskImpact(dir, started.session, ['src/stores/orderStore.ts']);
    session = await checkpointTask(dir, { ...session, predictedImpact: session.predictedImpact, diff: DIFF }, [
      'src/stores/orderStore.ts',
    ]);

    await Promise.all([
      finishTask(session, '第一次完成', 'Order 经验'),
      finishTask(session, '第二次完成', 'Order 经验'),
    ]);

    const completedTasks = JSON.parse(
      await fs.readFile(path.join(dir, '.agent/memory/completed-tasks.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(completedTasks)).toHaveLength(1);

    const candidates = await fs.readdir(path.join(dir, '.agent/memory/candidates'));
    expect(candidates).toHaveLength(1);

    const taskHistory = await fs.readdir(path.join(dir, '.agent/memory/task-history'));
    expect(taskHistory.filter((file) => file === `${session.sessionId}.json`)).toHaveLength(1);

    const experiences = await fs.readdir(path.join(dir, '.agent/business/experiences'));
    expect(experiences.filter((file) => file === `${session.sessionId}.json`)).toHaveLength(1);

    const accuracySummary = JSON.parse(
      await fs.readFile(path.join(dir, '.agent/memory/impact-accuracy.json'), 'utf8'),
    ) as { tasks: number };
    expect(accuracySummary.tasks).toBe(1);
  });

  it('serializes shared persistence across different sessions', async () => {
    const dir = await setup();
    const started1 = await startTask(dir, '并发完成第一个 Order 任务');
    const started2 = await startTask(dir, '并发完成第二个 Order 任务');
    let session1 = await predictTaskImpact(dir, started1.session, ['src/stores/orderStore.ts']);
    let session2 = await predictTaskImpact(dir, started2.session, ['src/stores/orderStore.ts']);
    session1 = await checkpointTask(dir, { ...session1, predictedImpact: session1.predictedImpact, diff: DIFF }, [
      'src/stores/orderStore.ts',
    ]);
    session2 = await checkpointTask(dir, { ...session2, predictedImpact: session2.predictedImpact, diff: DIFF }, [
      'src/stores/orderStore.ts',
    ]);

    await Promise.all([finishTask(session1, '完成第一个任务'), finishTask(session2, '完成第二个任务')]);

    const completedTasks = JSON.parse(
      await fs.readFile(path.join(dir, '.agent/memory/completed-tasks.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(completedTasks).sort()).toEqual([session1.sessionId, session2.sessionId].sort());
    const accuracySummary = JSON.parse(
      await fs.readFile(path.join(dir, '.agent/memory/impact-accuracy.json'), 'utf8'),
    ) as { tasks: number };
    expect(accuracySummary.tasks).toBe(2);
  });

  it('serializes active session updates across concurrent writers', async () => {
    const dir = await setup();
    const startedA = await startTask(dir, '并发 A');
    const startedB = await startTask(dir, '并发 B');

    await Promise.all([
      updateTaskSession(startedA.session, 'before_context', true),
      updateTaskSession(startedB.session, 'before_context', true),
      finishTask(startedA.session, '完成 A'),
    ]);

    const active = JSON.parse(await fs.readFile(path.join(dir, '.agent/memory/active-session.json'), 'utf8')) as {
      sessionId: string;
    };
    expect(active.sessionId).toBe(startedB.session.sessionId);
  });

  it('keeps the newer active session when an older session is updated or finished', async () => {
    const dir = await setup();
    const startedA = await startTask(dir, '完成 A');
    const startedB = await startTask(dir, '完成 B');

    await updateTaskSession(startedA.session, 'before_context', true);
    await finishTask(startedA.session, '完成 A');

    const active = JSON.parse(await fs.readFile(path.join(dir, '.agent/memory/active-session.json'), 'utf8')) as {
      sessionId: string;
    };
    expect(active.sessionId).toBe(startedB.session.sessionId);
    expect((await loadTaskSession(dir)).sessionId).toBe(startedB.session.sessionId);
  });

  it('does not write files for task subcommand dry-runs', async () => {
    const dir = await setup();
    const started = await startTask(dir, 'dry-run Order');
    const trackedFiles = [
      path.join(dir, '.agent/memory/active-session.json'),
      path.join(dir, '.agent/memory/sessions', `${started.session.sessionId}.json`),
    ];
    const before = await Promise.all(
      trackedFiles.map(async (file) => [file, await fs.readFile(file, 'utf8')] as const),
    );

    await taskCommand(dir, 'context', [], { dryRun: true });
    await taskCommand(dir, 'predict-impact', [], { dryRun: true });
    await taskCommand(dir, 'checkpoint', [], { dryRun: true });
    await taskCommand(dir, 'test', [], { dryRun: true, command: 'node -e "process.exit(0)"' });

    const after = await Promise.all(trackedFiles.map(async (file) => [file, await fs.readFile(file, 'utf8')] as const));
    expect(after).toEqual(before);
    await expect(fs.access(path.join(dir, '.agent/memory/impact-accuracy.json'))).rejects.toThrow();
  });

  it('does not remove a newly-created lock while metadata is initializing', async () => {
    const dir = await setup();
    const started = await startTask(dir, '初始化完成锁');
    const lockDir = path.join(dir, '.agent/memory/completed-task-locks', started.session.sessionId);
    await fs.mkdir(lockDir, { recursive: true });

    const finished = await finishTask(started.session, '锁初始化窗口');
    expect(finished.status).toBe('completed');
    await expect(fs.readFile(path.join(dir, '.agent/memory/completed-tasks.json'), 'utf8')).rejects.toThrow();
    await fs.rm(lockDir, { recursive: true, force: true });
  });

  it('recovers expired completed-task locks without breaking dedupe', async () => {
    const dir = await setup();
    const started = await startTask(dir, '恢复完成锁');
    let session = await predictTaskImpact(dir, started.session, ['src/stores/orderStore.ts']);
    session = await checkpointTask(dir, { ...session, predictedImpact: session.predictedImpact, diff: DIFF }, [
      'src/stores/orderStore.ts',
    ]);

    const lockDir = path.join(dir, '.agent/memory/completed-task-locks', session.sessionId);
    await fs.mkdir(lockDir, { recursive: true });
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    await fs.writeFile(
      path.join(lockDir, 'lock.json'),
      JSON.stringify({
        sessionId: session.sessionId,
        owner: 'stale-owner',
        acquiredAt: expiredAt,
        updatedAt: expiredAt,
        expiresAt: expiredAt,
      }),
      'utf8',
    );

    const finished = await finishTask(session, '恢复完成锁后完成', 'Order 经验');
    expect(finished.status).toBe('completed');

    const completedTasks = JSON.parse(
      await fs.readFile(path.join(dir, '.agent/memory/completed-tasks.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(completedTasks)).toEqual([session.sessionId]);
    await expect(fs.readFile(path.join(lockDir, 'lock.json'), 'utf8')).rejects.toThrow();
  });

  it('accumulates persisted accuracy across tasks', async () => {
    const dir = await setup();

    const started1 = await startTask(dir, '第一次修改 Order');
    let session1 = await predictTaskImpact(dir, started1.session, ['src/stores/orderStore.ts']);
    session1 = await checkpointTask(dir, { ...session1, predictedImpact: session1.predictedImpact, diff: DIFF }, [
      'src/stores/orderStore.ts',
    ]);
    await finishTask(session1, '完成第一次任务');

    const started2 = await startTask(dir, '第二次修改 Order');
    let session2 = await predictTaskImpact(dir, started2.session, ['src/stores/orderStore.ts']);
    session2 = await checkpointTask(dir, { ...session2, predictedImpact: session2.predictedImpact, diff: DIFF }, [
      'src/stores/orderStore.ts',
    ]);
    await finishTask(session2, '完成第二次任务');

    const accuracySummary = JSON.parse(
      await fs.readFile(path.join(dir, '.agent/memory/impact-accuracy.json'), 'utf8'),
    ) as {
      tasks: number;
      averageEntityPrecision: number;
      averageEntityRecall: number;
      averageFindingPrecision: number;
      averageFindingRecall: number;
    };
    expect(accuracySummary.tasks).toBe(2);
    expect(accuracySummary.averageEntityPrecision).toBeGreaterThanOrEqual(0);
    expect(accuracySummary.averageEntityRecall).toBeGreaterThanOrEqual(0);
    expect(accuracySummary.averageFindingPrecision).toBeGreaterThanOrEqual(0);
    expect(accuracySummary.averageFindingRecall).toBeGreaterThanOrEqual(0);
  });

  it('supports one-call lifecycle events and runs validation commands', async () => {
    const dir = await setup();
    const started = await handleTaskEvent(
      {
        taskId: 'task-1',
        phase: 'before_task',
        task: '修改 Order',
        timestamp: new Date().toISOString(),
      },
      dir,
    );
    expect(started.context?.entities.map((entity) => entity.name)).toContain('Order');

    const validated = await runTaskValidation(started.session, ['node -e "process.exit(0)"']);
    expect(validated.tests[0]?.passed).toBe(true);

    const completed = await handleTaskEvent(
      {
        taskId: 'task-1',
        sessionId: started.session.sessionId,
        phase: 'after_task',
        task: '完成 Order 修改',
        learnedFacts: ['Order 审核状态需要保护'],
        timestamp: new Date().toISOString(),
      },
      dir,
    );
    expect(completed.session.status).toBe('completed');
    expect(completed.experience?.testsRun).toHaveLength(1);
  });

  it('accepts lifecycle events through the task command', async () => {
    const dir = await setup();
    let output = '';
    const original = console.log;
    console.log = (value: string) => {
      output += value;
    };
    try {
      await taskCommand(dir, 'event', [], {
        json: true,
        event: JSON.stringify({
          eventId: 'cli-event-1',
          taskId: 'cli-task-1',
          phase: 'before_task',
          task: '通过 CLI 启动 Order 任务',
        }),
      });
    } finally {
      console.log = original;
    }
    const result = JSON.parse(output) as { eventId: string; session: { status: string } };
    expect(result.eventId).toBe('cli-event-1');
    expect(result.session.status).toBe('active');
    expect(await fs.stat(path.join(dir, '.agent/memory/events/cli-event-1.json'))).toBeDefined();
  });
});