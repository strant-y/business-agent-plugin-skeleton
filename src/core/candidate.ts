import {
  normalizeRelationship,
  type BusinessRule,
  type LegacyRelationshipKind,
  type Relation,
  type RelationshipKind,
} from './types.js';

export interface ParsedCandidate {
  name: string;
  entity?: string;
  hypothesis: string[];
  evidence: string[];
  impact: string[];
  context: string[];
  verification: string[];
}

export function parseCandidate(content: string, fallbackName: string): ParsedCandidate {
  const nameMatch = content.match(/^#\s*Candidate:\s*(.+)$/m);
  // `$(?![\s\S])` matches the true end of the string even with the /m flag,
  // so the final section of the candidate is parsed correctly.
  const section = (heading: string): string[] => {
    const re = new RegExp(`^##\\s*${heading}\\s*$([\\s\\S]*?)(?=^##|$(?![\\s\\S]))`, 'm');
    const m = content.match(re);
    if (!m) return [];
    return m[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('-'))
      .map((line) => line.replace(/^-\s*/, ''));
  };
  const entityMatch = content.match(/^##\s*Entity\s*$([\s\S]*?)(?=^##|$(?![\s\S]))/m);
  const entityLine = entityMatch?.[1]
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('-'));
  return {
    name: nameMatch?.[1]?.trim() ?? fallbackName,
    entity: entityLine,
    hypothesis: section('Hypothesis'),
    evidence: section('Evidence'),
    impact: section('Impact'),
    context: section('Context'),
    verification: section('Verification'),
  };
}

export interface PromoteRuleInput {
  name: string;
  entity: string;
  candidate: ParsedCandidate;
  confidence?: BusinessRule['confidence'];
  evidence?: string[];
  context?: string[];
  /** Stable hint (e.g. the candidate file slug) used when the name itself is not slug-safe. */
  idHint?: string;
}

/** Deterministic 32-bit FNV-1a hash rendered in base36; keeps generated ids stable across runs. */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Slugify a candidate name into a rule id fragment. Non-ASCII names (e.g.
 * Chinese titles) produce an empty naive slug, so callers can pass a stable
 * hint (the candidate file slug); as a last resort a deterministic hash of
 * the original name guarantees unique, predictable ids instead of a shared
 * `promoted-rule` fallback that would overwrite previously promoted rules.
 */
export function ruleIdSlug(name: string, hint?: string): string {
  const fromName =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || '';
  if (fromName) return fromName;
  const fromHint =
    (hint ?? '')
      .replace(/^rule\./i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || '';
  if (fromHint) return fromHint;
  return `candidate-${stableHash(name)}`;
}

export function buildRuleFromCandidate(input: PromoteRuleInput): BusinessRule {
  const slug = ruleIdSlug(input.name, input.idHint);
  const evidence = input.evidence ?? input.candidate.evidence;
  return {
    id: `rule.${slug}`,
    name: input.name,
    entity: input.entity,
    rule: input.candidate.hypothesis.length ? input.candidate.hypothesis : [input.name],
    impact: input.candidate.impact.length
      ? input.candidate.impact
      : ['Review related UI, API, service, and database code.'],
    evidence: evidence.length ? evidence : ['Promoted from candidate'],
    context: input.context ?? input.candidate.context,
    confidence: input.confidence ?? 'medium',
    status: 'confirmed',
  };
}

export interface PromoteRelationInput {
  source: string;
  target: string;
  relationship: RelationshipKind | LegacyRelationshipKind;
  cardinality: Relation['cardinality'];
  confidence?: Relation['confidence'];
  evidence?: string[];
  description?: string;
}

export function buildRelationFromInput(input: PromoteRelationInput): Relation {
  return {
    id: `relation.${input.source.toLowerCase()}-${input.target.toLowerCase()}`,
    source: input.source,
    target: input.target,
    relationship: normalizeRelationship(input.relationship),
    cardinality: input.cardinality,
    description: input.description ?? `Confirmed business relationship between ${input.source} and ${input.target}.`,
    confidence: input.confidence ?? 'medium',
    evidence: input.evidence ?? [],
  };
}

export function candidateSlug(candidate: string): string {
  return (
    candidate
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `candidate-${Date.now()}`
  );
}
