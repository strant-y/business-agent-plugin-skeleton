import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Confidence } from './types.js';

export type EvidenceKind = 'source' | 'test' | 'diff' | 'schema' | 'task' | 'runtime' | 'human' | 'history';
export type EvidenceStrength = 'direct' | 'linked' | 'inferred';

export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  strength?: EvidenceStrength;
  file?: string;
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
  commit?: string;
  taskId?: string;
  eventId?: string;
  description?: string;
  capturedAt: string;
  contentHash?: string;
}

export interface EvidenceValidation {
  valid: boolean;
  warnings: string[];
  contentHash?: string;
}

export interface EvidenceScorer {
  readonly name: string;
  score(evidence: string[], context?: { text?: string; count?: number }): Confidence;
}

export const heuristicScorer: EvidenceScorer = {
  name: 'heuristic',
  score(evidence, context) {
    const count = context?.count ?? evidence.length;
    const hasCodeRef = evidence.some((e) => /\.(ts|tsx|js|jsx|vue|java|sql|xml)$/i.test(e));
    const hasText = evidence.some((e) => e.trim().length > 0);
    if (hasText && hasCodeRef && count >= 3) return 'high';
    if (hasText && (hasCodeRef || count >= 1)) return 'medium';
    return 'low';
  },
};

export function contentHash(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeEvidenceItem(item: string | EvidenceRef, kind: EvidenceKind, index: number): EvidenceRef {
  if (typeof item !== 'string') {
    return {
      ...item,
      kind: item.kind ?? kind,
      capturedAt: item.capturedAt || new Date().toISOString(),
      strength: item.strength ?? (kind === 'human' ? 'direct' : 'linked'),
    };
  }
  const match = item.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  const file = match?.[1] ?? item;
  const lineStart = match ? Number(match[2]) : undefined;
  const lineEnd = match?.[3] ? Number(match[3]) : undefined;
  return {
    id: `evidence-${contentHash(item).slice(0, 16)}-${index}`,
    kind,
    strength: kind === 'human' ? 'direct' : 'linked',
    file,
    lineStart,
    lineEnd,
    capturedAt: new Date().toISOString(),
  };
}

export function normalizeEvidence(
  value: string | EvidenceRef | Array<string | EvidenceRef>,
  kind: EvidenceKind = 'source',
): EvidenceRef[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item, index) => normalizeEvidenceItem(item, kind, index));
}

export async function validateEvidence(evidence: EvidenceRef, root?: string): Promise<EvidenceValidation> {
  const warnings: string[] = [];
  if (!evidence || typeof evidence !== 'object') {
    return { valid: false, warnings: ['Evidence must be an object.'] };
  }
  if (!evidence.id || !evidence.kind || !evidence.capturedAt)
    warnings.push('Evidence requires id, kind and capturedAt.');
  if (evidence.lineStart !== undefined && evidence.lineStart < 1) warnings.push('lineStart must be positive.');
  if (evidence.lineEnd !== undefined && evidence.lineEnd < (evidence.lineStart ?? 1))
    warnings.push('lineEnd must not precede lineStart.');
  if (evidence.lineStart !== undefined && evidence.lineStart !== Math.floor(evidence.lineStart))
    warnings.push('lineStart must be an integer.');
  if (evidence.lineEnd !== undefined && evidence.lineEnd !== Math.floor(evidence.lineEnd))
    warnings.push('lineEnd must be an integer.');
  if (
    evidence.lineStart !== undefined &&
    evidence.lineEnd !== undefined &&
    evidence.lineEnd - evidence.lineStart > 5000
  )
    warnings.push('Evidence span is too large.');
  let hash: string | undefined;
  if (evidence.file && root) {
    const file = path.resolve(root, evidence.file);
    try {
      const text = await fs.readFile(file, 'utf8');
      hash = contentHash(text);
      const lines = text.split(/\r?\n/);
      if (evidence.contentHash && evidence.contentHash !== hash) warnings.push('Evidence content hash changed.');
      if (evidence.lineStart && evidence.lineStart > lines.length) warnings.push('Evidence line is outside the file.');
      if (evidence.lineEnd && evidence.lineEnd > lines.length)
        warnings.push('Evidence line range is outside the file.');
      if (evidence.snippet) {
        const snippet = evidence.snippet.trim();
        const hasSnippet =
          snippet.length > 0 && (text.includes(snippet) || lines.some((line) => line.includes(snippet)));
        if (!hasSnippet) warnings.push('Evidence snippet was not found.');
      }
    } catch {
      warnings.push(`Evidence file not found: ${evidence.file}`);
    }
  }
  return { valid: warnings.length === 0, warnings, contentHash: hash };
}
