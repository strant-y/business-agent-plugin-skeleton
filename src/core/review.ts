import path from 'node:path';
import type { BusinessRule, Confidence } from './types.js';
import { exists, readText, writeJson, writeText } from '../utils/fs.js';
import { safeFileId } from './knowledge.js';
import { applyCandidateStatus, isResolvedCandidateStatus, type CandidateStatus } from './candidate-status.js';

export type ReviewDecision = 'accepted' | 'rejected';

const REVIEW_STATE_FILE = path.join('memory', 'review-state.json');

export interface PersistedCandidate {
  slug: string;
  file: string;
  rule: BusinessRule;
}

export interface ReviewStateEntry {
  slug: string;
  decision: ReviewDecision;
  updatedAt: string;
  candidateName: string;
  entity: string;
  confidence: Confidence;
  /** v2: stable candidate id (front matter candidateId or file slug). */
  candidateId?: string;
  /** v2: canonical candidate status; `needs-verification` counts as still pending. */
  status?: CandidateStatus;
  /** v2: rule the candidate was promoted into / covered by. */
  targetRuleId?: string;
  /** v2: human-readable review reason. */
  reason?: string;
  /** v2: who made the decision. */
  reviewedBy?: string;
}

export interface ReviewState {
  decisions: Record<string, ReviewStateEntry>;
}

/** Legacy key: derived from the manifest rule's {entity,name} pair. */
export function candidateReviewKey(rule: Pick<BusinessRule, 'entity' | 'name'>): string {
  return JSON.stringify({ entity: rule.entity, name: rule.name });
}

/** v2 key: the stable candidate id; survives manifest rebuilds and renames. */
export function candidateStateKey(candidateId: string): string {
  return `candidateId:${candidateId}`;
}

export async function loadReviewState(agentRoot: string): Promise<ReviewState> {
  const file = path.join(agentRoot, REVIEW_STATE_FILE);
  if (!(await exists(file))) return { decisions: {} };
  try {
    const parsed = JSON.parse(await readText(file)) as ReviewState;
    if (!parsed || typeof parsed !== 'object' || !parsed.decisions || typeof parsed.decisions !== 'object') {
      return { decisions: {} };
    }
    return parsed;
  } catch {
    return { decisions: {} };
  }
}

export async function saveReviewState(agentRoot: string, state: ReviewState): Promise<void> {
  await writeJson(path.join(agentRoot, REVIEW_STATE_FILE), state);
}

/**
 * Look up a review decision: the stable candidateId key wins, the legacy
 * {entity,name} key is the fallback so pre-v2 state files keep working.
 */
export function findDecision(
  state: ReviewState,
  candidateId: string,
  rule: Pick<BusinessRule, 'entity' | 'name'>,
): ReviewStateEntry | undefined {
  return state.decisions[candidateStateKey(candidateId)] ?? state.decisions[candidateReviewKey(rule)];
}

/** A decision is "resolved" when the candidate no longer needs attention (needs-verification stays pending). */
export function isResolvedDecision(entry: ReviewStateEntry): boolean {
  if (entry.status) return isResolvedCandidateStatus(entry.status);
  return entry.decision === 'accepted' || entry.decision === 'rejected';
}

export function applyReviewState(rules: BusinessRule[], state: ReviewState): BusinessRule[] {
  return rules.filter((rule) => !state.decisions[candidateReviewKey(rule)]);
}

export function shouldAutoPromote(rule: BusinessRule, mode: 'never' | 'high' | 'medium'): boolean {
  if (mode === 'never') return false;
  if (mode === 'high') return rule.confidence === 'high';
  return rule.confidence === 'high' || rule.confidence === 'medium';
}

export function mergeCandidateRules(rules: BusinessRule[]): BusinessRule[] {
  const merged = new Map<string, BusinessRule>();
  for (const rule of rules) {
    const key = `${rule.entity}|${rule.name}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...rule,
        rule: [...rule.rule],
        evidence: [...rule.evidence],
        impact: [...(rule.impact ?? [])],
        context: [...(rule.context ?? [])],
      });
      continue;
    }
    existing.evidence = uniqStrings([...existing.evidence, ...rule.evidence]);
    existing.impact = uniqStrings([...(existing.impact ?? []), ...(rule.impact ?? [])]);
    existing.context = uniqStrings([...(existing.context ?? []), ...(rule.context ?? [])]);
    existing.confidence = strongerConfidence(existing.confidence, rule.confidence);
    existing.rule = uniqStrings([...existing.rule, ...rule.rule]);
  }
  return [...merged.values()];
}

function strongerConfidence(a: Confidence, b: Confidence): Confidence {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function uniqStrings(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}

export function buildCandidateContext(rule: BusinessRule): string[] {
  const lines = uniqStrings(rule.context ?? []);
  if (lines.length) return lines;
  const evidence = uniqStrings(rule.evidence.map((item) => `${item}: matched candidate rule signal`));
  return evidence.length ? evidence : ['Review the cited code paths before promoting this candidate.'];
}

export async function writeCandidate(
  agentRoot: string,
  rule: BusinessRule,
  markdown: (rule: BusinessRule) => string,
): Promise<PersistedCandidate> {
  const slug = safeFileId(rule.id);
  const file = path.join(agentRoot, 'memory', 'candidates', `${slug}.md`);
  const body = markdown({ ...rule, context: buildCandidateContext(rule) });
  // Every written candidate carries stable metadata (candidateId + status) in
  // YAML front matter so reviews survive manifest rebuilds and renames.
  const withMeta = applyCandidateStatus(body, `${slug}.md`, { status: 'candidate' });
  await writeText(file, withMeta);
  return { slug, file, rule };
}

export interface MarkReviewedInput {
  decision: ReviewDecision;
  slug: string;
  /** v2 extensions; when present the decision is also keyed by stable candidateId. */
  candidateId?: string;
  status?: CandidateStatus;
  targetRuleId?: string;
  reason?: string;
  reviewedBy?: string;
}

export function markReviewed(
  state: ReviewState,
  rule: Pick<BusinessRule, 'name' | 'entity' | 'confidence'>,
  input: MarkReviewedInput,
): ReviewState {
  const entry: ReviewStateEntry = {
    slug: input.slug,
    decision: input.decision,
    updatedAt: new Date().toISOString(),
    candidateName: rule.name,
    entity: rule.entity,
    confidence: rule.confidence,
    candidateId: input.candidateId,
    status: input.status,
    targetRuleId: input.targetRuleId,
    reason: input.reason,
    reviewedBy: input.reviewedBy,
  };
  state.decisions[candidateReviewKey(rule)] = entry;
  if (input.candidateId)
    state.decisions[candidateStateKey(input.candidateId)] = { ...entry, candidateId: input.candidateId };
  return state;
}
