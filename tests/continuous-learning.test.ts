import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { continuousLearningCommand } from '../src/commands/continuous-learning.js';
import { dispatchLifecycleEvent, loadEventResult } from '../src/core/lifecycle.js';
import { normalizeEvidence } from '../src/core/evidence.js';
import {
  loadKnowledgeState,
  loadKnowledgeStateEvent,
  transitionKnowledge,
  type KnowledgeRecord,
} from '../src/core/knowledge-state.js';
import { recordFeedback } from '../src/core/feedback.js';
import { rebuildRetrievalIndex, retrieveTaskContext } from '../src/core/retrieval.js';
import { startTask } from '../src/core/task.js';

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ba-learning-'));
  await fs.mkdir(path.join(dir, '.agent/memory'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.agent/memory/discovery-manifest.json'),
    JSON.stringify({
      entities: [
        {
          id: 'order',
          name: 'Order',
          type: 'business_entity',
          description: 'Order aggregate',
          confidence: 'high',
          evidence: ['src/order.ts:2'],
        },
      ],
      rules: [
        {
          id: 'k1',
          name: 'Order is auditable',
          entity: 'Order',
          rule: ['Order is auditable'],
          confidence: 'medium',
          evidence: ['src/order.ts:2'],
          status: 'candidate',
        },
      ],
      relations: [],
      workflows: [],
      generatedAt: new Date().toISOString(),
      projectRoot: dir,
      filesScanned: 1,
    }),
  );
  await fs.writeFile(
    path.join(dir, '.agent/memory/knowledge-state.json'),
    JSON.stringify({
      k1: {
        id: 'k1',
        type: 'rule',
        subject: 'Order',
        claim: 'Order is auditable',
        confidence: 'medium',
        confidenceScore: 0.5,
        status: 'candidate',
        source: 'static-analysis',
        evidence: [],
        relatedTasks: [],
        version: 1,
        firstSeenAt: new Date().toISOString(),
      },
    }),
  );
  await fs.mkdir(path.join(dir, '.agent/memory/task-history'), { recursive: true });
  return dir;
}

describe('continuous learning primitives', () => {
  it('normalizes legacy evidence and dispatches an idempotent event', async () => {
    const dir = await root();
    expect(normalizeEvidence('src/order.ts:2')[0]?.lineStart).toBe(2);
    const event = {
      eventId: 'event 1',
      taskId: 'task-1',
      phase: 'before_task' as const,
      task: 'modify Order',
      root: dir,
      source: 'api' as const,
      timestamp: new Date().toISOString(),
    };
    const first = await dispatchLifecycleEvent(event);
    const second = await dispatchLifecycleEvent(event);
    expect(second.eventId).toBe('event-1');
    expect(second.session.sessionId).toBe(first.session.sessionId);
    expect(await fs.readdir(path.join(dir, '.agent/memory/events'))).toHaveLength(1);
  });

  it('rejects non-expired lifecycle locks', async () => {
    const dir = await root();
    const eventId = 'locked event';
    const safeEventId = 'locked-event';
    const lockDir = path.join(dir, '.agent/memory/event-locks', safeEventId);
    await fs.mkdir(lockDir, { recursive: true });
    const now = new Date();
    await fs.writeFile(
      path.join(lockDir, 'lock.json'),
      JSON.stringify({
        eventId: safeEventId,
        owner: 'existing-owner',
        status: 'processing',
        acquiredAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }),
      'utf8',
    );

    await expect(
      dispatchLifecycleEvent({
        eventId,
        taskId: 'task-1',
        phase: 'before_task',
        task: 'modify Order',
        root: dir,
        source: 'api',
        timestamp: new Date().toISOString(),
      }),
    ).rejects.toThrow('Lifecycle event is already processing: locked-event');
  });

  it('recovers expired lifecycle locks and replaces damaged metadata', async () => {
    const dir = await root();
    const eventId = 'expired event';
    const safeEventId = 'expired-event';
    const lockDir = path.join(dir, '.agent/memory/event-locks', safeEventId);
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(path.join(lockDir, 'lock.json'), '{"broken":true', 'utf8');

    const result = await dispatchLifecycleEvent({
      eventId,
      taskId: 'task-1',
      phase: 'before_task',
      task: 'modify Order',
      root: dir,
      source: 'api',
      timestamp: new Date().toISOString(),
    });

    expect(result.eventId).toBe(safeEventId);
    expect(await loadEventResult(dir, safeEventId)).toBeDefined();
    await expect(fs.stat(lockDir)).rejects.toThrow();
  });

  it('does not cache failed lifecycle events and allows retry with the same event id', async () => {
    const dir = await root();
    const event = {
      eventId: 'retry me',
      taskId: 'task-1',
      sessionId: 'missing',
      phase: 'after_task' as const,
      task: 'modify Order',
      root: dir,
      source: 'api' as const,
      timestamp: new Date().toISOString(),
    };

    const first = await dispatchLifecycleEvent(event);
    expect(first.warnings).toHaveLength(1);
    expect(await loadEventResult(dir, 'retry-me')).toBeUndefined();

    const started = await dispatchLifecycleEvent({
      ...event,
      phase: 'before_task',
      sessionId: undefined,
      eventId: 'start me',
    });
    const retried = await dispatchLifecycleEvent({ ...event, sessionId: started.session.sessionId });
    expect(retried.session.status).toBe('completed');
    expect(await loadEventResult(dir, 'retry-me')).toBeDefined();
  });

  it('enforces knowledge transitions, validates active feedback session, and persists status changes', async () => {
    const dir = await root();
    const started = await startTask(dir, 'modify Order');
    const record: KnowledgeRecord = {
      id: 'k1',
      type: 'rule',
      subject: 'Order',
      claim: 'Order is auditable',
      confidence: 'medium',
      confidenceScore: 0.5,
      status: 'candidate',
      source: 'static-analysis',
      evidence: [],
      relatedTasks: [],
      version: 1,
      firstSeenAt: new Date().toISOString(),
    };
    const next = transitionKnowledge(record, {
      id: 'e1',
      recordId: 'k1',
      to: 'confirmed',
      reason: 'accepted',
      evidence: [],
      actor: 'user',
      timestamp: new Date().toISOString(),
      taskId: started.session.taskId,
    });
    expect(next.status).toBe('confirmed');
    await recordFeedback(
      dir,
      { type: 'confirm_rule', targetId: 'k1' },
      started.session.taskId,
      started.session.sessionId,
      'f1',
    );
    const saved = await loadKnowledgeState(dir, 'k1');
    expect(saved?.status).toBe('confirmed');
    await expect(
      recordFeedback(dir, { type: 'confirm_rule', targetId: 'k1' }, 'other-task', 'missing-session', 'f2'),
    ).rejects.toThrow('Task session not found');
  });

  it('does not reapply feedback side effects when the same feedback event is retried', async () => {
    const dir = await root();
    const started = await startTask(dir, 'retry feedback event');

    const first = await recordFeedback(
      dir,
      { type: 'confirm_rule', targetId: 'k1', reason: 'first approval' },
      started.session.taskId,
      started.session.sessionId,
      'retry-feedback',
    );
    const second = await recordFeedback(
      dir,
      { type: 'confirm_rule', targetId: 'k1', reason: 'first approval' },
      started.session.taskId,
      started.session.sessionId,
      'retry-feedback',
    );

    const saved = await loadKnowledgeState(dir, 'k1');
    expect(first.appliedAt).toBeDefined();
    expect(second.appliedAt).toBe(first.appliedAt);
    expect(saved?.status).toBe('confirmed');
    expect(saved?.confidenceScore).toBe(0.6);
    expect(saved?.feedbackNotes).toEqual(['first approval']);
  });

  it('persists knowledge event before state materialization for auditability', async () => {
    const dir = await root();
    const started = await startTask(dir, 'persist feedback event');

    await recordFeedback(
      dir,
      { type: 'confirm_rule', targetId: 'k1', reason: 'audited' },
      started.session.taskId,
      started.session.sessionId,
      'event-order',
    );

    const event = await loadKnowledgeStateEvent(dir, 'state-event-order');
    const saved = await loadKnowledgeState(dir, 'k1');
    expect(event?.to).toBe('confirmed');
    expect(saved?.status).toBe('confirmed');
  });

  it('closes feedback into knowledge status, confidence, and audit notes', async () => {
    const dir = await root();
    const started = await startTask(dir, 'review Order rule feedback');
    await recordFeedback(
      dir,
      { type: 'confirm_rule', targetId: 'k1', reason: 'human review passed' },
      started.session.taskId,
      started.session.sessionId,
      'confirm-feedback',
    );
    const confirmed = await loadKnowledgeState(dir, 'k1');
    expect(confirmed?.status).toBe('confirmed');
    expect(confirmed?.confidenceScore).toBe(0.6);
    expect(confirmed?.feedbackNotes).toContain('human review passed');

    await recordFeedback(
      dir,
      {
        type: 'correct_relation',
        targetId: 'k1',
        correction: 'The audit relation points to Invoice.',
        expectedTarget: 'Invoice',
      },
      started.session.taskId,
      started.session.sessionId,
      'correct-feedback',
    );
    const corrected = await loadKnowledgeState(dir, 'k1');
    expect(corrected?.status).toBe('contradicted');
    expect(corrected?.confidenceScore).toBe(0.45);
    expect(corrected?.feedbackNotes).toContain('The audit relation points to Invoice.');
    expect(corrected?.feedbackNotes).toContain('Invoice');
  });

  it('indexes task history, feedback correction, and stale knowledge for realistic retrieval', async () => {
    const dir = await root();
    const started = await startTask(dir, 'modify Order aggregate pricing pipeline');
    await recordFeedback(
      dir,
      {
        type: 'reject_rule',
        targetId: 'k1',
        correction: 'Order audit review happens before invoice export, not after settlement',
        reason: 'pricing pipeline changed in the latest release',
      },
      started.session.taskId,
      started.session.sessionId,
      'f-correction',
    );
    const knowledgeAfterFeedback = await loadKnowledgeState(dir, 'k1');
    expect(knowledgeAfterFeedback?.status).toBe('candidate');
    await fs.writeFile(
      path.join(dir, '.agent/memory/task-history', `${started.session.sessionId}.json`),
      JSON.stringify({
        taskId: started.session.taskId,
        summary: 'Complete pricing pipeline update',
        intent: started.session.task,
        changedFiles: ['src/order.ts', 'src/pricing.ts'],
        diffSummary: ['+ require audit review before invoice export'],
        affectedEntities: ['Order'],
        affectedRules: ['k1'],
        affectedApis: [],
        affectedWorkflows: [],
        predictedImpact: ['Order'],
        actualImpact: ['Order'],
        suggestedTests: ['npm test -- order'],
        testsRun: [],
        lessons: ['Review the affected business rules before promoting new behavior.'],
        learnedFacts: ['Order aggregate now requires audit review before invoice export'],
        humanCorrections: [],
        createdAt: new Date().toISOString(),
      }),
    );

    await rebuildRetrievalIndex(dir);
    const hits = await retrieveTaskContext(dir, 'order pricing pipeline audit review correction');
    const entityHit = hits.find((hit) => hit.id === 'order');
    const taskHit = hits.find((hit) => hit.id === started.session.taskId && hit.type === 'task');
    const feedbackHit = hits.find((hit) => hit.id === 'f-correction');

    expect(entityHit?.evidence[0]?.file).toBe('src/order.ts');
    expect(taskHit).toBeDefined();
    expect(taskHit?.reasons).toContain('任务经验：历史任务可复用');
    expect(feedbackHit).toBeDefined();
    expect(feedbackHit?.reasons).toContain('反馈修正：存在反馈记录');
    expect(feedbackHit?.warnings).toContain('该结果来自反馈修正记录');
  });

  it('supports new task feedback protocol, legacy ordering, invalid type validation, and knowledge stale --id', async () => {
    const dir = await root();
    await startTask(dir, 'modify Order pricing pipeline');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await continuousLearningCommand(
      dir,
      'feedback',
      ['confirm_rule', 'k1', '--reason', 'manual review', '--correction', 'fixed wording'],
      false,
    );
    await continuousLearningCommand(dir, 'feedback', ['k1', 'reject_rule', 'legacy reason'], false);
    await continuousLearningCommand(dir, 'stale', ['--id', 'k1', '--reason', 'missing evidence'], false);
    await expect(continuousLearningCommand(dir, 'feedback', ['bad_type', 'k1'], false)).rejects.toThrow(
      'Usage: business-agent task feedback <type> <targetId> [--reason <text>] [--correction <text>]',
    );

    const outputs = log.mock.calls.map(([value]) => String(value));
    log.mockRestore();

    expect(outputs[0]).toContain('类型：确认规则 [confirm_rule]');
    expect(outputs[0]).toContain('修正：fixed wording');
    expect(outputs[0]).toContain('原因：manual review');
    expect(outputs[1]).toContain('类型：驳回规则 [reject_rule]');
    expect(outputs[1]).toContain('原因：legacy reason');
    expect(outputs[2]).toContain('知识状态已更新：标记为已过期');
    expect(outputs[2]).toContain('原因：missing evidence');
  });

  it('prints human-readable status, verify, retrieve, and index output while leaving json mode untouched', async () => {
    const dir = await root();
    await startTask(dir, 'modify Order pricing pipeline');
    await rebuildRetrievalIndex(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await continuousLearningCommand(dir, 'status', ['k1'], false);
    await continuousLearningCommand(dir, 'verify', ['k1', '--reason', 'manual review passed'], false);
    await continuousLearningCommand(dir, 'retrieve', ['order', 'audit', 'review'], false);
    await continuousLearningCommand(dir, 'index', [], false);
    await continuousLearningCommand(dir, 'status', ['k1'], true);

    const outputs = log.mock.calls.map(([value]) => String(value));
    log.mockRestore();

    expect(outputs[0]).toContain('知识记录：Order (k1)');
    expect(outputs[0]).toContain('状态：候选 [candidate]');
    expect(outputs[1]).toContain('知识状态已更新：标记为已验证');
    expect(outputs[1]).toContain('原因：manual review passed');
    expect(outputs[2]).toContain('命中理由');
    expect(outputs[2]).toContain('注意事项');
    expect(outputs[3]).toContain('检索索引已重建');
    expect(outputs[3]).toContain('文档总数');
    expect(() => JSON.parse(outputs[4])).not.toThrow();
    expect(JSON.parse(outputs[4]).id).toBe('k1');
    expect(JSON.parse(outputs[4]).status).toBeTypeOf('string');
  });
});
