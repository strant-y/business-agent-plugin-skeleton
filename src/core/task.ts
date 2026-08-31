import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { exists, readText, writeJson } from '../utils/fs.js';
import { loadManifestSafe } from './manifest-loader.js';
import { buildImpactReport, type ImpactReport } from './impact.js';
import { writeLearnCandidate } from '../commands/learn.js';
import { gitDiffFiles, gitDiffText, gitBranch } from '../utils/git.js';
import { rebuildRetrievalIndex } from './retrieval.js';
import type { BusinessRule, DiscoverManifest, Entity, Relation, WorkflowTemplate } from './types.js';

const run = promisify(execFile);
const COMPLETED_TASK_LOCK_TTL_MS = 5 * 60 * 1000;
const LOCK_INITIALIZATION_GRACE_MS = 2_000;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_RENEW_INTERVAL_MS = 60 * 1000;
const ACTIVE_SESSION_LOCK_ID = '__active-session__';
const PERSISTENCE_LOCK_ID = '__completed-task-persistence__';

export type TaskPhase = 'before_task' | 'before_context' | 'before_edit' | 'after_edit' | 'after_test' | 'after_task';
export type TaskStatus = 'active' | 'completed' | 'cancelled';

export interface TestObservation {
  command: string;
  passed: boolean;
  summary?: string;
  output?: string;
  timestamp: string;
}

export interface TaskExperience {
  taskId: string;
  summary?: string;
  intent: string;
  changedFiles: string[];
  diffSummary: string[];
  affectedEntities: string[];
  affectedRules: string[];
  affectedApis: string[];
  affectedWorkflows: string[];
  predictedImpact: string[];
  actualImpact: string[];
  suggestedTests: string[];
  accuracy?: ImpactAccuracy;
  testsRun: TestObservation[];
  lessons: string[];
  learnedFacts: string[];
  humanCorrections: string[];
  createdAt: string;
}

export interface ImpactAccuracy {
  entityPrecision: number;
  entityRecall: number;
  findingPrecision: number;
  findingRecall: number;
  mappedRulePrecision: number;
  mappedRuleRecall: number;
  mappedTestPrecision: number;
  mappedTestRecall: number;
  relationships?: Array<{ relationship: string; predicted: number; actual: number; hits: number }>;
}

export interface ImpactComparison {
  predicted: string[];
  actual: string[];
  missed: string[];
  unexpected: string[];
  predictedFindings: string[];
  actualFindings: string[];
  missedFindings: string[];
  unexpectedFindings: string[];
  predictedMappedRules: string[];
  actualMappedRules: string[];
  missedMappedRules: string[];
  unexpectedMappedRules: string[];
  predictedMappedTests: string[];
  actualMappedTests: string[];
  missedMappedTests: string[];
  unexpectedMappedTests: string[];
}

export interface TaskLifecycleEvent {
  taskId: string;
  eventId?: string;
  sessionId?: string;
  phase: TaskPhase;
  task: string;
  root?: string;
  branch?: string;
  source?: 'agent-hook' | 'cli' | 'api' | 'git-hook' | 'editor';
  files?: string[];
  diff?: string;
  testResults?: TestObservation[];
  feedback?: unknown;
  learnedFacts?: string[];
  timestamp: string;
}

export interface LifecycleResult {
  session: TaskSession;
  context?: TaskContext;
  impact?: ImpactReport;
  comparison?: ImpactComparison;
  experience?: TaskExperience;
  candidates?: string[];
  warnings: string[];
}

export interface TaskSession {
  taskId: string;
  sessionId: string;
  task: string;
  root: string;
  branch?: string;
  status: TaskStatus;
  phase: TaskPhase;
  createdAt: string;
  updatedAt: string;
  changedFiles: string[];
  predictedFiles: string[];
  predictedImpact?: ImpactReport;
  actualImpact?: ImpactReport;
  comparison?: ImpactComparison;
  accuracy?: ImpactAccuracy;
  context?: TaskContext;
  diff?: string;
  diffSummary: string[];
  tests: TestObservation[];
  learnedFacts: string[];
  warnings: string[];
}

export interface TaskContext {
  task: string;
  entities: Entity[];
  rules: BusinessRule[];
  relations: Relation[];
  workflows: WorkflowTemplate[];
  history: string[];
  questions: string[];
}

interface CompletedTaskLock {
  sessionId: string;
  owner: string;
  acquiredAt: string;
  updatedAt: string;
  expiresAt: string;
}

function sessionDir(root: string): string {
  return path.join(root, '.agent', 'memory', 'sessions');
}

function sessionFile(root: string, sessionId: string): string {
  return path.join(sessionDir(root), `${sessionId}.json`);
}

function activeFile(root: string): string {
  return path.join(root, '.agent', 'memory', 'active-session.json');
}

function completedTasksFile(root: string): string {
  return path.join(root, '.agent', 'memory', 'completed-tasks.json');
}

function completedTaskLockDir(root: string, sessionId: string): string {
  return path.join(root, '.agent', 'memory', 'completed-task-locks', sessionId);
}

function completedTaskLockFile(root: string, sessionId: string): string {
  return path.join(completedTaskLockDir(root, sessionId), 'lock.json');
}

function createCompletedTaskLock(sessionId: string, owner: string): CompletedTaskLock {
  const now = new Date();
  return {
    sessionId,
    owner,
    acquiredAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + COMPLETED_TASK_LOCK_TTL_MS).toISOString(),
  };
}

function parseLockTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function isExpiredCompletedTaskLock(lock: Partial<CompletedTaskLock> | undefined): boolean {
  const expiresAt = parseLockTimestamp(lock?.expiresAt);
  if (expiresAt !== undefined) return expiresAt <= Date.now();
  const updatedAt = parseLockTimestamp(lock?.updatedAt);
  if (updatedAt !== undefined) return updatedAt + COMPLETED_TASK_LOCK_TTL_MS <= Date.now();
  return true;
}

async function readCompletedTaskLock(root: string, sessionId: string): Promise<CompletedTaskLock | undefined> {
  const file = completedTaskLockFile(root, sessionId);
  if (!(await exists(file))) return undefined;
  try {
    return JSON.parse(await readText(file)) as CompletedTaskLock;
  } catch {
    return undefined;
  }
}

async function recoverExpiredCompletedTaskLock(root: string, sessionId: string): Promise<boolean> {
  const dir = completedTaskLockDir(root, sessionId);
  const file = completedTaskLockFile(root, sessionId);
  if (!(await exists(dir))) return false;
  const lock = await readCompletedTaskLock(root, sessionId);
  if ((await exists(file)) && lock && !isExpiredCompletedTaskLock(lock)) return false;
  if (!lock || !(await exists(file))) {
    try {
      const stat = await fs.stat(dir);
      if (Date.now() - stat.mtimeMs < LOCK_INITIALIZATION_GRACE_MS) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      return false;
    }
  }
  try {
    await fs.rm(dir, { recursive: true, force: false });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    return false;
  }
}

function slug(value: string): string {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return result || 'task';
}

function keywords(task: string): string[] {
  return [
    ...new Set(
      task
        .split(/[^\p{L}\p{N}_-]+/u)
        .map((word) => word.trim().toLowerCase())
        .filter((word) => word.length >= 2),
    ),
  ];
}

async function readManifest(root: string): Promise<DiscoverManifest | undefined> {
  const manifest = await loadManifestSafe(root);
  return manifest.entities ? (manifest as DiscoverManifest) : undefined;
}

async function listHistory(root: string, terms: string[]): Promise<string[]> {
  const dir = path.join(root, '.agent', 'memory', 'task-history');
  if (!(await exists(dir))) return [];
  const files = (await fs.readdir(dir))
    .filter((file) => file.endsWith('.md') || file.endsWith('.json'))
    .sort()
    .reverse();
  const selected: string[] = [];
  for (const file of files) {
    const text = await readText(path.join(dir, file));
    if (!terms.length || terms.some((term) => text.toLowerCase().includes(term))) selected.push(file);
    if (selected.length >= 5) break;
  }
  return selected;
}

export async function buildTaskContext(root: string, task: string): Promise<TaskContext> {
  const manifest = await readManifest(root);
  const terms = keywords(task);
  const matches = (value: string): boolean => !terms.length || terms.some((term) => value.toLowerCase().includes(term));
  const entities = (manifest?.entities ?? []).filter((entity) =>
    matches(`${entity.name} ${entity.description} ${entity.evidence.join(' ')}`),
  );
  const names = new Set(entities.map((entity) => entity.name));
  const rules = (manifest?.rules ?? []).filter(
    (rule) => names.has(rule.entity) || matches(`${rule.name} ${rule.rule.join(' ')}`),
  );
  const relations = (manifest?.relations ?? []).filter(
    (relation) =>
      names.has(relation.source) ||
      names.has(relation.target) ||
      matches(`${relation.source} ${relation.target} ${relation.relationship}`),
  );
  const workflows = (manifest?.workflows ?? []).filter((workflow) =>
    matches(`${workflow.name} ${workflow.description} ${workflow.steps.join(' ')}`),
  );
  const history = await listHistory(root, terms);
  const questions = rules
    .filter((rule) => rule.status !== 'confirmed')
    .map((rule) => `Verify candidate rule: ${rule.name}`);
  return { task, entities, rules, relations, workflows, history, questions };
}

interface SaveTaskSessionOptions {
  updateActive?: boolean;
  forceActive?: boolean;
}

export async function saveTaskSession(
  session: TaskSession,
  options: SaveTaskSessionOptions = { updateActive: true },
): Promise<string> {
  const file = sessionFile(session.root, session.sessionId);
  await writeJson(file, session);
  if (options.updateActive) {
    const activeOwner = await acquireCompletedTaskLock(session.root, ACTIVE_SESSION_LOCK_ID);
    if (!activeOwner) return file;
    try {
      if (options.forceActive || (await isActiveSession(session.root, session.sessionId))) {
        await writeJson(activeFile(session.root), {
          sessionId: session.sessionId,
          taskId: session.taskId,
          updatedAt: session.updatedAt,
        });
      }
    } finally {
      await releaseCompletedTaskLock(session.root, ACTIVE_SESSION_LOCK_ID, activeOwner);
    }
  }
  return file;
}

export async function loadTaskSession(root: string, sessionId?: string): Promise<TaskSession> {
  const id = sessionId ?? (await readActiveSession(root));
  if (!id) throw new Error('No active task session. Run `business-agent task start <description>` first.');
  const file = sessionFile(root, id);
  if (!(await exists(file))) throw new Error(`Task session not found: ${id}`);
  return JSON.parse(await readText(file)) as TaskSession;
}

async function readActiveSession(root: string): Promise<string | undefined> {
  const file = activeFile(root);
  if (!(await exists(file))) return undefined;
  try {
    const value = JSON.parse(await readText(file)) as { sessionId?: string };
    return value.sessionId;
  } catch {
    return undefined;
  }
}

async function isActiveSession(root: string, sessionId: string): Promise<boolean> {
  return (await readActiveSession(root)) === sessionId;
}

async function setActiveSession(session: TaskSession): Promise<void> {
  await saveTaskSession(session, { updateActive: true, forceActive: true });
}

async function clearActiveSession(root: string, sessionId: string): Promise<void> {
  const activeOwner = await acquireCompletedTaskLock(root, ACTIVE_SESSION_LOCK_ID);
  if (!activeOwner) return;
  try {
    if (!(await isActiveSession(root, sessionId))) return;
    const file = activeFile(root);
    if (!(await exists(file))) return;
    await fs.rm(file, { force: true });
  } finally {
    await releaseCompletedTaskLock(root, ACTIVE_SESSION_LOCK_ID, activeOwner);
  }
}

export async function startTask(
  root: string,
  task: string,
  sessionId?: string,
  dryRun = false,
): Promise<{ session: TaskSession; context: TaskContext }> {
  const now = new Date().toISOString();
  const id =
    sessionId ?? `${slug(task)}-${now.replace(/\D/g, '').slice(0, 17)}-${Math.random().toString(36).slice(2, 8)}`;
  const session: TaskSession = {
    taskId: id,
    sessionId: id,
    task,
    root,
    branch: await gitBranch(root),
    status: 'active',
    phase: 'before_task',
    createdAt: now,
    updatedAt: now,
    changedFiles: [],
    predictedFiles: [],
    diffSummary: [],
    tests: [],
    learnedFacts: [],
    warnings: [],
  };
  const context = await buildTaskContext(root, task);
  const withContext = { ...session, context };
  if (!dryRun) await setActiveSession(withContext);
  return { session: withContext, context };
}

export async function updateTaskSession(
  session: TaskSession,
  phase: TaskPhase,
  activate = false,
): Promise<TaskSession> {
  const updated = { ...session, phase, updatedAt: new Date().toISOString() };
  await saveTaskSession(updated, { updateActive: activate });
  return updated;
}

export async function predictTaskImpact(
  root: string,
  session: TaskSession,
  files: string[],
  dryRun = false,
): Promise<TaskSession> {
  const changedFiles = files.length ? files : await gitDiffFiles(root);
  const diff = await gitDiffText(root);
  const report = await buildImpactReport(root, changedFiles, diff);
  return saveAndReturn(
    {
      ...session,
      phase: 'before_edit',
      predictedFiles: changedFiles,
      predictedImpact: report,
      changedFiles,
      updatedAt: new Date().toISOString(),
    },
    false,
    !dryRun,
  );
}

export async function checkpointTask(
  root: string,
  session: TaskSession,
  files: string[],
  dryRun = false,
): Promise<TaskSession> {
  const changedFiles = files.length ? files : await gitDiffFiles(root);
  const diff = await gitDiffText(root);
  const report = await buildImpactReport(root, changedFiles, diff);
  const diffSummary = summarizeDiff(diff);
  const comparison = compareImpact(session.predictedImpact, report);
  return saveAndReturn(
    {
      ...session,
      phase: 'after_edit',
      changedFiles,
      actualImpact: report,
      comparison,
      accuracy: computeAccuracy(session.predictedImpact, report),
      diff,
      diffSummary,
      updatedAt: new Date().toISOString(),
    },
    false,
    !dryRun,
  );
}

export async function recordTaskTest(
  session: TaskSession,
  observation: Omit<TestObservation, 'timestamp'>,
  dryRun = false,
): Promise<TaskSession> {
  return saveAndReturn(
    {
      ...session,
      phase: 'after_test',
      tests: [...session.tests, { ...observation, timestamp: new Date().toISOString() }],
      updatedAt: new Date().toISOString(),
    },
    false,
    !dryRun,
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

export function computeAccuracy(predicted?: ImpactReport, actual?: ImpactReport): ImpactAccuracy {
  const predictedEntities = new Set(predicted?.entities ?? []);
  const actualEntities = new Set(actual?.entities ?? []);
  const predictedFindings = new Set(
    (predicted?.diffFindings ?? []).map((finding) => `${finding.kind}:${finding.subject}`),
  );
  const actualFindings = new Set((actual?.diffFindings ?? []).map((finding) => `${finding.kind}:${finding.subject}`));
  const predictedMappedRules = new Set((predicted?.diffImpact ?? []).flatMap((mapping) => mapping.rules));
  const actualMappedRules = new Set((actual?.diffImpact ?? []).flatMap((mapping) => mapping.rules));
  const predictedMappedTests = new Set((predicted?.diffImpact ?? []).flatMap((mapping) => mapping.tests));
  const actualMappedTests = new Set((actual?.diffImpact ?? []).flatMap((mapping) => mapping.tests));
  const intersection = (left: Set<string>, right: Set<string>): number =>
    [...left].filter((item) => right.has(item)).length;
  const relationshipNames = new Set([
    ...(predicted?.relations ?? []).map((relation) => relation.relationship),
    ...(actual?.relations ?? []).map((relation) => relation.relationship),
  ]);
  const relationIdentity = (relation: Relation): string =>
    `${relation.source}\u0000${relation.target}\u0000${relation.relationship}`;
  const predictedRelationCounts = new Map<string, number>();
  const actualRelationCounts = new Map<string, number>();
  for (const relation of predicted?.relations ?? []) {
    const identity = relationIdentity(relation);
    predictedRelationCounts.set(identity, (predictedRelationCounts.get(identity) ?? 0) + 1);
  }
  for (const relation of actual?.relations ?? []) {
    const identity = relationIdentity(relation);
    actualRelationCounts.set(identity, (actualRelationCounts.get(identity) ?? 0) + 1);
  }
  const relationships = [...relationshipNames].map((relationship) => {
    const predictedRelations = (predicted?.relations ?? []).filter((item) => item.relationship === relationship);
    const actualRelations = (actual?.relations ?? []).filter((item) => item.relationship === relationship);
    const identities = new Set([...predictedRelations.map(relationIdentity), ...actualRelations.map(relationIdentity)]);
    let hits = 0;
    for (const identity of identities) {
      const predictedCount = predictedRelationCounts.get(identity) ?? 0;
      const actualCount = actualRelationCounts.get(identity) ?? 0;
      hits += predictedCount < actualCount ? predictedCount : actualCount;
    }
    return { relationship, predicted: predictedRelations.length, actual: actualRelations.length, hits };
  });
  return {
    entityPrecision: ratio(intersection(predictedEntities, actualEntities), predictedEntities.size),
    entityRecall: ratio(intersection(predictedEntities, actualEntities), actualEntities.size),
    findingPrecision: ratio(intersection(predictedFindings, actualFindings), predictedFindings.size),
    findingRecall: ratio(intersection(predictedFindings, actualFindings), actualFindings.size),
    mappedRulePrecision: ratio(intersection(predictedMappedRules, actualMappedRules), predictedMappedRules.size),
    mappedRuleRecall: ratio(intersection(predictedMappedRules, actualMappedRules), actualMappedRules.size),
    mappedTestPrecision: ratio(intersection(predictedMappedTests, actualMappedTests), predictedMappedTests.size),
    mappedTestRecall: ratio(intersection(predictedMappedTests, actualMappedTests), actualMappedTests.size),
    relationships,
  };
}

export interface RelationshipAccuracy {
  predicted: number;
  actual: number;
  hits: number;
  precision: number;
}

export interface ImpactAccuracySummary {
  tasks: number;
  relationshipAccuracy?: Record<string, RelationshipAccuracy>;
  averageEntityPrecision: number;
  averageEntityRecall: number;
  averageFindingPrecision: number;
  averageFindingRecall: number;
  averageMappedRulePrecision: number;
  averageMappedRuleRecall: number;
  averageMappedTestPrecision: number;
  averageMappedTestRecall: number;
  updatedAt: string;
}

async function updateAccuracySummary(
  root: string,
  accuracy?: ImpactAccuracy,
): Promise<ImpactAccuracySummary | undefined> {
  if (!accuracy) return undefined;
  const file = path.join(root, '.agent', 'memory', 'impact-accuracy.json');
  let summary: ImpactAccuracySummary = {
    tasks: 0,
    relationshipAccuracy: {},
    averageEntityPrecision: 0,
    averageEntityRecall: 0,
    averageFindingPrecision: 0,
    averageFindingRecall: 0,
    averageMappedRulePrecision: 0,
    averageMappedRuleRecall: 0,
    averageMappedTestPrecision: 0,
    averageMappedTestRecall: 0,
    updatedAt: new Date().toISOString(),
  };
  if (await exists(file)) {
    summary = JSON.parse(await readText(file)) as ImpactAccuracySummary;
  }
  const nextTasks = summary.tasks + 1;
  const relationshipAccuracy = summary.relationshipAccuracy ?? {};
  for (const mapping of accuracy.relationships ?? []) {
    const current = relationshipAccuracy[mapping.relationship] ?? { predicted: 0, actual: 0, hits: 0, precision: 0 };
    current.predicted += mapping.predicted;
    current.actual += mapping.actual;
    current.hits += mapping.hits;
    current.precision = current.predicted ? Number((current.hits / current.predicted).toFixed(4)) : 0;
    relationshipAccuracy[mapping.relationship] = current;
  }
  const average = (current: number, value: number) =>
    Number(((current * summary.tasks + value) / nextTasks).toFixed(4));
  summary = {
    tasks: nextTasks,
    averageEntityPrecision: average(summary.averageEntityPrecision, accuracy.entityPrecision),
    averageEntityRecall: average(summary.averageEntityRecall, accuracy.entityRecall),
    averageFindingPrecision: average(summary.averageFindingPrecision, accuracy.findingPrecision),
    averageFindingRecall: average(summary.averageFindingRecall, accuracy.findingRecall),
    averageMappedRulePrecision: average(summary.averageMappedRulePrecision, accuracy.mappedRulePrecision),
    averageMappedRuleRecall: average(summary.averageMappedRuleRecall, accuracy.mappedRuleRecall),
    averageMappedTestPrecision: average(summary.averageMappedTestPrecision, accuracy.mappedTestPrecision),
    averageMappedTestRecall: average(summary.averageMappedTestRecall, accuracy.mappedTestRecall),
    relationshipAccuracy,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(file, summary);
  return summary;
}

export function compareImpact(predicted?: ImpactReport, actual?: ImpactReport): ImpactComparison {
  const predictedNodes = new Set([
    ...(predicted?.entities ?? []),
    ...(predicted?.rules ?? []).map((rule) => rule.id),
    ...(predicted?.apis ?? []).map((api) => `${api.method} ${api.path}`),
  ]);
  const actualNodes = new Set([
    ...(actual?.entities ?? []),
    ...(actual?.rules ?? []).map((rule) => rule.id),
    ...(actual?.apis ?? []).map((api) => `${api.method} ${api.path}`),
  ]);
  const predictedFindings = new Set(
    (predicted?.diffFindings ?? []).map((finding) => `${finding.kind}:${finding.subject}`),
  );
  const actualFindings = new Set((actual?.diffFindings ?? []).map((finding) => `${finding.kind}:${finding.subject}`));
  const predictedMappedRules = new Set((predicted?.diffImpact ?? []).flatMap((mapping) => mapping.rules));
  const actualMappedRules = new Set((actual?.diffImpact ?? []).flatMap((mapping) => mapping.rules));
  const predictedMappedTests = new Set((predicted?.diffImpact ?? []).flatMap((mapping) => mapping.tests));
  const actualMappedTests = new Set((actual?.diffImpact ?? []).flatMap((mapping) => mapping.tests));
  return {
    predicted: [...predictedNodes],
    actual: [...actualNodes],
    missed: [...actualNodes].filter((item) => !predictedNodes.has(item)),
    unexpected: [...predictedNodes].filter((item) => !actualNodes.has(item)),
    predictedFindings: [...predictedFindings],
    actualFindings: [...actualFindings],
    missedFindings: [...actualFindings].filter((item) => !predictedFindings.has(item)),
    unexpectedFindings: [...predictedFindings].filter((item) => !actualFindings.has(item)),
    predictedMappedRules: [...predictedMappedRules],
    actualMappedRules: [...actualMappedRules],
    missedMappedRules: [...actualMappedRules].filter((item) => !predictedMappedRules.has(item)),
    unexpectedMappedRules: [...predictedMappedRules].filter((item) => !actualMappedRules.has(item)),
    predictedMappedTests: [...predictedMappedTests],
    actualMappedTests: [...actualMappedTests],
    missedMappedTests: [...actualMappedTests].filter((item) => !predictedMappedTests.has(item)),
    unexpectedMappedTests: [...predictedMappedTests].filter((item) => !actualMappedTests.has(item)),
  };
}

export async function runTaskValidation(
  session: TaskSession,
  commands: string[],
  dryRun = false,
): Promise<TaskSession> {
  let current = session;
  for (const command of commands) {
    const started = Date.now();
    try {
      const result = await run(command, [], {
        cwd: session.root,
        shell: true,
        timeout: 120000,
        maxBuffer: 2 * 1024 * 1024,
      });
      current = await recordTaskTest(
        current,
        {
          command,
          passed: true,
          summary: `Completed in ${Date.now() - started}ms`,
          output: `${result.stdout}${result.stderr}`.slice(-8000),
        },
        dryRun,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      current = await recordTaskTest(
        current,
        {
          command,
          passed: false,
          summary: detail,
          output: detail.slice(-8000),
        },
        dryRun,
      );
    }
  }
  return current;
}

async function loadCompletedTasks(root: string): Promise<Record<string, { sessionId: string; completedAt: string }>> {
  const file = completedTasksFile(root);
  if (!(await exists(file))) return {};
  return JSON.parse(await readText(file)) as Record<string, { sessionId: string; completedAt: string }>;
}

async function acquireCompletedTaskLock(root: string, sessionId: string): Promise<string | undefined> {
  const owner = randomUUID();
  const dir = completedTaskLockDir(root, sessionId);
  const file = completedTaskLockFile(root, sessionId);
  await fs.mkdir(path.join(root, '.agent', 'memory', 'completed-task-locks'), { recursive: true });
  for (;;) {
    try {
      await fs.mkdir(dir);
      const handle = await fs.open(file, 'wx');
      try {
        await handle.writeFile(JSON.stringify(createCompletedTaskLock(sessionId, owner), null, 2) + '\n', 'utf8');
      } finally {
        await handle.close();
      }
      return owner;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const recovered = await recoverExpiredCompletedTaskLock(root, sessionId);
      if (!recovered) return undefined;
    }
  }
}

async function renewCompletedTaskLock(root: string, sessionId: string, owner: string): Promise<void> {
  const current = await readCompletedTaskLock(root, sessionId);
  if (!current || current.owner !== owner) return;
  await writeJson(completedTaskLockFile(root, sessionId), {
    ...current,
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + COMPLETED_TASK_LOCK_TTL_MS).toISOString(),
  });
}

function startCompletedTaskLockRenewal(root: string, sessionId: string, owner: string): () => void {
  const timer = setInterval(() => {
    void renewCompletedTaskLock(root, sessionId, owner).catch(() => undefined);
  }, LOCK_RENEW_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function releaseCompletedTaskLock(root: string, sessionId: string, owner: string): Promise<void> {
  const current = await readCompletedTaskLock(root, sessionId);
  if (!current || current.owner !== owner) return;
  await fs.rm(completedTaskLockDir(root, sessionId), { recursive: true, force: true });
}

async function acquirePersistenceLock(root: string): Promise<string> {
  for (;;) {
    const owner = await acquireCompletedTaskLock(root, PERSISTENCE_LOCK_ID);
    if (owner) return owner;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
  }
}

async function releasePersistenceLock(root: string, owner: string): Promise<void> {
  await releaseCompletedTaskLock(root, PERSISTENCE_LOCK_ID, owner);
}

export async function finishTask(session: TaskSession, message?: string, learned?: string): Promise<TaskSession> {
  const completed = {
    ...session,
    phase: 'after_task' as const,
    status: 'completed' as const,
    updatedAt: new Date().toISOString(),
    learnedFacts: learned ? [...new Set([...session.learnedFacts, learned])] : session.learnedFacts,
  };
  const active = await isActiveSession(session.root, session.sessionId);
  const finished = await saveAndReturn(completed);
  if (active) await clearActiveSession(session.root, session.sessionId);
  const owner = await acquireCompletedTaskLock(session.root, session.sessionId);
  if (!owner) return finished;
  const stopRenewal = startCompletedTaskLockRenewal(session.root, session.sessionId, owner);
  try {
    const persistenceOwner = await acquirePersistenceLock(session.root);
    try {
      const completedTasks = await loadCompletedTasks(session.root);
      if (completedTasks[session.sessionId]) return finished;
      const candidates: string[] = [];
      if (learned) {
        candidates.push(
          await writeLearnCandidate(session.root, learned, {
            evidence: finished.changedFiles.length ? finished.changedFiles : ['Captured during task lifecycle.'],
            source: 'task-capture',
            dryRun: false,
          }),
        );
      }
      const experience = await buildTaskExperience(session.root, finished, message, true);
      await writeJson(path.join(session.root, '.agent', 'memory', 'task-history', `${session.sessionId}.json`), {
        ...experience,
        session: finished,
        candidates,
      });
      await writeJson(
        path.join(session.root, '.agent', 'business', 'experiences', `${session.sessionId}.json`),
        experience,
      );
      completedTasks[session.sessionId] = { sessionId: session.sessionId, completedAt: finished.updatedAt };
      await writeJson(completedTasksFile(session.root), completedTasks);
      await rebuildRetrievalIndex(session.root);
      return finished;
    } finally {
      await releasePersistenceLock(session.root, persistenceOwner);
    }
  } finally {
    stopRenewal();
    await releaseCompletedTaskLock(session.root, session.sessionId, owner);
  }
}

async function buildTaskExperience(
  root: string,
  session: TaskSession,
  message?: string,
  updateAccuracy = false,
): Promise<TaskExperience> {
  if (updateAccuracy) await updateAccuracySummary(root, session.accuracy);
  const actual = session.actualImpact;
  const predicted = session.predictedImpact;
  return {
    taskId: session.taskId,
    summary: message,
    intent: session.task,
    changedFiles: session.changedFiles,
    diffSummary: session.diffSummary,
    affectedEntities: actual?.entities ?? [],
    affectedRules: actual?.rules.map((rule) => rule.id) ?? [],
    affectedApis: actual?.apis.map((api) => `${api.method} ${api.path}`) ?? [],
    affectedWorkflows: actual?.workflows.map((workflow) => workflow.name) ?? [],
    predictedImpact: predicted?.chain.map((step) => step.node) ?? [],
    actualImpact: actual?.chain.map((step) => step.node) ?? [],
    suggestedTests: actual?.tests ?? [],
    accuracy: session.accuracy,
    testsRun: session.tests,
    lessons:
      session.comparison?.missed.length ||
      session.comparison?.missedFindings.length ||
      session.comparison?.missedMappedRules.length ||
      session.comparison?.missedMappedTests.length
        ? [
            `Impact analysis missed: ${session.comparison.missed.join(', ') || 'none'}`,
            `Diff findings missed: ${session.comparison.missedFindings.join(', ') || 'none'}`,
            `Mapped rules missed: ${session.comparison.missedMappedRules.join(', ') || 'none'}`,
            `Mapped tests missed: ${session.comparison.missedMappedTests.join(', ') || 'none'}`,
          ]
        : ['Review the affected business rules before promoting new behavior.'],
    learnedFacts: session.learnedFacts,
    humanCorrections: [],
    createdAt: session.updatedAt,
  };
}

export async function handleTaskEvent(event: TaskLifecycleEvent, root: string): Promise<LifecycleResult> {
  let session: TaskSession;
  let context: TaskContext | undefined;
  let impact: ImpactReport | undefined;
  let comparison: ImpactComparison | undefined;
  let experience: TaskExperience | undefined;
  const warnings: string[] = [];

  if (event.phase === 'before_task') {
    const result = await startTask(root, event.task, event.sessionId);
    session = result.session;
    context = result.context;
  } else {
    session = await loadTaskSession(root, event.sessionId);
    if (event.phase === 'before_context') {
      context = await buildTaskContext(root, session.task);
      session = await updateTaskSession({ ...session, context }, 'before_context');
    } else if (event.phase === 'before_edit') {
      session = await predictTaskImpact(root, session, event.files ?? []);
      impact = session.predictedImpact;
    } else if (event.phase === 'after_edit') {
      session = await checkpointTask(root, session, event.files ?? []);
      impact = session.actualImpact;
      comparison = session.comparison;
    } else if (event.phase === 'after_test') {
      for (const observation of event.testResults ?? []) session = await recordTaskTest(session, observation);
    } else if (event.phase === 'after_task') {
      session = await finishTask(session, event.task, event.learnedFacts?.[0]);
      experience = await buildTaskExperience(root, session, event.task);
    }
  }
  return { session, context, impact, comparison, experience, warnings };
}

async function saveAndReturn(session: TaskSession, updateActive = false, persist = true): Promise<TaskSession> {
  if (persist) await saveTaskSession(session, { updateActive });
  return session;
}

function summarizeDiff(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .filter((line) => /^(\+\+\+|---|\+[^+]|-[^-])/.test(line))
    .slice(0, 80);
}
