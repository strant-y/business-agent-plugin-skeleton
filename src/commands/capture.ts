import path from 'node:path';
import { discover } from '../core/discovery.js';
import { buildImpactReport, type ImpactReport } from '../core/impact.js';
import { refreshKnowledgeStateFromEvidence } from '../core/knowledge-state.js';
import { rebuildRetrievalIndex } from '../core/retrieval.js';
import { writeLearnCandidate } from './learn.js';
import { gitDiffFiles } from '../utils/git.js';
import { appendText, ensureDir, readText, writeText } from '../utils/fs.js';

/**
 * Wall-clock budget for a capture run. The post-commit hook runs capture synchronously,
 * so when the run already took longer than this we skip the incremental re-discover
 * instead of making the developer wait on every commit.
 */
export const KNOWLEDGE_REFRESH_BUDGET_MS = 10_000;

/** Refresh log sits next to hook-errors.log. */
const REFRESH_LOG_PATH = ['.agent', 'memory', 'hook-refresh.log'];

/** Keep the append-only log bounded; post-commit runs happen constantly. */
const REFRESH_LOG_MAX_LINES = 200;

export interface KnowledgeRefreshStatus {
  skipped: boolean;
  reason?: string;
  elapsedMs: number;
  staleRecords: number;
  logFile: string;
}

interface RefreshLogEntry {
  timestamp: string;
  skipped: boolean;
  reason?: string;
  elapsedMs: number;
  staleRecords: number;
  records?: string[];
}

export interface CaptureOptions {
  /** Explicit changed files; when omitted, git diff is used. */
  files?: string[];
  /** Use the last commit's diff instead of the working tree (post-commit hook). */
  sinceLastCommit?: boolean;
  /** Agent-provided summary of what the task accomplished. */
  message?: string;
  /** Business fact confirmed during the task; recorded as a reviewable candidate. */
  learn?: string;
  entity?: string;
  quiet?: boolean;
  dryRun?: boolean;
  json?: boolean;
  refreshKnowledge?: boolean;
  /** Overrides {@link KNOWLEDGE_REFRESH_BUDGET_MS}; mainly for tests and slow CI machines. */
  refreshBudgetMs?: number;
}

export interface CaptureSummary {
  record: string;
  learned?: string;
  changedFiles: string[];
  report: ImpactReport;
  refreshedKnowledge?: Array<{ recordId: string; status: string; warnings: string[] }>;
  knowledgeRefresh?: KnowledgeRefreshStatus;
}

function recordMarkdown(report: ImpactReport, message?: string): string {
  const lines = [
    '# Task Capture',
    '',
    `Time: ${new Date().toISOString()}`,
    '',
    '## Task Summary',
    message ?? '- No summary provided.',
    '',
    '## Changed Files',
    ...(report.files.length ? report.files.map((file) => `- ${file}`) : ['- None']),
    '',
    '## Affected Chain',
    ...(report.chain.length
      ? report.chain.map(
          (step) =>
            `- ${step.file} ${step.depth === 0 ? '=' : step.direction === 'out' ? '→' : '←'} ${step.node}` +
            (step.depth > 0 ? ` (${step.relationship}, depth ${step.depth})` : ' (changed module)'),
        )
      : ['- No relation-graph chain; matches rely on file-name evidence.']),
    '',
    '## Affected Entities',
    ...(report.entities.length ? report.entities.map((entity) => `- ${entity}`) : ['- None identified']),
    '',
    '## Affected Rules',
    ...(report.rules.length ? report.rules.map((rule) => `- ${rule.id}: ${rule.name}`) : ['- None identified']),
    '',
    '## Affected Relationships',
    ...(report.relations.length
      ? report.relations.map((relation) => `- ${relation.source} -> ${relation.target} (${relation.relationship})`)
      : ['- None identified']),
    '',
    '## Affected API Routes',
    ...(report.apis.length
      ? report.apis.map((api) => `- ${api.method} ${api.path}${api.entity ? ` (${api.entity})` : ''}`)
      : ['- None identified']),
    '',
    '## Next Steps',
    '- Review pending candidates: `business-agent review`',
    '- Promote verified knowledge: `business-agent promote <candidate>`',
    '- Keep confirmed knowledge current: `business-agent discover --deep`',
    '',
  ];
  return lines.join('\n');
}

function refreshLogFile(root: string): string {
  return path.join(root, ...REFRESH_LOG_PATH);
}

async function appendRefreshLog(root: string, entry: RefreshLogEntry): Promise<void> {
  const file = refreshLogFile(root);
  try {
    await appendText(file, `${JSON.stringify(entry)}\n`);
    const existing = (await readText(file)).split('\n').filter(Boolean);
    if (existing.length > REFRESH_LOG_MAX_LINES) {
      await writeText(file, `${existing.slice(-REFRESH_LOG_MAX_LINES).join('\n')}\n`);
    }
  } catch {
    // Logging must never break a commit hook; fall through silently.
  }
}

export async function captureCommand(root: string, options: CaptureOptions = {}): Promise<CaptureSummary> {
  const startedAt = Date.now();
  const changedFiles = options.files?.length
    ? options.files
    : await gitDiffFiles(root, options.sinceLastCommit ?? false);
  const report = await buildImpactReport(root, changedFiles);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const record = path.join(root, '.agent', 'memory', 'task-history', `${stamp}.md`);
  if (!options.dryRun) {
    await ensureDir(path.dirname(record));
    await writeText(record, recordMarkdown(report, options.message));
  }

  let learned: string | undefined;
  if (options.learn) {
    learned = await writeLearnCandidate(root, options.learn, {
      entity: options.entity,
      evidence: changedFiles.length ? changedFiles : ['Recorded during task capture.'],
      dryRun: options.dryRun,
    });
  }

  let refreshedKnowledge: Array<{ recordId: string; status: string; warnings: string[] }> | undefined;
  let knowledgeRefresh: KnowledgeRefreshStatus | undefined;
  if (options.refreshKnowledge && !options.dryRun) {
    const budget = options.refreshBudgetMs ?? KNOWLEDGE_REFRESH_BUDGET_MS;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > budget) {
      const reason = `Capture took ${elapsedMs}ms, over the ${budget}ms budget; incremental re-discover skipped to keep the commit fast.`;
      if (!options.quiet) console.warn(`Warning: ${reason}`);
      knowledgeRefresh = { skipped: true, reason, elapsedMs, staleRecords: 0, logFile: refreshLogFile(root) };
      await appendRefreshLog(root, {
        timestamp: new Date().toISOString(),
        skipped: true,
        reason,
        elapsedMs,
        staleRecords: 0,
      });
    } else {
      await discover(root, {
        files: changedFiles,
        onWarning: (message) => !options.quiet && console.warn(`Warning: ${message}`),
      });
      refreshedKnowledge = await refreshKnowledgeStateFromEvidence(root, changedFiles);
      await rebuildRetrievalIndex(root);
      const totalElapsedMs = Date.now() - startedAt;
      knowledgeRefresh = {
        skipped: false,
        elapsedMs: totalElapsedMs,
        staleRecords: refreshedKnowledge.length,
        logFile: refreshLogFile(root),
      };
      await appendRefreshLog(root, {
        timestamp: new Date().toISOString(),
        skipped: false,
        elapsedMs: totalElapsedMs,
        staleRecords: refreshedKnowledge.length,
        records: refreshedKnowledge.map((item) => item.recordId),
      });
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          record: options.dryRun ? record : undefined,
          changedFiles,
          learned,
          refreshedKnowledge,
          knowledgeRefresh,
          report,
        },
        null,
        2,
      ),
    );
    return { record, learned, changedFiles, report, refreshedKnowledge, knowledgeRefresh };
  }
  if (options.dryRun) {
    console.log(`Dry run: would write task record${learned ? ' and learning candidate' : ''}`);
  } else if (!options.quiet) {
    console.log(`Task record written to ${record}`);
    if (learned) console.log(`Learning candidate created: ${learned}`);
    if (knowledgeRefresh?.skipped) {
      console.log(`Knowledge refresh skipped: ${knowledgeRefresh.reason}`);
    } else if (refreshedKnowledge?.length) {
      console.log(`Knowledge refreshed: ${refreshedKnowledge.length} record(s) marked stale.`);
    }
  }
  return { record, learned, changedFiles, report, refreshedKnowledge, knowledgeRefresh };
}
