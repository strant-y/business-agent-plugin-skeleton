import path from 'node:path';
import { exists, readText } from '../utils/fs.js';

/**
 * Unified candidate status resolution.
 *
 * A single source of truth for reading candidate metadata from markdown files
 * (YAML front matter first, legacy `Status:` lines second) so that review,
 * audit, retrieval and index commands all agree on what is pending and what
 * has been resolved.
 */

export type CandidateStatus = 'candidate' | 'needs-verification' | 'approved' | 'covered' | 'rejected' | 'promoted';

export const CANDIDATE_STATUSES: readonly CandidateStatus[] = [
  'candidate',
  'needs-verification',
  'approved',
  'covered',
  'rejected',
  'promoted',
];

/** Statuses that still require human attention. */
export const PENDING_CANDIDATE_STATUSES: readonly CandidateStatus[] = ['candidate', 'needs-verification'];

/** Statuses that must not resurface as reviewable candidates or retrieval hits. */
export const RESOLVED_CANDIDATE_STATUSES: readonly CandidateStatus[] = ['approved', 'covered', 'rejected', 'promoted'];

export function isPendingCandidateStatus(status: CandidateStatus): boolean {
  return (PENDING_CANDIDATE_STATUSES as readonly string[]).includes(status);
}

export function isResolvedCandidateStatus(status: CandidateStatus): boolean {
  return (RESOLVED_CANDIDATE_STATUSES as readonly string[]).includes(status);
}

export function isCandidateStatus(value: unknown): value is CandidateStatus {
  return typeof value === 'string' && (CANDIDATE_STATUSES as readonly string[]).includes(value);
}

/** Structured metadata read from a candidate's YAML front matter block. */
export interface CandidateFrontMatter {
  candidateId?: string;
  status?: CandidateStatus;
  confidence?: string;
  reviewedAt?: string;
  targetRuleId?: string;
  reason?: string;
  reviewedBy?: string;
}

/** Fully resolved state of one candidate markdown file. */
export interface ResolvedCandidateState extends CandidateFrontMatter {
  status: CandidateStatus;
  /** Which source provided the status (front matter wins over legacy lines). */
  source: 'front-matter' | 'status-line' | 'default';
}

/**
 * Extract the YAML front matter block (`---` delimited) as a flat key/value
 * map. Only scalar `key: value` pairs are supported; lists and nesting are
 * ignored on purpose (zero-dependency, candidates only need scalar metadata).
 */
export function parseFrontMatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line
      .slice(sep + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Normalize free-text status spellings (English/Chinese, legacy composites
 * like `promoted as rule.x`) into the canonical status enum. Returns
 * undefined for unrecognized words so callers can fall back to `candidate`.
 */
export function normalizeCandidateStatus(raw: string | undefined): CandidateStatus | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (value.startsWith('promoted') || value.startsWith('approved') || value.startsWith('accepted')) return 'promoted';
  if (value.startsWith('covered')) return 'covered';
  if (value.startsWith('rejected') || value.startsWith('declined')) return 'rejected';
  if (
    value.startsWith('needs-verification') ||
    value.startsWith('needs verification') ||
    value.startsWith('pending-verification')
  )
    return 'needs-verification';
  if (value === 'candidate' || value === 'pending' || value === 'open' || value === 'draft') return 'candidate';
  if (value.includes('已晋级') || value.includes('已采纳') || value.includes('已批准') || value.includes('已通过'))
    return 'promoted';
  if (value.includes('已覆盖') || value.includes('已被覆盖')) return 'covered';
  if (value.includes('已拒绝') || value.includes('已驳回')) return 'rejected';
  if (value.includes('待核验') || value.includes('待验证')) return 'needs-verification';
  if (value.includes('候选') || value.includes('待审核') || value.includes('待评审')) return 'candidate';
  return undefined;
}

/** Pull `rule.<id>` out of composites like `promoted as rule.x` / `covered by rule.y`. */
export function extractTargetRuleId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/\brule\.[a-z0-9-]+/i);
  return match ? match[0].toLowerCase() : undefined;
}

function toFrontMatter(content: string): CandidateFrontMatter {
  const raw = parseFrontMatter(content);
  const out: CandidateFrontMatter = {};
  if (raw.candidateId) out.candidateId = raw.candidateId;
  const status = normalizeCandidateStatus(raw.status);
  if (status) out.status = status;
  if (raw.confidence) out.confidence = raw.confidence;
  if (raw.reviewedAt) out.reviewedAt = raw.reviewedAt;
  if (raw.targetRuleId) out.targetRuleId = raw.targetRuleId;
  else {
    const fromStatus = extractTargetRuleId(raw.status);
    if (fromStatus) out.targetRuleId = fromStatus;
  }
  if (raw.reason) out.reason = raw.reason;
  if (raw.reviewedBy) out.reviewedBy = raw.reviewedBy;
  return out;
}

/**
 * Read the legacy inline status line (`Status: ...`, `> Status: ...` or the
 * Chinese `- 状态: ...` form) plus any promoted/covered target rule id.
 */
function readStatusLine(content: string): { raw?: string; targetRuleId?: string } {
  const match = content.match(/^>?\s*(?:-\s*)?(?:Status|状态)\s*[:：]\s*(.+)$/im);
  if (!match) return {};
  const raw = match[1].trim();
  return { raw, targetRuleId: extractTargetRuleId(raw) };
}

/**
 * Resolve one candidate's state: front matter wins, then the legacy status
 * line, then the `candidate` default. Never throws — malformed metadata
 * degrades to the default status.
 */
export function resolveCandidateState(content: string): ResolvedCandidateState {
  const frontMatter = toFrontMatter(content);
  const statusLine = readStatusLine(content);
  const frontStatus = frontMatter.status;
  if (frontStatus) {
    return {
      ...frontMatter,
      status: frontStatus,
      targetRuleId: frontMatter.targetRuleId ?? statusLine.targetRuleId,
      source: 'front-matter',
    };
  }
  const lineStatus = normalizeCandidateStatus(statusLine.raw);
  if (lineStatus) {
    return {
      ...frontMatter,
      status: lineStatus,
      targetRuleId: frontMatter.targetRuleId ?? statusLine.targetRuleId,
      source: 'status-line',
    };
  }
  return { ...frontMatter, status: 'candidate', targetRuleId: frontMatter.targetRuleId, source: 'default' };
}

/**
 * Stable candidate id: front matter `candidateId` first, then the file base
 * name (slug). The id survives renames only via front matter, which is why
 * every written candidate carries it once reviewed.
 */
export function resolveCandidateId(fileName: string, content: string): string {
  const frontMatter = parseFrontMatter(content);
  const explicit = frontMatter.candidateId?.trim();
  if (explicit) return explicit;
  return path.basename(fileName).replace(/\.md$/i, '');
}

function serializeFrontMatter(meta: CandidateFrontMatter): string {
  const lines = ['---'];
  lines.push(`candidateId: ${meta.candidateId ?? ''}`);
  if (meta.status) lines.push(`status: ${meta.status}`);
  if (meta.confidence) lines.push(`confidence: ${meta.confidence}`);
  if (meta.reviewedAt) lines.push(`reviewedAt: ${meta.reviewedAt}`);
  if (meta.targetRuleId) lines.push(`targetRuleId: ${meta.targetRuleId}`);
  if (meta.reason) lines.push(`reason: ${meta.reason}`);
  if (meta.reviewedBy) lines.push(`reviewedBy: ${meta.reviewedBy}`);
  lines.push('---');
  return lines.join('\n');
}

export interface CandidateStatusPatch {
  status: CandidateStatus;
  targetRuleId?: string;
  reason?: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

/**
 * Rewrite a candidate's metadata in place of the file content: refresh (or
 * insert) the YAML front matter AND keep the legacy inline `Status:` line in
 * sync so older tooling (and `content.includes('Status: promoted')`) still
 * works. Returns the updated markdown.
 */
export function applyCandidateStatus(content: string, fileName: string, patch: CandidateStatusPatch): string {
  const existing = toFrontMatter(content);
  const meta: CandidateFrontMatter = {
    ...existing,
    candidateId: existing.candidateId ?? resolveCandidateId(fileName, content),
    status: patch.status,
    reviewedAt: patch.reviewedAt ?? new Date().toISOString().slice(0, 10),
    targetRuleId: patch.targetRuleId ?? (patch.status === 'candidate' ? undefined : existing.targetRuleId),
    reason: patch.reason ?? (patch.status === 'candidate' ? undefined : existing.reason),
    reviewedBy: patch.reviewedBy ?? existing.reviewedBy,
  };
  const frontMatterBlock = serializeFrontMatter(meta);
  const legacyLine = legacyStatusLine(patch.status, patch.targetRuleId);
  let body = content;
  const fmMatch = body.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (fmMatch) body = body.slice(fmMatch[0].length);
  if (legacyLine) {
    if (/^>?\s*(?:-\s*)?(?:Status|状态)\s*[:：]/im.test(body)) {
      body = body.replace(/^>?\s*(?:-\s*)?(?:Status|状态)\s*[:：]\s*(.+)$/im, legacyLine);
    } else {
      body = `${legacyLine}\n${body}`;
    }
  }
  return `${frontMatterBlock}\n${body}`;
}

function legacyStatusLine(status: CandidateStatus, targetRuleId?: string): string {
  switch (status) {
    case 'promoted':
      return targetRuleId ? `Status: promoted as ${targetRuleId}` : 'Status: promoted';
    case 'approved':
      return targetRuleId ? `Status: approved as ${targetRuleId}` : 'Status: approved';
    case 'covered':
      return targetRuleId ? `Status: covered by ${targetRuleId}` : 'Status: covered';
    case 'rejected':
      return 'Status: rejected';
    case 'needs-verification':
      return 'Status: needs-verification';
    default:
      return 'Status: candidate';
  }
}

export interface CandidateStatusIndexEntry extends ResolvedCandidateState {
  candidateId: string;
  file: string;
  fileName: string;
}

/** All candidate files (including the rejected/ sub-directory) keyed by candidateId. */
export interface CandidateStatusIndex {
  byId: Record<string, CandidateStatusIndexEntry>;
  total: number;
  resolved: number;
  pending: number;
  /** Files carrying a status word the unified parser could not recognize. */
  unknownStatuses: string[];
}

/**
 * Scan a candidates directory and resolve every markdown file's status via
 * the unified parser. Files in `rejected/` keep their recorded status and are
 * indexed too so audit can reconcile the full picture.
 */
export async function scanCandidateDir(candidatesDir: string): Promise<CandidateStatusIndex> {
  const fs = await import('node:fs/promises');
  const index: CandidateStatusIndex = { byId: {}, total: 0, resolved: 0, pending: 0, unknownStatuses: [] };
  if (!(await exists(candidatesDir))) return index;
  const files: string[] = [];
  for (const entry of await fs.readdir(candidatesDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path.join(candidatesDir, entry.name));
    } else if (entry.isDirectory()) {
      const sub = path.join(candidatesDir, entry.name);
      for (const subEntry of await fs.readdir(sub, { withFileTypes: true })) {
        if (subEntry.isFile() && subEntry.name.endsWith('.md')) files.push(path.join(sub, subEntry.name));
      }
    }
  }
  for (const file of files) {
    const content = await readText(file);
    if (!isRecognizedStatusMarker(content)) {
      index.unknownStatuses.push(path.basename(file));
    }
    const state = resolveCandidateState(content);
    const candidateId = resolveCandidateId(file, content);
    index.byId[candidateId] = {
      ...state,
      candidateId,
      file,
      fileName: path.basename(file),
    };
    index.total += 1;
    if (isResolvedCandidateStatus(state.status)) index.resolved += 1;
    else index.pending += 1;
  }
  return index;
}

function isRecognizedStatusMarker(content: string): boolean {
  const fm = parseFrontMatter(content);
  if (fm.status && normalizeCandidateStatus(fm.status) === undefined) return false;
  const line = content.match(/^>?\s*(?:-\s*)?(?:Status|状态)\s*[:：]\s*(.+)$/im);
  if (line && normalizeCandidateStatus(line[1].trim()) === undefined) return false;
  return true;
}
