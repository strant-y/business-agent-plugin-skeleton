import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exists, readText, writeJson } from '../utils/fs.js';
import { buildImpactReport, type ImpactReport } from './impact.js';
import { writeLearnCandidate } from '../commands/learn.js';
import { gitDiffFiles, gitDiffText, gitBranch } from '../utils/git.js';
import type { BusinessRule, DiscoverManifest, Entity, Relation } from './types.js';

const run = promisify(execFile);

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
  predictedImpact: string[];
  actualImpact: string[];
  testsRun: TestObservation[];
  lessons: string[];
  learnedFacts: string[];
  humanCorrections: string[];
  createdAt: string;
}

export interface ImpactComparison {
  predicted: string[];
  actual: string[];
  missed: string[];
  unexpected: string[];
}

export interface TaskLifecycleEvent {
  taskId: string;
  sessionId?: string;
  phase: TaskPhase;
  task: string;
  files?: string[];
  diff?: string;
  testResults?: TestObservation[];
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
  history: string[];
  questions: string[];
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
  const file = path.join(root, '.agent', 'memory', 'discovery-manifest.json');
  if (!(await exists(file))) return undefined;
  try {
    return JSON.parse(await readText(file)) as DiscoverManifest;
  } catch {
    return undefined;
  }
}

async function listHistory(root: string, terms: string[]): Promise<string[]> {
  const dir = path.join(root, '.agent', 'memory', 'task-history');
  if (!(await exists(dir))) return [];
  const fs = await import('node:fs/promises');
  const files = (await fs.readdir(dir))
    .filter((file) => file.endsWith('.md'))
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
  const history = await listHistory(root, terms);
  const questions = rules
    .filter((rule) => rule.status !== 'confirmed')
    .map((rule) => `Verify candidate rule: ${rule.name}`);
  return { task, entities, rules, relations, history, questions };
}

export async function saveTaskSession(session: TaskSession): Promise<string> {
  const file = sessionFile(session.root, session.sessionId);
  await writeJson(file, session);
  await writeJson(activeFile(session.root), {
    sessionId: session.sessionId,
    taskId: session.taskId,
    updatedAt: session.updatedAt,
  });
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

export async function startTask(
  root: string,
  task: string,
  sessionId?: string,
  dryRun = false,
): Promise<{ session: TaskSession; context: TaskContext }> {
  const now = new Date().toISOString();
  const id = sessionId ?? `${slug(task)}-${now.replace(/\D/g, '').slice(0, 14)}`;
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
  if (!dryRun) await saveTaskSession(withContext);
  return { session: withContext, context };
}

export async function updateTaskSession(session: TaskSession, phase: TaskPhase): Promise<TaskSession> {
  const updated = { ...session, phase, updatedAt: new Date().toISOString() };
  await saveTaskSession(updated);
  return updated;
}

export async function predictTaskImpact(root: string, session: TaskSession, files: string[]): Promise<TaskSession> {
  const changedFiles = files.length ? files : await gitDiffFiles(root);
  const report = await buildImpactReport(root, changedFiles);
  return saveAndReturn({
    ...session,
    phase: 'before_edit',
    predictedFiles: changedFiles,
    predictedImpact: report,
    changedFiles,
    updatedAt: new Date().toISOString(),
  });
}

export async function checkpointTask(root: string, session: TaskSession, files: string[]): Promise<TaskSession> {
  const changedFiles = files.length ? files : await gitDiffFiles(root);
  const report = await buildImpactReport(root, changedFiles);
  const diff = await gitDiffText(root);
  const diffSummary = summarizeDiff(diff);
  const comparison = compareImpact(session.predictedImpact, report);
  return saveAndReturn({
    ...session,
    phase: 'after_edit',
    changedFiles,
    actualImpact: report,
    comparison,
    diff,
    diffSummary,
    updatedAt: new Date().toISOString(),
  });
}

export async function recordTaskTest(
  session: TaskSession,
  observation: Omit<TestObservation, 'timestamp'>,
): Promise<TaskSession> {
  return saveAndReturn({
    ...session,
    phase: 'after_test',
    tests: [...session.tests, { ...observation, timestamp: new Date().toISOString() }],
    updatedAt: new Date().toISOString(),
  });
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
  return {
    predicted: [...predictedNodes],
    actual: [...actualNodes],
    missed: [...actualNodes].filter((item) => !predictedNodes.has(item)),
    unexpected: [...predictedNodes].filter((item) => !actualNodes.has(item)),
  };
}

export async function runTaskValidation(session: TaskSession, commands: string[]): Promise<TaskSession> {
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
      current = await recordTaskTest(current, {
        command,
        passed: true,
        summary: `Completed in ${Date.now() - started}ms`,
        output: `${result.stdout}${result.stderr}`.slice(-8000),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      current = await recordTaskTest(current, {
        command,
        passed: false,
        summary: detail,
        output: detail.slice(-8000),
      });
    }
  }
  return current;
}

export async function finishTask(session: TaskSession, message?: string, learned?: string): Promise<TaskSession> {
  const completed = {
    ...session,
    phase: 'after_task' as const,
    status: 'completed' as const,
    updatedAt: new Date().toISOString(),
    learnedFacts: learned ? [...session.learnedFacts, learned] : session.learnedFacts,
  };
  const result = await saveAndReturn(completed);
  const candidates: string[] = [];
  if (learned) {
    candidates.push(
      await writeLearnCandidate(session.root, learned, {
        evidence: result.changedFiles.length ? result.changedFiles : ['Captured during task lifecycle.'],
        source: 'task-capture',
        dryRun: false,
      }),
    );
  }
  const experience = buildTaskExperience(result, message);
  await writeJson(path.join(session.root, '.agent', 'memory', 'task-history', `${session.sessionId}.json`), {
    ...experience,
    session: result,
    candidates,
  });
  await writeJson(
    path.join(session.root, '.agent', 'business', 'experiences', `${session.sessionId}.json`),
    experience,
  );
  return result;
}

function buildTaskExperience(session: TaskSession, message?: string): TaskExperience {
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
    predictedImpact: predicted?.chain.map((step) => step.node) ?? [],
    actualImpact: actual?.chain.map((step) => step.node) ?? [],
    testsRun: session.tests,
    lessons: session.comparison?.missed.length
      ? [`Impact analysis missed: ${session.comparison.missed.join(', ')}`]
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
      experience = buildTaskExperience(session, event.task);
    }
  }
  return { session, context, impact, comparison, experience, warnings };
}

async function saveAndReturn(session: TaskSession): Promise<TaskSession> {
  await saveTaskSession(session);
  return session;
}

function summarizeDiff(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .filter((line) => /^(\+\+\+|---|\+[^+]|-[^-])/.test(line))
    .slice(0, 80);
}
