import path from 'node:path';
import type { BusinessRule, Confidence } from './types.js';
import { exists, readText, writeJson, writeText } from '../utils/fs.js';
import { safeFileId } from './knowledge.js';

export type ReviewDecision = 'accepted' | 'rejected';

export interface ReviewStateEntry {
  slug: string;
  decision: ReviewDecision;
  updatedAt: string;
  candidateName: string;
  entity: string;
  confidence: Confidence;
}

export interface ReviewState {
  decisions: Record<string, ReviewStateEntry>;
}

export interface PersistedCandidate {
  slug: string;
  file: string;
  rule: BusinessRule;
}

const REVIEW_STATE_FILE = path.join('memory', 'review-state.json');

export function candidateReviewKey(rule: Pick<BusinessRule, 'entity' | 'name'>): string {
  return JSON.stringify({ entity: rule.entity, name: rule.name });
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
  await writeText(file, markdown({ ...rule, context: buildCandidateContext(rule) }));
  return { slug, file, rule };
}

export function markReviewed(
  state: ReviewState,
  rule: BusinessRule,
  decision: ReviewDecision,
  slug: string,
): ReviewState {
  state.decisions[candidateReviewKey(rule)] = {
    slug,
    decision,
    updatedAt: new Date().toISOString(),
    candidateName: rule.name,
    entity: rule.entity,
    confidence: rule.confidence,
  };
  return state;
}
