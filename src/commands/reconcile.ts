import path from 'node:path';
import { parseCandidate } from '../core/candidate.js';
import { isResolvedCandidateStatus, scanCandidateDir } from '../core/candidate-status.js';
import { candidateStateKey, loadReviewState, markReviewed, saveReviewState } from '../core/review.js';
import { readText } from '../utils/fs.js';
import type { Confidence } from '../core/types.js';

function toConfidence(value: string | undefined): Confidence {
  return value === 'high' || value === 'medium' ? value : 'low';
}

export interface ReconcileOptions {
  dryRun?: boolean;
  json?: boolean;
}

export interface ReconcileResult {
  scanned: number;
  /** Candidate files that were already resolved but had no review-state record. */
  added: number;
  backfilled: string[];
}

/**
 * Backfill review-state audit records for candidate files that are already
 * resolved on disk (promoted / covered / rejected) but missing a review-state
 * decision. Legacy flows and hand edits only rewrote the markdown status, so
 * audit reported a gap between the file layer and the review trail. The file
 * status is the source of truth; nothing is deleted or downgraded.
 */
export async function reconcileReviewState(root: string, options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const agentRoot = path.join(root, '.agent');
  const candidatesDir = path.join(agentRoot, 'memory', 'candidates');
  const index = await scanCandidateDir(candidatesDir);
  const state = await loadReviewState(agentRoot);
  const result: ReconcileResult = { scanned: index.total, added: 0, backfilled: [] };

  for (const entry of Object.values(index.byId)) {
    if (!isResolvedCandidateStatus(entry.status)) continue;
    const slug = entry.fileName.replace(/\.md$/i, '');
    // A decision keyed by the stable candidate id or the file slug already exists.
    if (state.decisions[candidateStateKey(entry.candidateId)] || state.decisions[candidateStateKey(slug)]) continue;
    if (!options.dryRun) {
      let name = slug;
      let entity = 'Unknown';
      try {
        const parsed = parseCandidate(await readText(entry.file), slug);
        name = parsed.name;
        entity = parsed.entity ?? entity;
      } catch {
        // Fall back to the slug and entity placeholder.
      }
      const promoted = entry.status === 'promoted' || entry.status === 'approved';
      markReviewed(
        state,
        { name, entity, confidence: toConfidence(entry.confidence) },
        {
          decision: promoted ? 'accepted' : 'rejected',
          slug,
          candidateId: entry.candidateId,
          status: entry.status,
          targetRuleId: entry.targetRuleId,
          reason: entry.reason ?? `auto-synced from candidate file status (${entry.status}) by reconcile`,
          reviewedBy: 'reconcile',
        },
      );
    }
    result.added += 1;
    result.backfilled.push(slug);
  }

  if (!options.dryRun && result.added > 0) await saveReviewState(agentRoot, state);
  return result;
}
