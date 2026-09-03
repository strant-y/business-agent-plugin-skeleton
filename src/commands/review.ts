import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import process from 'node:process';
import { exists, readText, writeText } from '../utils/fs.js';
import { parseCandidate } from '../core/candidate.js';
import { applyCandidateStatus, isResolvedCandidateStatus, resolveCandidateState } from '../core/candidate-status.js';
import {
  findDecision,
  isResolvedDecision,
  loadReviewState,
  markReviewed,
  saveReviewState,
  type ReviewState,
} from '../core/review.js';
import { loadRules } from '../core/knowledge.js';
import { promoteCommand } from './promote.js';
import type { BusinessRule, Confidence } from '../core/types.js';

export interface ReviewOptions {
  nonInteractive?: boolean;
  accept?: Confidence;
  reject?: Confidence;
  json?: boolean;
  /** Single-candidate mode: review exactly this candidate id. */
  candidate?: string;
  /** Single-candidate mode: reject the candidate (boolean form of --reject). */
  rejectFlag?: boolean;
  /** Single-candidate mode: accept/promote the candidate (explicit boolean form). */
  acceptFlag?: boolean;
  /** Single-candidate mode: mark the candidate as covered by an existing rule. */
  coveredBy?: string;
  /** Review reason recorded in review-state and the candidate front matter. */
  reason?: string;
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export async function reviewCommand(root: string, options: ReviewOptions = {}): Promise<void> {
  if (options.candidate) {
    await reviewSingleCandidate(root, options.candidate, options);
    return;
  }
  await reviewBatch(root, options);
}

/* ------------------------------ single candidate ------------------------------ */

async function reviewSingleCandidate(root: string, candidate: string, options: ReviewOptions): Promise<void> {
  const agentRoot = path.join(root, '.agent');
  const candidatesDir = path.join(agentRoot, 'memory', 'candidates');
  const file = path.join(candidatesDir, `${candidate.replace(/\.md$/i, '')}.md`);
  if (!(await exists(file))) {
    throw new Error(`Candidate file not found: ${file}`);
  }
  const content = await readText(file);
  const state = resolveCandidateState(content);
  const candidateId = candidate.replace(/\.md$/i, '');
  const reason = options.reason;

  if (isResolvedCandidateStatus(state.status)) {
    console.log(
      `Candidate "${candidateId}" is already resolved (status: ${state.status}${
        state.targetRuleId ? `, target: ${state.targetRuleId}` : ''
      }). Nothing to do.`,
    );
    return;
  }

  const reviewState = await loadReviewState(agentRoot);
  const parsed = parseCandidate(content, candidateId);

  if (options.coveredBy) {
    const targetId = options.coveredBy.startsWith('rule.') ? options.coveredBy : `rule.${options.coveredBy}`;
    const rules = await loadRules(agentRoot);
    if (!rules.some((rule) => rule.id === targetId)) {
      throw new Error(`Target rule "${targetId}" not found under ${agentRoot}/business/rules/.`);
    }
    await writeText(
      file,
      applyCandidateStatus(content, path.basename(file), {
        status: 'covered',
        targetRuleId: targetId,
        reason,
        reviewedBy: 'cli',
      }),
    );
    recordDecision(reviewState, candidateId, ruleFromCandidate(candidateId, parsed), 'rejected', {
      status: 'covered',
      targetRuleId: targetId,
      reason,
    });
    await saveReviewState(agentRoot, reviewState);
    if (options.json) {
      console.log(
        JSON.stringify({ candidate: candidateId, status: 'covered', targetRuleId: targetId, reason }, null, 2),
      );
      return;
    }
    console.log(`Candidate "${candidateId}" marked as covered by ${targetId}.`);
    return;
  }

  if (options.rejectFlag) {
    const rejectedDir = path.join(candidatesDir, 'rejected');
    await fs.mkdir(rejectedDir, { recursive: true });
    const updated = applyCandidateStatus(content, path.basename(file), {
      status: 'rejected',
      reason,
      reviewedBy: 'cli',
    });
    await writeText(file, updated);
    await fs.rename(file, path.join(rejectedDir, path.basename(file)));
    recordDecision(reviewState, candidateId, ruleFromCandidate(candidateId, parsed), 'rejected', {
      status: 'rejected',
      reason,
    });
    await saveReviewState(agentRoot, reviewState);
    if (options.json) {
      console.log(JSON.stringify({ candidate: candidateId, status: 'rejected', reason }, null, 2));
      return;
    }
    console.log(`Candidate "${candidateId}" rejected.`);
    return;
  }

  // Default (or explicit --accept): promote through the standard promote flow.
  await promoteCommand(root, candidateId, { json: options.json });
}

function recordDecision(
  state: ReviewState,
  candidateId: string,
  rule: BusinessRule,
  decision: 'accepted' | 'rejected',
  extra: {
    status?: 'covered' | 'rejected' | 'promoted' | 'needs-verification';
    targetRuleId?: string;
    reason?: string;
  },
): void {
  markReviewed(state, rule, {
    decision,
    slug: candidateId,
    candidateId,
    status: extra.status,
    targetRuleId: extra.targetRuleId,
    reason: extra.reason,
    reviewedBy: 'cli',
  });
}

/* --------------------------------- batch mode --------------------------------- */

async function reviewBatch(root: string, options: ReviewOptions): Promise<void> {
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
      await rejectCandidate(item.item.file, item.item.slug, options.reason);
    }
    markReviewed(state, item.item.rule, {
      decision: item.decision,
      slug: item.item.slug,
      candidateId: item.item.slug,
      status: item.decision === 'accepted' ? 'promoted' : 'rejected',
      reason: item.decision === 'rejected' ? options.reason : undefined,
      reviewedBy: options.nonInteractive ? 'batch' : 'interactive',
    });
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

function ruleFromCandidate(slug: string, parsed: ReturnType<typeof parseCandidate>): BusinessRule {
  return {
    id: `rule.${slug}`,
    name: parsed.name,
    entity: parsed.entity ?? 'Unknown',
    rule: parsed.hypothesis.length ? parsed.hypothesis : [parsed.name],
    ...(parsed.impact.length ? { impact: parsed.impact } : {}),
    evidence: parsed.evidence,
    context: parsed.context,
    confidence: 'low',
    status: 'candidate',
  };
}

/**
 * Load pending candidates using the unified status resolver: front matter,
 * English `Status:` lines and Chinese `状态:` lines are all recognized, and
 * candidates missing any status marker default to pending instead of being
 * silently skipped. Manifest lookup is a hint, not a requirement.
 */
async function loadCandidates(
  candidatesDir: string,
  state: Awaited<ReturnType<typeof loadReviewState>>,
): Promise<CandidateItem[]> {
  if (!(await exists(candidatesDir))) return [];
  const manifestFile = path.join(candidatesDir, '..', 'discovery-manifest.json');
  let manifestRules: BusinessRule[] | undefined;
  if (await exists(manifestFile)) {
    try {
      manifestRules = (JSON.parse(await readText(manifestFile)) as { rules?: BusinessRule[] }).rules;
    } catch {
      // Manifest is optional for candidate review; fall back to file content.
    }
  }
  const entries = await fs.readdir(candidatesDir, { withFileTypes: true });
  const out: CandidateItem[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const slug = entry.name.slice(0, -3);
    const file = path.join(candidatesDir, entry.name);
    const content = await readText(file);
    const resolved = resolveCandidateState(content);
    if (isResolvedCandidateStatus(resolved.status)) continue;
    const parsed = parseCandidate(content, slug);
    const manifestRule = manifestRules?.find((candidate) => candidate.id.replace(/[^a-z0-9-]/gi, '-') === slug);
    const rule: BusinessRule = manifestRule
      ? { ...manifestRule, context: parsed.context }
      : ruleFromCandidate(slug, parsed);
    const decision = findDecision(state, slug, rule);
    if (decision && isResolvedDecision(decision)) continue;
    out.push({ slug, rule, content, file });
  }
  return out;
}

async function rejectCandidate(file: string, slug: string, reason?: string): Promise<void> {
  const rejectedDir = path.join(path.dirname(file), 'rejected');
  await fs.mkdir(rejectedDir, { recursive: true });
  const content = await readText(file);
  const updated = applyCandidateStatus(content, path.basename(file), {
    status: 'rejected',
    reason,
    reviewedBy: 'review',
  });
  await writeText(file, updated);
  await fs.rename(file, path.join(rejectedDir, path.basename(file)));
  void slug;
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
