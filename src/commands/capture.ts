import path from 'node:path';
import { buildImpactReport, type ImpactReport } from '../core/impact.js';
import { writeLearnCandidate } from './learn.js';
import { gitDiffFiles } from '../utils/git.js';
import { ensureDir, writeText } from '../utils/fs.js';

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
}

export interface CaptureSummary {
  record: string;
  learned?: string;
  changedFiles: string[];
  report: ImpactReport;
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

export async function captureCommand(root: string, options: CaptureOptions = {}): Promise<CaptureSummary> {
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

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          record: options.dryRun ? record : undefined,
          changedFiles,
          learned,
          report,
        },
        null,
        2,
      ),
    );
    return { record, learned, changedFiles, report };
  }
  if (options.dryRun) {
    console.log(`Dry run: would write task record${learned ? ' and learning candidate' : ''}`);
  } else if (!options.quiet) {
    console.log(`Task record written to ${record}`);
    if (learned) console.log(`Learning candidate created: ${learned}`);
  }
  return { record, learned, changedFiles, report };
}
