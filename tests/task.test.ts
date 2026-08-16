import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkpointTask,
  finishTask,
  loadTaskSession,
  predictTaskImpact,
  handleTaskEvent,
  recordTaskTest,
  runTaskValidation,
  startTask,
} from '../src/core/task.js';

async function setup(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-task-'));
  await fs.mkdir(path.join(dir, '.agent/memory/task-history'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.agent/memory/discovery-manifest.json'),
    JSON.stringify({
      entities: [
        { name: 'Order', type: 'business_entity', description: 'Order aggregate', confidence: 'high', evidence: [] },
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
      relations: [],
      apis: [],
      conflicts: [],
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
  it('persists context, impact prediction, checkpoints, tests and completion', async () => {
    const dir = await setup();
    const started = await startTask(dir, '修改 Order 审核状态');

    expect(started.context.entities.map((entity) => entity.name)).toContain('Order');
    expect(started.context.rules.map((rule) => rule.id)).toContain('rule.order-locked');

    let session = await predictTaskImpact(dir, started.session, ['src/stores/orderStore.ts']);
    expect(session.phase).toBe('before_edit');
    expect(session.predictedFiles).toEqual(['src/stores/orderStore.ts']);
    expect(session.predictedImpact?.rules.map((rule) => rule.id)).toContain('rule.order-locked');

    session = await checkpointTask(dir, session, ['src/stores/orderStore.ts']);
    expect(session.phase).toBe('after_edit');
    expect(session.actualImpact?.rules.map((rule) => rule.id)).toContain('rule.order-locked');
    expect(session.comparison?.actual).toContain('Order');
    expect(session.diff).toBeDefined();

    session = await recordTaskTest(session, { command: 'npm test', passed: true, summary: 'All tests passed' });
    expect(session.tests[0]?.passed).toBe(true);

    session = await finishTask(session, '完成订单审核状态调整', '审核中的订单不能修改');
    expect(session.status).toBe('completed');
    expect(session.learnedFacts).toContain('审核中的订单不能修改');

    const loaded = await loadTaskSession(dir, session.sessionId);
    expect(loaded.status).toBe('completed');
    expect(await fs.stat(path.join(dir, '.agent/memory/sessions', `${session.sessionId}.json`))).toBeDefined();
    expect(await fs.stat(path.join(dir, '.agent/business/experiences', `${session.sessionId}.json`))).toBeDefined();
    const candidates = await fs.readdir(path.join(dir, '.agent/memory/candidates'));
    expect(candidates).toHaveLength(1);
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
});
