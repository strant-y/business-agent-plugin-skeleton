import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { exists, readText, writeJson } from '../utils/fs.js';
import type { Confidence } from './types.js';
import type { EvidenceRef } from './evidence.js';

export type KnowledgeStatus =
  'candidate' | 'corroborated' | 'confirmed' | 'verified' | 'stale' | 'contradicted' | 'deprecated';
export type KnowledgeType = 'entity' | 'relation' | 'rule' | 'state' | 'workflow' | 'experience';
export type KnowledgeSource =
  'static-analysis' | 'llm-inference' | 'human-confirmed' | 'test-observation' | 'task-capture' | 'runtime-observation';

export interface KnowledgeRecord {
  id: string;
  type: KnowledgeType;
  subject: string;
  claim: string;
  confidence: Confidence;
  confidenceScore: number;
  status: KnowledgeStatus;
  source: KnowledgeSource;
  evidence: EvidenceRef[];
  relatedTasks: string[];
  version: number;
  firstSeenAt: string;
  lastVerifiedAt?: string;
  supersedes?: string;
  conflictsWith?: string[];
  supersededBy?: string;
  feedbackNotes?: string[];
}

export interface KnowledgeStateEvent {
  id: string;
  recordId: string;
  from: KnowledgeStatus;
  to: KnowledgeStatus;
  reason: string;
  evidence: EvidenceRef[];
  taskId?: string;
  actor: 'system' | 'agent' | 'user';
  timestamp: string;
}

const transitions: Record<KnowledgeStatus, KnowledgeStatus[]> = {
  candidate: ['corroborated', 'confirmed', 'deprecated'],
  corroborated: ['confirmed', 'deprecated'],
  confirmed: ['verified', 'stale', 'contradicted', 'deprecated'],
  verified: ['stale', 'contradicted', 'deprecated'],
  stale: ['verified', 'deprecated'],
  contradicted: ['stale', 'deprecated'],
  deprecated: [],
};

const KNOWLEDGE_LOCK_TTL_MS = 5 * 60 * 1000;
const KNOWLEDGE_LOCK_RETRY_DELAY_MS = 25;

interface KnowledgeStateLock {
  owner: string;
  acquiredAt: string;
  updatedAt: string;
  expiresAt: string;
}

function stateFile(root: string): string {
  return path.join(root, '.agent', 'memory', 'knowledge-state.json');
}

function eventDir(root: string): string {
  return path.join(root, '.agent', 'memory', 'knowledge-state-events');
}

function eventFile(root: string, eventId: string): string {
  return path.join(eventDir(root), `${eventId}.json`);
}

function lockDir(root: string): string {
  return path.join(root, '.agent', 'memory', 'knowledge-state-lock');
}

function lockFile(root: string): string {
  return path.join(lockDir(root), 'lock.json');
}

function createLock(owner: string): KnowledgeStateLock {
  const now = new Date();
  return {
    owner,
    acquiredAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + KNOWLEDGE_LOCK_TTL_MS).toISOString(),
  };
}

export function transitionKnowledge(
  record: KnowledgeRecord,
  event: Omit<KnowledgeStateEvent, 'from'>,
): KnowledgeRecord {
  if (event.recordId !== record.id || !transitions[record.status].includes(event.to)) {
    throw new Error(`Invalid knowledge transition: ${record.status} -> ${event.to}`);
  }
  return {
    ...record,
    status: event.to,
    version: record.version + 1,
    evidence: event.evidence.length ? [...record.evidence, ...event.evidence] : record.evidence,
    relatedTasks: event.taskId ? [...new Set([...record.relatedTasks, event.taskId])] : record.relatedTasks,
    lastVerifiedAt: event.to === 'verified' ? event.timestamp : record.lastVerifiedAt,
  };
}

export function validateKnowledgeState(record: KnowledgeRecord): string[] {
  const errors: string[] = [];
  if (!record.id || !record.subject || !record.claim) errors.push('Knowledge record requires id, subject and claim.');
  if (record.confidenceScore < 0 || record.confidenceScore > 1) errors.push('confidenceScore must be between 0 and 1.');
  if (record.version < 1) errors.push('version must be positive.');
  if (!record.evidence.length && record.status !== 'candidate')
    errors.push('Non-candidate knowledge requires evidence.');
  return errors;
}

async function loadKnowledgeStateMap(root: string): Promise<Record<string, KnowledgeRecord>> {
  const file = stateFile(root);
  if (!(await exists(file))) return {};
  const value = JSON.parse(await readText(file)) as unknown;
  if (typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string') {
    return { [value.id]: value as KnowledgeRecord };
  }
  return value as Record<string, KnowledgeRecord>;
}

export async function loadKnowledgeState(root: string, recordId?: string): Promise<KnowledgeRecord | undefined> {
  const records = await loadKnowledgeStateMap(root);
  if (recordId) return records[recordId];
  return Object.values(records)[0];
}

export async function loadKnowledgeStateEvent(root: string, id: string): Promise<KnowledgeStateEvent | undefined> {
  const file = eventFile(root, id);
  if (!(await exists(file))) return undefined;
  return JSON.parse(await readText(file)) as KnowledgeStateEvent;
}

async function readKnowledgeLock(root: string): Promise<KnowledgeStateLock | undefined> {
  if (!(await exists(lockFile(root)))) return undefined;
  try {
    return JSON.parse(await readText(lockFile(root))) as KnowledgeStateLock;
  } catch {
    return undefined;
  }
}

function isExpiredLock(lock: KnowledgeStateLock | undefined): boolean {
  if (!lock) return true;
  return Date.parse(lock.expiresAt) <= Date.now();
}

async function releaseKnowledgeLock(root: string, owner: string): Promise<void> {
  const current = await readKnowledgeLock(root);
  if (!current || current.owner !== owner) return;
  await fs.rm(lockDir(root), { recursive: true, force: true });
}

async function acquireKnowledgeLock(root: string): Promise<string> {
  const owner = randomUUID();
  await fs.mkdir(path.join(root, '.agent', 'memory'), { recursive: true });
  for (;;) {
    try {
      await fs.mkdir(lockDir(root));
      await writeJson(lockFile(root), createLock(owner));
      return owner;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const current = await readKnowledgeLock(root);
      if (isExpiredLock(current)) {
        await fs.rm(lockDir(root), { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, KNOWLEDGE_LOCK_RETRY_DELAY_MS));
    }
  }
}

async function withKnowledgeStateLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const owner = await acquireKnowledgeLock(root);
  try {
    return await action();
  } finally {
    await releaseKnowledgeLock(root, owner);
  }
}

async function writeKnowledgeState(
  root: string,
  record: KnowledgeRecord,
  event?: KnowledgeStateEvent,
  previousVersion?: number,
): Promise<void> {
  const records = await loadKnowledgeStateMap(root);
  const current = records[record.id];
  if (previousVersion !== undefined && current && current.version !== previousVersion) {
    throw new Error(`Knowledge record version conflict: ${record.id}`);
  }
  records[record.id] = record;
  if (event) await writeJson(eventFile(root, event.id), event);
  await writeJson(stateFile(root), records);
}

export async function persistKnowledgeState(
  root: string,
  record: KnowledgeRecord,
  event: KnowledgeStateEvent,
): Promise<void> {
  await withKnowledgeStateLock(root, () =>
    writeKnowledgeState(root, record, event, event.from ? record.version - 1 : undefined),
  );
}

export async function saveKnowledgeRecord(
  root: string,
  record: KnowledgeRecord,
  previousVersion?: number,
): Promise<void> {
  await withKnowledgeStateLock(root, () => writeKnowledgeState(root, record, undefined, previousVersion));
}

export async function updateKnowledgeStatus(
  root: string,
  record: KnowledgeRecord,
  input: Omit<KnowledgeStateEvent, 'from'>,
): Promise<KnowledgeRecord> {
  const next = transitionKnowledge(record, input);
  await persistKnowledgeState(root, next, { ...input, from: record.status });
  return next;
}
