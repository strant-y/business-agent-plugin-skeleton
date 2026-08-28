import { fileModuleName, moduleIdVariants } from './module-id.js';
import type { DiscoverManifest, Relation } from './types.js';

export interface Graph {
  nodes: Set<string>;
  out: Map<string, Map<string, string>>;
  in: Map<string, Map<string, string>>;
}

export interface GraphWalkStep {
  file: string;
  node: string;
  depth: number;
  relationship?: string;
  direction: 'out' | 'in';
}

export const DEFAULT_MAX_DEPTH = 6;
const MAX_CHAIN_STEPS = 300;
const TERMINAL_DEPTH = 3;

export interface TraceGraphOptions {
  terminalNodes?: Set<string>;
  lowAccuracyRelationships?: Set<string>;
}
const MERMAID_NODE_LIMIT = 40;

function resolveAliasTarget(node: string, aliases: Record<string, string[]> = {}): string {
  const normalizedNode = node.toLowerCase();
  for (const [canonical, values] of Object.entries(aliases)) {
    if (canonical.toLowerCase() === normalizedNode) return canonical;
    if (values.some((value) => value.toLowerCase() === normalizedNode)) return canonical;
  }
  return node;
}

function addEdge(
  graph: Graph,
  source: string,
  target: string,
  relationship: string,
  aliases: Record<string, string[]>,
): void {
  if (source === target) return;
  const normalizedSource = resolveAliasTarget(source, aliases);
  const normalizedTarget = resolveAliasTarget(target, aliases);
  graph.nodes.add(normalizedSource);
  graph.nodes.add(normalizedTarget);
  let outEdges = graph.out.get(normalizedSource);
  if (!outEdges) {
    outEdges = new Map();
    graph.out.set(normalizedSource, outEdges);
  }
  if (!outEdges.has(normalizedTarget)) outEdges.set(normalizedTarget, relationship);
  let inEdges = graph.in.get(normalizedTarget);
  if (!inEdges) {
    inEdges = new Map();
    graph.in.set(normalizedTarget, inEdges);
  }
  if (!inEdges.has(normalizedSource)) inEdges.set(normalizedSource, relationship);
}

export function buildGraph(manifest: Partial<DiscoverManifest>, relations: Relation[]): Graph {
  const graph: Graph = { nodes: new Set(), out: new Map(), in: new Map() };
  for (const entity of manifest.entities ?? []) graph.nodes.add(entity.name);
  const aliases = manifest.aliases ?? {};
  for (const relation of [...(manifest.relations ?? []), ...relations]) {
    addEdge(graph, relation.source, relation.target, relation.relationship, aliases);
  }
  return graph;
}

export function traceGraph(
  file: string,
  start: string,
  graph: Graph,
  maxDepth = DEFAULT_MAX_DEPTH,
  options: TraceGraphOptions = {},
): GraphWalkStep[] {
  const steps: GraphWalkStep[] = [];
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
    if (current.depth >= maxDepth) continue;
    if (current.depth >= TERMINAL_DEPTH && options.terminalNodes?.has(current.node)) continue;
    const neighbors = new Map<string, { relationship: string; direction: 'out' | 'in' }>();
    for (const [node, rel] of graph.out.get(current.node) ?? []) {
      neighbors.set(node, { relationship: rel, direction: 'out' });
    }
    for (const [node, rel] of graph.in.get(current.node) ?? []) {
      if (!neighbors.has(node)) neighbors.set(node, { relationship: rel, direction: 'in' });
    }
    const orderedNeighbors = [...neighbors].sort(([left], [right]) => {
      const leftLow = options.lowAccuracyRelationships?.has(neighbors.get(left)!.relationship) ? 1 : 0;
      const rightLow = options.lowAccuracyRelationships?.has(neighbors.get(right)!.relationship) ? 1 : 0;
      return leftLow - rightLow;
    });
    for (const [node, edge] of orderedNeighbors) {
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

function mermaidNodeId(node: string): string {
  return node.replace(/[^a-zA-Z0-9_]/g, '_');
}

function mermaidLabel(node: string, modules: DiscoverManifest['modules'] = []): string {
  const matched = modules?.find((module) => module.id === node);
  if (matched) return matched.name;
  if (node.startsWith('module:')) return fileModuleName(node.slice('module:'.length));
  return node;
}

function relationCardinalityLabel(source: string, target: string, relationships: Relation[]): string | undefined {
  const relation = relationships.find((item) => item.source === source && item.target === target);
  return relation?.cardinality;
}

export function renderMermaidSubgraph(options: {
  graph: Graph;
  manifest: Partial<DiscoverManifest>;
  relations: Relation[];
  starts: string[];
  maxDepth?: number;
  highlightNodes?: string[];
}): { mermaid: string; truncated: boolean } {
  const maxDepth = options.maxDepth ?? 2;
  const visited = new Set<string>();
  const queue = options.starts.map((node) => ({ node, depth: 0 }));
  const edges: Array<{ source: string; target: string; relationship: string; cardinality: string }> = [];
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current.node)) continue;
    visited.add(current.node);
    if (visited.size >= MERMAID_NODE_LIMIT) break;
    if (current.depth >= maxDepth) continue;
    for (const [target, relationship] of options.graph.out.get(current.node) ?? []) {
      const cardinality = relationCardinalityLabel(current.node, target, options.relations) ?? 'unknown';
      edges.push({ source: current.node, target, relationship, cardinality });
      if (!visited.has(target)) queue.push({ node: target, depth: current.depth + 1 });
    }
    for (const [source, relationship] of options.graph.in.get(current.node) ?? []) {
      const cardinality = relationCardinalityLabel(source, current.node, options.relations) ?? 'unknown';
      edges.push({ source, target: current.node, relationship, cardinality });
      if (!visited.has(source)) queue.push({ node: source, depth: current.depth + 1 });
    }
  }
  const nodes = [...visited].slice(0, MERMAID_NODE_LIMIT);
  const truncated = visited.size >= MERMAID_NODE_LIMIT || queue.length > 0;
  const lines = ['graph LR'];
  for (const node of nodes) {
    lines.push(`  ${mermaidNodeId(node)}["${mermaidLabel(node, options.manifest.modules)}"]`);
  }
  for (const edge of edges) {
    if (!visited.has(edge.source) || !visited.has(edge.target)) continue;
    lines.push(
      `  ${mermaidNodeId(edge.source)} -->|${edge.relationship}/${edge.cardinality}| ${mermaidNodeId(edge.target)}`,
    );
  }
  for (const node of options.highlightNodes ?? []) {
    if (!visited.has(node)) continue;
    lines.push(`  style ${mermaidNodeId(node)} fill:#f96`);
  }
  return { mermaid: lines.join('\n'), truncated };
}

export function resolveStartNodes(file: string, manifest: Partial<DiscoverManifest>): string[] {
  const modules = manifest.modules ?? [];
  if (modules.length) return moduleIdVariants(file, modules);
  return [fileModuleName(file)];
}
