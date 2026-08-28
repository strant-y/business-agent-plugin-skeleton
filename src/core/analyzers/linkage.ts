import path from 'node:path';
import type { Analyzer, AnalyzerContext } from '../analyzer.js';
import { exists, readText } from '../../utils/fs.js';
import { fileModuleName, moduleNodeId } from '../module-id.js';
import { normalizeRelationship, type ApiRoute, type Relation } from '../types.js';
import type { ModuleDescriptor } from '../types.js';
import { pascal } from './parse.js';

const CALL_RE = /(?:axios|fetch|\$http|request|api)\s*(?:\.\w+)?\s*\(\s*["'`](\/[^"'`]+)["'`]/gi;
const IMPORT_RE = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_RE = /import\s+["']([^"']+)["']/g;

function componentName(file: string): string {
  return fileModuleName(file);
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

function moduleName(file: string): string {
  const base =
    file
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(ts|tsx|js|jsx|vue)$/i, '') ?? '';
  return pascal(base);
}

function relativeModuleName(importPath: string): string | undefined {
  const base = importPath
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(ts|tsx|js|jsx|vue)$/i, '')
    .replace(/^_+/, '');
  return base ? pascal(base) : undefined;
}

function moduleIdByName(name: string, modules: ModuleDescriptor[] = []): string | undefined {
  return modules.find((item) => item.name === name)?.id;
}

async function loadExternalApis(paths: string[], warn?: (message: string) => void): Promise<ApiRoute[]> {
  const apis: ApiRoute[] = [];
  for (const manifestPath of paths) {
    try {
      const absolute = path.resolve(manifestPath);
      if (!(await exists(absolute))) {
        warn?.(`External API manifest not found: ${manifestPath}`);
        continue;
      }
      const manifest = JSON.parse(await readText(absolute)) as { apis?: ApiRoute[] };
      apis.push(...(manifest.apis ?? []).filter((api) => api.kind !== 'frontend'));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warn?.(`Failed to load external API manifest ${manifestPath}: ${detail}`);
    }
  }
  return apis;
}

export function linkFrontendModules(
  scan: { samples: Array<{ file: string; text: string }> },
  apis: ApiRoute[],
  entities: Array<{ name: string }>,
  modules: ModuleDescriptor[] = [],
): Relation[] {
  const relations: Relation[] = [];
  const entityNames = new Set(entities.map((entity) => entity.name));
  for (const sample of scan.samples) {
    if (!/\.(vue|tsx|jsx|ts|js)$/i.test(sample.file)) continue;
    const source = moduleName(sample.file);
    const sourceId = moduleNodeId(sample.file);
    const add = (
      target: string,
      relationship: string,
      description: string,
      evidence: string[] = [sample.file],
      subtype?: Relation['subtype'],
    ) => {
      const normalized = normalizeRelationship(relationship);
      if (
        !target ||
        target === source ||
        relations.some(
          (relation) =>
            relation.source === source && relation.target === target && relation.relationship === normalized,
        )
      )
        return;
      relations.push({
        id: `relation.${source.toLowerCase()}-${target.toLowerCase()}-${normalized}`,
        source: sourceId,
        target,
        relationship: normalized,
        subtype,
        cardinality: 'unknown',
        description: `${description} [module:${source}]`,
        confidence: 'medium',
        evidence,
      });
    };
    for (const match of sample.text.matchAll(IMPORT_RE)) {
      const imported = relativeModuleName(match[2]);
      if (!imported) continue;
      const importedId = moduleIdByName(imported, modules);
      if (/use[A-Z]|composable/i.test(imported))
        add(importedId ?? imported, 'uses_composable', `${source} uses composable ${imported}.`, [sample.file], 'composable_usage');
      if (/store|state/i.test(imported)) add(importedId ?? imported, 'uses_store', `${source} uses store ${imported}.`);
      if (/\.vue$/i.test(match[2])) add(importedId ?? imported, 'imports_component', `${source} imports component ${imported}.`);
    }
    for (const match of sample.text.matchAll(SIDE_EFFECT_IMPORT_RE)) {
      const imported = relativeModuleName(match[1]);
      const importedId = imported ? moduleIdByName(imported, modules) : undefined;
      if (imported && /use[A-Z]|composable/i.test(imported))
        add(importedId ?? imported, 'uses_composable', `${source} uses composable ${imported}.`, [sample.file], 'composable_usage');
    }
    for (const entity of entityNames) {
      if (new RegExp(`\\b${entity}\\b`, 'i').test(sample.text)) {
        add(entity, 'uses_entity', `${source} references frontend entity ${entity}.`);
      }
    }
  }
  return relations;
}

export function linkViewsToApis(
  scan: { samples: Array<{ file: string; text: string }> },
  apis: ApiRoute[],
): Relation[] {
  const relations: Relation[] = [];
  for (const sample of [...scan.samples].sort(
    (a, b) => Number(/\.vue$/i.test(b.file)) - Number(/\.vue$/i.test(a.file)),
  )) {
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
        source: moduleNodeId(sample.file),
        target: matched.entity,
        relationship: 'calls',
        subtype: 'api_route_call',
        provenance: 'frontend_linkage',
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
  async analyze(scan, ctx: AnalyzerContext) {
    const externalApis = await loadExternalApis(ctx.config.linkage?.externalApis ?? [], ctx.warn);
    const apis = [...(ctx.apis ?? []), ...externalApis];
    const relations = linkViewsToApis(scan, apis);
    return relations.length ? { relations } : {};
  },
};
