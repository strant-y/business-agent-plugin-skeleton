import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { exists, readText, writeJson } from '../utils/fs.js';
import {
  buildTaskContext,
  handleTaskEvent,
  loadTaskSession,
  type LifecycleResult,
  type TaskLifecycleEvent as LegacyTaskLifecycleEvent,
  type TaskSession,
  type TestObservation,
} from './task.js';
import { recordFeedback, type FeedbackInput, type FeedbackRecord } from './feedback.js';
import { rebuildRetrievalIndex } from './retrieval.js';

export type LifecycleSource = 'agent-hook' | 'cli' | 'api' | 'git-hook' | 'editor';
export type LifecyclePhase = LegacyTaskLifecycleEvent['phase'] | 'feedback';

export interface LifecycleWarning {
  phase: string;
  code: string;
  message: string;
  recoverable: boolean;
}

export interface TaskLifecycleEvent extends Omit<LegacyTaskLifecycleEvent, 'phase'> {
  eventId: string;
  phase: LifecyclePhase;
  root: string;
  branch?: string;
  source: LifecycleSource;
  feedback?: FeedbackInput;
  testResults?: TestObservation[];
}

export interface EventLifecycleResult extends Omit<LifecycleResult, 'warnings'> {
  eventId: string;
  feedback?: FeedbackRecord;
  warnings: Array<string | LifecycleWarning>;
}

export interface LifecycleAdapter {
  dispatch(event: TaskLifecycleEvent): Promise<EventLifecycleResult>;
  load(eventId: string, root: string): Promise<EventLifecycleResult | undefined>;
}

interface EventLock {
  eventId: string;
  owner: string;
  status: 'processing' | 'completed' | 'failed-retryable';
  acquiredAt: string;
  updatedAt: string;
  expiresAt: string;
  error?: string;
}

const EVENT_LOCK_TTL_MS = 5 * 60 * 1000;
const LOCK_RENEW_INTERVAL_MS = 60 * 1000;

function sanitizeEventId(eventId: string): string {
  const safe = eventId
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!safe) throw new Error('Lifecycle eventId is required.');
  return safe.slice(0, 120);
}

function eventFile(root: string, eventId: string): string {
  return path.join(root, '.agent', 'memory', 'events', `${sanitizeEventId(eventId)}.json`);
}

function eventLockDir(root: string): string {
  return path.join(root, '.agent', 'memory', 'event-locks');
}

function eventLockPath(root: string, eventId: string): string {
  return path.join(eventLockDir(root), sanitizeEventId(eventId));
}

function eventLockFile(root: string, eventId: string): string {
  return path.join(eventLockPath(root, eventId), 'lock.json');
}

function createEventLock(eventId: string, owner: string, status: EventLock['status'], error?: string): EventLock {
  const now = new Date();
  return {
    eventId,
    owner,
    status,
    acquiredAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + EVENT_LOCK_TTL_MS).toISOString(),
    error,
  };
}

function parseLockTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function isExpiredLock(lock: Partial<EventLock> | undefined): boolean {
  const expiresAt = parseLockTimestamp(lock?.expiresAt);
  if (expiresAt !== undefined) return expiresAt <= Date.now();
  const updatedAt = parseLockTimestamp(lock?.updatedAt);
  if (updatedAt !== undefined) return updatedAt + EVENT_LOCK_TTL_MS <= Date.now();
  return true;
}

async function readLock(root: string, eventId: string): Promise<EventLock | undefined> {
  const file = eventLockFile(root, eventId);
  if (!(await exists(file))) return undefined;
  try {
    return JSON.parse(await readText(file)) as EventLock;
  } catch {
    return undefined;
  }
}

async function writeLock(root: string, lock: EventLock): Promise<void> {
  await writeJson(eventLockFile(root, lock.eventId), lock);
}

async function recoverExpiredEventLock(root: string, eventId: string): Promise<boolean> {
  const file = eventLockFile(root, eventId);
  if (!(await exists(file))) {
    const dirExists = await exists(eventLockPath(root, eventId));
    if (!dirExists) return false;
  }
  const lock = await readLock(root, eventId);
  if ((await exists(file)) && lock && !isExpiredLock(lock)) return false;
  try {
    await fs.rm(eventLockPath(root, eventId), { recursive: true, force: false });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    return false;
  }
}

export async function loadEventResult(root: string, eventId: string): Promise<EventLifecycleResult | undefined> {
  const file = eventFile(root, eventId);
  if (!(await exists(file))) return undefined;
  return JSON.parse(await readText(file)) as EventLifecycleResult;
}

async function saveEventResult(root: string, eventId: string, result: EventLifecycleResult): Promise<void> {
  await writeJson(eventFile(root, eventId), result);
}

async function acquireEventLock(root: string, eventId: string): Promise<string> {
  const safeEventId = sanitizeEventId(eventId);
  const owner = randomUUID();
  await fs.mkdir(eventLockDir(root), { recursive: true });
  for (;;) {
    try {
      await fs.mkdir(eventLockPath(root, safeEventId));
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const recovered = await recoverExpiredEventLock(root, safeEventId);
      if (!recovered) {
        throw new Error(`Lifecycle event is already processing: ${safeEventId}`, { cause: error });
      }
    }
  }
  try {
    await writeLock(root, createEventLock(safeEventId, owner, 'processing'));
    return owner;
  } catch (error) {
    await releaseEventLock(root, safeEventId, owner);
    throw error;
  }
}

async function renewEventLock(root: string, eventId: string, owner: string): Promise<void> {
  const current = await readLock(root, eventId);
  if (!current || current.owner !== owner) return;
  await writeLock(root, {
    ...current,
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + EVENT_LOCK_TTL_MS).toISOString(),
  });
}

function startEventLockRenewal(root: string, eventId: string, owner: string): () => void {
  const timer = setInterval(() => {
    void renewEventLock(root, eventId, owner).catch(() => undefined);
  }, LOCK_RENEW_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function releaseEventLock(root: string, eventId: string, owner: string): Promise<void> {
  const current = await readLock(root, eventId);
  if (current && current.owner !== owner) return;
  await fs.rm(eventLockPath(root, eventId), { recursive: true, force: true });
}

async function completeEventLock(root: string, eventId: string, owner: string): Promise<void> {
  const current = await readLock(root, eventId);
  if (!current || current.owner !== owner) return;
  await writeLock(root, { ...current, status: 'completed', updatedAt: new Date().toISOString() });
  await releaseEventLock(root, eventId, owner);
}

async function failEventLock(root: string, eventId: string, owner: string, error: string): Promise<void> {
  const current = await readLock(root, eventId);
  if (!current || current.owner !== owner) return;
  await writeLock(root, { ...current, status: 'failed-retryable', updatedAt: new Date().toISOString(), error });
  await releaseEventLock(root, eventId, owner);
}

export async function dispatchLifecycleEvent(event: TaskLifecycleEvent): Promise<EventLifecycleResult> {
  const safeEventId = sanitizeEventId(event.eventId);
  const normalized = { ...event, eventId: safeEventId };
  const existing = await loadEventResult(normalized.root, safeEventId);
  if (existing) return existing;
  const owner = await acquireEventLock(normalized.root, safeEventId);
  const stopRenewal = startEventLockRenewal(normalized.root, safeEventId, owner);
  try {
    const cachedAfterLock = await loadEventResult(normalized.root, safeEventId);
    if (cachedAfterLock) {
      await completeEventLock(normalized.root, safeEventId, owner);
      return cachedAfterLock;
    }
    if (normalized.phase === 'feedback') {
      if (!normalized.feedback) throw new Error('Feedback payload is required.');
      const session = await loadTaskSession(normalized.root, normalized.sessionId);
      const feedback = await recordFeedback(
        normalized.root,
        normalized.feedback,
        session.taskId,
        session.sessionId,
        safeEventId,
      );
      await rebuildRetrievalIndex(normalized.root);
      const result: EventLifecycleResult = { eventId: safeEventId, session, warnings: [], feedback };
      await saveEventResult(normalized.root, safeEventId, result);
      await completeEventLock(normalized.root, safeEventId, owner);
      return result;
    }
    const result = await handleTaskEvent(
      {
        taskId: normalized.taskId,
        sessionId: normalized.sessionId,
        phase: normalized.phase,
        task: normalized.task,
        files: normalized.files,
        diff: normalized.diff,
        testResults: normalized.testResults,
        learnedFacts: normalized.learnedFacts,
        timestamp: normalized.timestamp,
      },
      normalized.root,
    );
    if (normalized.phase === 'after_task') await rebuildRetrievalIndex(normalized.root);
    const wrapped: EventLifecycleResult = { ...result, eventId: safeEventId, warnings: result.warnings };
    await saveEventResult(normalized.root, safeEventId, wrapped);
    await completeEventLock(normalized.root, safeEventId, owner);
    return wrapped;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failEventLock(normalized.root, safeEventId, owner, message);
    const warning: LifecycleWarning = {
      phase: normalized.phase,
      code: 'LIFECYCLE_FAILURE',
      message,
      recoverable: true,
    };
    let session: TaskSession;
    try {
      session = await loadTaskSession(normalized.root, normalized.sessionId);
    } catch {
      const context =
        normalized.phase === 'before_task' ? await buildTaskContext(normalized.root, normalized.task) : undefined;
      session = (
        await handleTaskEvent(
          {
            taskId: normalized.taskId,
            sessionId: normalized.sessionId,
            phase: 'before_task',
            task: normalized.task,
            timestamp: normalized.timestamp,
          },
          normalized.root,
        )
      ).session;
      return { eventId: safeEventId, session, context, warnings: [warning] };
    }
    return { eventId: safeEventId, session, warnings: [warning] };
  } finally {
    stopRenewal();
  }
}

export const lifecycleAdapter: LifecycleAdapter = {
  dispatch: dispatchLifecycleEvent,
  load: loadEventResult,
};
