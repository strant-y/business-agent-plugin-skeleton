import path from 'node:path';
import { exists, readText, writeText } from '../utils/fs.js';
import { loadRules, loadRelations } from './knowledge.js';
import { fileModuleName } from './analyzers/linkage.js';
import type { BusinessRule, DiscoverManifest, Relation } from './types.js';

/**
 * A step of the code-level call chain between a changed file and the
 * knowledge graph. depth 0 means the changed file's module is the node
 * itself; deeper steps were reached by traversing relations.
 */
export interface ImpactChainStep {
  file: string;
  node: string;
  depth: number;
  /** Relation kind used to reach this node (undefined for depth 0). */
  relationship?: string;
  /** out = the changed module uses this node; in = something uses the changed module. */
  direction: 'out' | 'in';
}

export interface ImpactReport {
  files: string[];
  entities: string[];
  rules: BusinessRule[];
  relations: Relation[];
  apis: DiscoverManifest['apis'];
  pages: NonNullable<DiscoverManifest['pages']>;
  actions: NonNullable<DiscoverManifest['actions']>;
  chain: ImpactChainStep[];
  warnings: string[];
}

const MAX_DEPTH = 3;
const MAX_CHAIN_STEPS = 300;

interface Graph {
  nodes: Set<string>;
  out: Map<string, Map<string, string>>;
  in: Map<string, Map<string, string>>;
}

function addEdge(graph: Graph, source: string, target: string, relationship: string): void {
  if (source === target) return;
  graph.nodes.add(source);
  graph.nodes.add(target);
  let outEdges = graph.out.get(source);
  if (!outEdges) {
    outEdges = new Map();
    graph.out.set(source, outEdges);
  }
  if (!outEdges.has(target)) outEdges.set(target, relationship);
  let inEdges = graph.in.get(target);
  if (!inEdges) {
    inEdges = new Map();
    graph.in.set(target, inEdges);
  }
  if (!inEdges.has(source)) inEdges.set(source, relationship);
}

function buildGraph(manifest: Partial<DiscoverManifest>, relations: Relation[]): Graph {
  const graph: Graph = { nodes: new Set(), out: new Map(), in: new Map() };
  for (const entity of manifest.entities ?? []) graph.nodes.add(entity.name);
  for (const relation of [...(manifest.relations ?? []), ...relations]) {
    addEdge(graph, relation.source, relation.target, relation.relationship);
  }
  return graph;
}

/** Walk the relation graph in both directions, recording reachable nodes. */
function traceChain(file: string, start: string, graph: Graph): ImpactChainStep[] {
  const steps: ImpactChainStep[] = [];
  const seen = new Set<string>([start]);
  const queue: Array<{ node: string; depth: number; relationship?: string; direction: 'out' | 'in' }> = [
    { node: start, depth: 0, direction: 'out' },
  ];
  while (queue.length && steps.length < MAX_CHAIN_STEPS) {
    const current = queue.shift()!;
    steps.push({
      file,
      node: current.node,
      depth: current.depth,
      relationship: current.relationship,
      direction: current.direction,
    });
    if (current.depth >= MAX_DEPTH) continue;
    const neighbors = new Map<string, { relationship: string; direction: 'out' | 'in' }>();
    for (const [node, rel] of graph.out.get(current.node) ?? [])
      neighbors.set(node, { relationship: rel, direction: 'out' });
    for (const [node, rel] of graph.in.get(current.node) ?? []) {
      if (!neighbors.has(node)) neighbors.set(node, { relationship: rel, direction: 'in' });
    }
    for (const [node, edge] of neighbors) {
      if (seen.has(node)) continue;
      seen.add(node);
      queue.push({
        node,
        depth: current.depth + 1,
        relationship: edge.relationship,
        direction: edge.direction,
      });
    }
  }
  return steps;
}

export async function buildImpactReport(root: string, changedFiles: string[]): Promise<ImpactReport> {
  const agentRoot = path.join(root, '.agent');
  const manifestFile = path.join(agentRoot, 'memory', 'discovery-manifest.json');
  const warnings: string[] = [];
  let manifest: Partial<DiscoverManifest> = {};
  if (await exists(manifestFile)) {
    try {
      manifest = JSON.parse(await readText(manifestFile)) as Partial<DiscoverManifest>;
    } catch {
      warnings.push(`Unreadable discovery manifest: ${manifestFile}`);
    }
  } else warnings.push('Discovery manifest not found; run discover first.');

  const normalized = changedFiles.map((file) => file.replaceAll('\\', '/').toLowerCase());
  const evidenceMatches = (evidence: string[] | undefined): boolean =>
    (evidence ?? []).some((item) => normalized.some((file) => file.endsWith(item.replaceAll('\\', '/').toLowerCase())));

  const rules = await loadRules(agentRoot);
  const relations = await loadRelations(agentRoot);
  const graph = buildGraph(manifest, relations);

  // Code-level call chain: map each changed file to its module node and
  // traverse relations in both directions. Falls back to evidence matching.
  const entityNames = new Set((manifest.entities ?? []).map((entity) => entity.name));
  const chain: ImpactChainStep[] = [];
  const chainNodes = new Set<string>();
  for (const file of changedFiles) {
    const module = fileModuleName(file);
    if (graph.nodes.has(module) || entityNames.has(module)) {
      const steps = traceChain(file, module, graph);
      for (const step of steps) chainNodes.add(step.node);
      chain.push(...steps);
    }
  }

  const affectedEntities = new Set<string>(
    (manifest.entities ?? []).filter((entity) => evidenceMatches(entity.evidence)).map((entity) => entity.name),
  );
  for (const node of chainNodes) {
    if (entityNames.has(node)) affectedEntities.add(node);
  }

  const matchedRules = rules.filter((rule) => evidenceMatches(rule.evidence) || affectedEntities.has(rule.entity));
  const matchedRelations = relations.filter(
    (relation) =>
      evidenceMatches(relation.evidence) ||
      affectedEntities.has(relation.source) ||
      affectedEntities.has(relation.target),
  );
  for (const rule of matchedRules) affectedEntities.add(rule.entity);
  for (const relation of matchedRelations) {
    affectedEntities.add(relation.source);
    affectedEntities.add(relation.target);
  }

  const apis = (manifest.apis ?? []).filter(
    (api) => evidenceMatches(api.evidence) || (api.entity && affectedEntities.has(api.entity)),
  );
  const pages = (manifest.pages ?? []).filter(
    (page) =>
      evidenceMatches(page.evidence) ||
      chainNodes.has(page.component) ||
      page.stores.some((store) => chainNodes.has(store)),
  );
  const actions = (manifest.actions ?? []).filter(
    (action) => evidenceMatches(action.evidence) || pages.some((page) => page.actions.includes(action.id)),
  );
  return {
    files: changedFiles,
    entities: [...affectedEntities],
    rules: matchedRules,
    relations: matchedRelations,
    apis,
    pages,
    actions,
    chain,
    warnings,
  };
}

export function impactMarkdown(report: ImpactReport): string {
  const lines = [
    '# Change Impact Report',
    '',
    `Changed files: ${report.files.length}`,
    '',
    '## Changed Files',
    ...(report.files.length ? report.files.map((file) => `- ${file}`) : ['- None']),
    '',
    '## Affected Chain',
    ...(report.chain.length
      ? report.chain.map(
          (step) =>
            `- ${step.file} ${step.depth === 0 ? '=' : step.direction === 'out' ? '→' : '←'} ${step.node}` +
            (step.depth > 0 ? ` (${step.relationship}, depth ${step.depth})` : ' (changed module)'),
        )
      : ['- No relation-graph chain; matches below rely on file-name evidence.']),
    '',
    '## Affected Entities',
    ...(report.entities.length ? report.entities.map((entity) => `- ${entity}`) : ['- None identified']),
    '',
    '## Affected Rules',
    ...(report.rules.length ? report.rules.map((rule) => `- ${rule.id}: ${rule.name}`) : ['- None identified']),
    '',
    '## Affected Relationships',
    ...(report.relations.length
      ? report.relations.map((relation) => `- ${relation.source} -> ${relation.target} (${relation.relationship})`)
      : ['- None identified']),
    '',
    '## Affected API Routes',
    ...(report.apis.length
      ? report.apis.map((api) => `- ${api.method} ${api.path}${api.entity ? ` (${api.entity})` : ''}`)
      : ['- None identified']),
    '',
    '## Affected Frontend Pages',
    ...(report.pages.length
      ? report.pages.map((page) => `- ${page.component}${page.route ? ` (${page.route})` : ''}`)
      : ['- None identified']),
    '',
    '## Affected User Actions',
    ...(report.actions.length
      ? report.actions.map((action) => `- ${action.name} [${action.trigger}] on ${action.source}`)
      : ['- None identified']),
    '',
    '## Warnings',
    ...(report.warnings.length ? report.warnings.map((warning) => `- ${warning}`) : ['- None']),
    '',
    '## Review Checklist',
    '- Confirm affected business rules before changing behavior.',
    '- Check related frontend, API, store and backend code.',
    '- Run tests for each affected business flow.',
    '',
  ];
  return lines.join('\n');
}

export async function writeImpactReport(root: string, report: ImpactReport): Promise<string> {
  const file = path.join(root, '.agent', 'memory', 'impact-report.md');
  await writeText(file, impactMarkdown(report));
  return file;
}
