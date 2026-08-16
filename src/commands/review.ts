import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import process from 'node:process';
import { exists, readText } from '../utils/fs.js';
import { parseCandidate } from '../core/candidate.js';
import { candidateReviewKey, loadReviewState, markReviewed, saveReviewState } from '../core/review.js';
import { promoteCommand } from './promote.js';
import type { BusinessRule, Confidence } from '../core/types.js';

export interface ReviewOptions {
  nonInteractive?: boolean;
  accept?: Confidence;
  reject?: Confidence;
  json?: boolean;
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export async function reviewCommand(root: string, options: ReviewOptions = {}): Promise<void> {
  const agentRoot = path.join(root, '.agent');
  const candidatesDir = path.join(agentRoot, 'memory', 'candidates');
  const state = await loadReviewState(agentRoot);
  const candidates = await loadCandidates(candidatesDir, state);
  if (!candidates.length) {
    console.log('No unreviewed candidates.');
    return;
  }

  const decisions = options.nonInteractive
    ? await decideBatch(candidates, options)
    : await decideInteractive(candidates);
  const results: Array<{ slug: string; name: string; decision: Decision['decision']; confidence: Confidence }> = [];
  for (const item of decisions) {
    if (item.decision === 'accepted') {
      await promoteCommand(root, item.item.slug, {
        entity: item.item.rule.entity === 'Unknown' ? undefined : item.item.rule.entity,
      });
    } else {
      await rejectCandidate(item.item.file);
    }
    markReviewed(state, item.item.rule, item.decision, item.item.slug);
    results.push({
      slug: item.item.slug,
      name: item.item.rule.name,
      decision: item.decision,
      confidence: item.item.rule.confidence,
    });
  }
  await saveReviewState(agentRoot, state);
  if (options.json) console.log(JSON.stringify({ reviewed: results.length, results }, null, 2));
  else {
    for (const result of results) console.log(`${result.decision}: ${result.name} [${result.confidence}]`);
    console.log(
      `Reviewed ${results.length}, promoted ${results.filter((r) => r.decision === 'accepted').length}, rejected ${results.filter((r) => r.decision === 'rejected').length}, pending ${candidates.length - results.length}`,
    );
  }
}

interface CandidateItem {
  slug: string;
  rule: BusinessRule;
  content: string;
  file: string;
}

interface Decision {
  item: CandidateItem;
  decision: 'accepted' | 'rejected';
}

async function loadCandidates(
  candidatesDir: string,
  state: Awaited<ReturnType<typeof loadReviewState>>,
): Promise<CandidateItem[]> {
  const manifestFile = path.join(candidatesDir, '..', 'discovery-manifest.json');
  if (!(await exists(manifestFile)) || !(await exists(candidatesDir))) return [];
  const manifest = JSON.parse(await readText(manifestFile)) as { rules?: BusinessRule[] };
  const entries = await fs.readdir(candidatesDir, { withFileTypes: true });
  const out: CandidateItem[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const slug = entry.name.slice(0, -3);
    const content = await readText(path.join(candidatesDir, entry.name));
    if (content.includes('Status: promoted') || content.includes('Status: rejected')) continue;
    const parsed = parseCandidate(content, slug);
    const rule = manifest.rules?.find((candidate) => candidate.id.replace(/[^a-z0-9-]/gi, '-') === slug);
    if (rule && !state.decisions[candidateReviewKey(rule)]) {
      out.push({
        slug,
        rule: { ...rule, context: parsed.context },
        content,
        file: path.join(candidatesDir, entry.name),
      });
    }
  }
  return out;
}

async function rejectCandidate(file: string): Promise<void> {
  const rejectedDir = path.join(path.dirname(file), 'rejected');
  await fs.mkdir(rejectedDir, { recursive: true });
  await fs.rename(file, path.join(rejectedDir, path.basename(file)));
}

async function decideBatch(candidates: CandidateItem[], options: ReviewOptions): Promise<Decision[]> {
  const accept = options.accept;
  const reject = options.reject;
  if (!accept && !reject)
    throw new Error('Non-interactive review requires --accept <high|medium|low> or --reject <high|medium|low>.');
  return candidates
    .filter(
      (item) =>
        (accept && RANK[item.rule.confidence] >= RANK[accept]) ||
        (reject && RANK[item.rule.confidence] <= RANK[reject]),
    )
    .map((item) => ({
      item,
      decision: accept && RANK[item.rule.confidence] >= RANK[accept] ? 'accepted' : 'rejected',
    }));
}

async function decideInteractive(candidates: CandidateItem[]): Promise<Decision[]> {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  const decisions: Decision[] = [];
  try {
    for (const item of candidates) {
      console.log(`\n${item.rule.name} [${item.rule.confidence}] (${item.rule.entity})`);
      console.log(item.rule.rule.map((line) => `Rule: ${line}`).join('\n'));
      console.log((item.rule.context ?? []).map((line) => `Context: ${line}`).join('\n'));
      const answer = (await input.question('Accept, reject, or skip? [a/r/s] ')).trim().toLowerCase();
      if (answer === 'a' || answer === 'accept') decisions.push({ item, decision: 'accepted' });
      if (answer === 'r' || answer === 'reject') decisions.push({ item, decision: 'rejected' });
    }
  } finally {
    input.close();
  }
  return decisions;
}
