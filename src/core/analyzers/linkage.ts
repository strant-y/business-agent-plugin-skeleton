import type { Analyzer, AnalyzerContext } from '../analyzer.js';
import type { ApiRoute, Relation } from '../types.js';
import { pascal } from './parse.js';

const CALL_RE = /(?:axios|fetch|\$http|request|api)\s*(?:\.\w+)?\s*\(\s*["'`](\/[^"'`]+)["'`]/gi;

function componentName(file: string): string {
  const base =
    file
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(vue|tsx|jsx|ts|js)$/i, '') ?? '';
  return pascal(base);
}

function pathMatches(callPath: string, routePath: string): boolean {
  const a = callPath.split('/').filter(Boolean);
  const b = routePath.split('/').filter(Boolean);
  // The call's static prefix may be shorter than the route (e.g. a template
  // expression `/api/orders/${id}` was cut to `/api/orders`), but never longer.
  if (a.length > b.length) return false;
  for (let i = 0; i < b.length; i++) {
    if (b[i].startsWith(':') || b[i] === '*' || b[i].startsWith('{')) continue;
    if (i >= a.length || a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Reduce a call path to the static part a backend route can match:
 * drop query strings/hashes, cut template expressions (`` `.../${id}` ``),
 * and strip trailing slashes.
 */
export function staticCallPath(raw: string): string {
  let path = raw;
  const queryIdx = path.search(/[?#]/);
  if (queryIdx !== -1) path = path.slice(0, queryIdx);
  const templateIdx = path.indexOf('${');
  if (templateIdx !== -1) path = path.slice(0, templateIdx);
  return path.replace(/\/+$/, '');
}

export function linkViewsToApis(
  scan: { samples: Array<{ file: string; text: string }> },
  apis: ApiRoute[],
): Relation[] {
  const relations: Relation[] = [];
  for (const sample of scan.samples) {
    if (!/\.(vue|tsx|jsx|ts|js)$/i.test(sample.file)) continue;
    const source = componentName(sample.file);
    for (const m of sample.text.matchAll(CALL_RE)) {
      const callPath = staticCallPath(m[1]);
      if (!callPath) continue;
      const matched = apis.find((api) => api.kind !== 'frontend' && pathMatches(callPath, api.path));
      if (!matched?.entity) continue;
      const already = `${source}|${matched.entity}|${matched.method} ${matched.path}`;
      if (relations.some((r) => r.description?.includes(already))) continue;
      relations.push({
        id: `relation.${source.toLowerCase()}-${matched.entity.toLowerCase()}-api`,
        source,
        target: matched.entity,
        relationship: 'calls_api',
        cardinality: 'unknown',
        description: `${source} calls ${matched.method} ${matched.path} which serves ${matched.entity}. (${already})`,
        confidence: 'medium',
        evidence: [sample.file, ...matched.evidence].slice(0, 8),
      });
    }
  }
  return relations;
}

export const linkageAnalyzer: Analyzer = {
  name: 'linkage',
  analyze(scan, ctx: AnalyzerContext) {
    const apis = ctx.apis ?? [];
    const relations = linkViewsToApis(scan, apis);
    return relations.length ? { relations } : {};
  },
};
