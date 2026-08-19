import path from 'node:path';
import { exists, readText, writeJson } from '../utils/fs.js';
import type { EvidenceRef } from './evidence.js';
import {
  loadKnowledgeState,
  loadKnowledgeStateEvent,
  saveKnowledgeRecord,
  updateKnowledgeStatus,
  type KnowledgeStatus,
} from './knowledge-state.js';
import type { KnowledgeRecord } from './knowledge-state.js';

export type FeedbackType =
  | 'accept_impact'
  | 'reject_impact'
  | 'add_missing_impact'
  | 'confirm_rule'
  | 'reject_rule'
  | 'merge_entities'
  | 'split_entities'
  | 'correct_relation'
  | 'mark_stale'
  | 'mark_deprecated';

export interface FeedbackInput {
  type: FeedbackType;
  targetId: string;
  correction?: string;
  expectedTarget?: string;
  evidence?: EvidenceRef[];
  reason?: string;
}

export interface FeedbackRecord extends FeedbackInput {
  id: string;
  taskId: string;
  sessionId: string;
  originalPrediction?: string;
  createdAt: string;
  appliedAt?: string;
}

export interface FeedbackStats {
  total: number;
  accepted: number;
  rejected: number;
  missing: number;
  confidenceAdjustment: number;
}

export async function recordFeedback(
  root: string,
  input: FeedbackInput,
  taskId: string,
  sessionId: string,
  id = `feedback-${Date.now()}`,
): Promise<FeedbackRecord> {
  const file = path.join(root, '.agent', 'memory', 'feedback', `${taskId}-${id}.json`);
  const existing = (await exists(file)) ? (JSON.parse(await readText(file)) as FeedbackRecord) : undefined;
  const record: FeedbackRecord = existing ?? { ...input, id, taskId, sessionId, createdAt: new Date().toISOString() };
  const active = await import('./task.js').then(({ loadTaskSession }) => loadTaskSession(root, sessionId));
  if (active.sessionId !== sessionId || active.status !== 'active')
    throw new Error('Feedback requires the active task session.');

  const transitionId = `state-${id}`;
  const transition = await loadKnowledgeStateEvent(root, transitionId);
  const knowledge = await loadKnowledgeState(root, input.targetId);
  if (knowledge && !record.appliedAt) {
    const to = transition ? transition.to : feedbackStatus(knowledge.status, input.type);
    let updated = knowledge;
    if (to && to !== knowledge.status && !transition) {
      updated = await updateKnowledgeStatus(root, knowledge, {
        id: transitionId,
        recordId: knowledge.id,
        to,
        reason: input.reason ?? input.type,
        evidence: input.evidence ?? [],
        taskId,
        actor: 'user',
        timestamp: record.createdAt,
      });
    } else if (transition) {
      updated = (await loadKnowledgeState(root, input.targetId)) ?? knowledge;
    }
    await saveKnowledgeRecord(root, applyFeedback(updated, input), updated.version);
    record.appliedAt = new Date().toISOString();
  }

  await writeJson(file, record);
  return record;
}

function feedbackStatus(status: KnowledgeStatus, type: FeedbackType): KnowledgeStatus | undefined {
  if (type === 'mark_stale') return status === 'deprecated' ? undefined : 'stale';
  if (type === 'mark_deprecated') return status === 'deprecated' ? undefined : 'deprecated';
  if (type === 'confirm_rule' || type === 'accept_impact') {
    if (status === 'candidate') return 'confirmed';
    if (status === 'corroborated') return 'confirmed';
    if (status === 'stale') return 'verified';
  }
  if (type === 'reject_rule' || type === 'reject_impact' || type === 'correct_relation') {
    if (status === 'confirmed' || status === 'verified') return 'contradicted';
  }
  return undefined;
}

function confidenceAdjustment(type: FeedbackType): number {
  if (type === 'accept_impact' || type === 'confirm_rule') return 0.1;
  if (
    type === 'reject_impact' ||
    type === 'reject_rule' ||
    type === 'add_missing_impact' ||
    type === 'merge_entities' ||
    type === 'split_entities' ||
    type === 'correct_relation'
  )
    return -0.15;
  return 0;
}

export function applyFeedback(record: KnowledgeRecord, feedback: FeedbackInput): KnowledgeRecord {
  if (record.id !== feedback.targetId) return record;
  const adjustment = confidenceAdjustment(feedback.type);
  const notes = [feedback.reason, feedback.correction, feedback.expectedTarget].filter((value): value is string =>
    Boolean(value),
  );
  return {
    ...record,
    confidenceScore: Math.max(0, Math.min(1, Number((record.confidenceScore + adjustment).toFixed(2)))),
    relatedTasks: [...new Set([...record.relatedTasks, ...notes])],
    feedbackNotes: [...new Set([...(record.feedbackNotes ?? []), ...notes])],
  };
}

export async function loadFeedback(root: string): Promise<FeedbackRecord[]> {
  const dir = path.join(root, '.agent', 'memory', 'feedback');
  if (!(await exists(dir))) return [];
  const fs = await import('node:fs/promises');
  const out: FeedbackRecord[] = [];
  for (const entry of await fs.readdir(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(await readText(path.join(dir, entry))) as FeedbackRecord);
    } catch {
      /* isolate malformed feedback */
    }
  }
  return out;
}

export async function feedbackStats(root: string): Promise<FeedbackStats> {
  const records = await loadFeedback(root);
  const accepted = records.filter((item) => item.type === 'accept_impact' || item.type === 'confirm_rule').length;
  const rejected = records.filter((item) => item.type === 'reject_impact' || item.type === 'reject_rule').length;
  const missing = records.filter((item) => item.type === 'add_missing_impact').length;
  return {
    total: records.length,
    accepted,
    rejected,
    missing,
    confidenceAdjustment: Number(((accepted - rejected) * 0.1).toFixed(2)),
  };
}
