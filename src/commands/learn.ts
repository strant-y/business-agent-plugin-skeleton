import path from 'node:path';
import { ensureDir, writeText } from '../utils/fs.js';
import { candidateSlug } from '../core/candidate.js';

export interface LearnOptions {
  entity?: string;
  evidence?: string[];
  source?: 'task-capture' | 'human-confirmed' | 'agent-observation';
  dryRun?: boolean;
}

export function learnCandidateContent(
  statement: string,
  options: Pick<LearnOptions, 'entity' | 'evidence' | 'source'> = {},
): string {
  const evidence = options.evidence?.length ? options.evidence : ['Recorded from agent/user review.'];
  return [
    `# Candidate: ${statement}`,
    '',
    `Status: candidate`,
    `Source: ${options.source ?? 'agent-observation'}`,
    '',
    '## Entity',
    options.entity ?? 'Unknown',
    '',
    '## Hypothesis',
    `- ${statement}`,
    '',
    '## Evidence',
    ...evidence.map((item) => `- ${item}`),
    '',
    '## Context',
    '- Captured manually during agent work; verify against the implementation.',
    '',
    '## Impact',
    '- Review related frontend, API, service, and database areas.',
    '',
    '## Verification',
    '- Confirm with the business owner or existing behavior before promotion.',
    '',
  ].join('\n');
}

export async function writeLearnCandidate(
  root: string,
  statement: string,
  options: LearnOptions = {},
): Promise<string> {
  const slug = candidateSlug(statement);
  const file = path.join(root, '.agent', 'memory', 'candidates', `${slug}.md`);
  if (!options.dryRun) {
    await ensureDir(path.dirname(file));
    await writeText(file, learnCandidateContent(statement, options));
  }
  return file;
}

export async function learnCommand(
  root: string,
  statement: string | undefined,
  options: LearnOptions = {},
): Promise<void> {
  if (!statement) throw new Error('Usage: business-agent learn <business discovery> [--entity <name>]');
  const file = await writeLearnCandidate(root, statement, options);
  if (options.dryRun) {
    console.log(`Dry run: would create ${file}`);
    return;
  }
  console.log(`Learning candidate created: ${file}`);
}
