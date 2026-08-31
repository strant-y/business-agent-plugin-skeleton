import path from 'node:path';
import { exists, readText } from '../utils/fs.js';
import type { DiscoverManifest } from './types.js';

/**
 * Runtime-safe loading of the discovery manifest.
 *
 * Consumers (impact/context/retrieval/states/task) previously did
 * `JSON.parse(...) as DiscoverManifest` and trusted the shape blindly: a
 * corrupted or partially-migrated manifest could crash a command or produce a
 * garbage report. These helpers keep the parse failure / malformed-field cases
 * as warnings instead of hard failures, dropping only the offending field.
 */

const ARRAY_FIELDS = [
  'entities',
  'rules',
  'relations',
  'apis',
  'conflicts',
  'states',
  'workflows',
  'pages',
  'actions',
  'tests',
  'modules',
] as const;

const OBJECT_FIELDS = ['aliases', 'aliasIndex', 'fieldIndex'] as const;

/**
 * Shape-check an unknown parsed manifest value. Returns a best-effort
 * Partial<DiscoverManifest> and reports each discarded field via onWarning.
 */
export function sanitizeManifest(raw: unknown, onWarning?: (message: string) => void): Partial<DiscoverManifest> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    onWarning?.(
      'discovery-manifest.json has an invalid top-level shape; treating it as empty. Re-run `business-agent discover`.',
    );
    return {};
  }
  const value = raw as Record<string, unknown>;
  const out: Partial<DiscoverManifest> = {};
  const discard = (field: string, expected: string): void => {
    onWarning?.(
      `discovery manifest field "${field}" is not a ${expected}; discarding it. Re-run \`business-agent discover\` if unexpected.`,
    );
  };

  if (typeof value.generatedAt === 'string') out.generatedAt = value.generatedAt;
  if (typeof value.projectRoot === 'string') out.projectRoot = value.projectRoot;
  if (typeof value.filesScanned === 'number') out.filesScanned = value.filesScanned;

  for (const field of ARRAY_FIELDS) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (!Array.isArray(candidate)) {
      discard(field, 'an array');
      continue;
    }
    (out as Record<string, unknown>)[field] = candidate;
  }
  for (const field of OBJECT_FIELDS) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      discard(field, 'an object');
      continue;
    }
    (out as Record<string, unknown>)[field] = candidate;
  }
  return out;
}

/**
 * Read and shape-check `.agent/memory/discovery-manifest.json`. Returns {}
 * when the file is missing or unreadable (with a warning) instead of throwing.
 */
export async function loadManifestSafe(
  root: string,
  onWarning?: (message: string) => void,
): Promise<Partial<DiscoverManifest>> {
  const file = path.join(root, '.agent', 'memory', 'discovery-manifest.json');
  if (!(await exists(file))) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(file));
  } catch {
    onWarning?.(`discovery-manifest.json is not valid JSON; treating it as empty. Re-run \`business-agent discover\`.`);
    return {};
  }
  return sanitizeManifest(raw, onWarning);
}
