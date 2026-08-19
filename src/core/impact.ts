import path from 'node:path';
import { exists, readText, writeText } from '../utils/fs.js';
import { loadRules, loadRelations } from './knowledge.js';
import { fileModuleName } from './analyzers/linkage.js';
import type { BusinessRule, DiscoverManifest, FrontendPage, Relation, UserAction, WorkflowTemplate } from './types.js';

export interface DiffFinding {
  kind:
    | 'field_added'
    | 'field_removed'
    | 'field_type_changed'
    | 'state_added'
    | 'state_removed'
    | 'state_transition_changed'
    | 'rule_condition_changed'
    | 'api_path_changed'
    | 'api_method_changed'
    | 'request_param_changed'
    | 'response_type_changed'
    | 'database_field_changed'
    | 'permission_changed'
    | 'validation_changed'
    | 'test_changed';
  subject: string;
  detail: string;
  file: string;
  line?: number;
  evidence: string;
}

export interface DiffImpactMapping {
  finding: DiffFinding;
  pages: string[];
  actions: string[];
  rules: string[];
  tests: string[];
  workflows: string[];
  entities: string[];
  apis: string[];
}

interface PendingDiffLine {
  file: string;
  line: number;
  content: string;
  evidence: string;
  table?: string;
}

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
  workflows: NonNullable<DiscoverManifest['workflows']>;
  tests: string[];
  diffFindings: DiffFinding[];
  diffImpact: DiffImpactMapping[];
  risks: string[];
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
    for (const [node, rel] of graph.out.get(current.node) ?? []) {
      neighbors.set(node, { relationship: rel, direction: 'out' });
    }
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

export async function buildImpactReport(root: string, changedFiles: string[], diffText = ''): Promise<ImpactReport> {
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
  } else {
    warnings.push('Discovery manifest not found; run discover first.');
  }

  const normalized = changedFiles.map((file) => file.replaceAll('\\', '/').toLowerCase());
  const evidenceMatches = (evidence: string[] | undefined): boolean =>
    (evidence ?? []).some((item) => normalized.some((file) => file.endsWith(item.replaceAll('\\', '/').toLowerCase())));

  const rules = await loadRules(agentRoot);
  const relations = await loadRelations(agentRoot);
  const graph = buildGraph(manifest, relations);

  const affectedEntities = new Set<string>(
    (manifest.entities ?? []).filter((entity) => evidenceMatches(entity.evidence)).map((entity) => entity.name),
  );
  const entityTableAliases = buildEntityTableAliases((manifest.entities ?? []).map((entity) => entity.name));
  const chain: ImpactChainStep[] = [];
  const chainNodes = new Set<string>();
  for (const file of changedFiles) {
    const module = fileModuleName(file);
    if (graph.nodes.has(module) || affectedEntities.has(module)) {
      const steps = traceChain(file, module, graph);
      for (const step of steps) chainNodes.add(step.node);
      chain.push(...steps);
    }
  }

  const entityNames = new Set((manifest.entities ?? []).map((entity) => entity.name));
  for (const node of chainNodes) {
    if (entityNames.has(node)) affectedEntities.add(node);
  }

  const allRules = [...(manifest.rules ?? []), ...rules];
  const matchedRules = allRules.filter((rule) => evidenceMatches(rule.evidence) || affectedEntities.has(rule.entity));
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
  const apiKeys = apis.map((api) => `${api.method} ${api.path}`);
  const apiEntityIndex = buildApiEntityIndex(manifest.apis ?? []);
  const pages = (manifest.pages ?? []).filter(
    (page) =>
      evidenceMatches(page.evidence) ||
      chainNodes.has(page.component) ||
      page.stores.some((store) => chainNodes.has(store)),
  );
  const actions = (manifest.actions ?? []).filter(
    (action) => evidenceMatches(action.evidence) || pages.some((page) => page.actions.includes(action.id)),
  );
  const workflows = (manifest.workflows ?? []).filter((workflow) =>
    workflow.steps.some((step) =>
      [
        ...affectedEntities,
        ...chainNodes,
        ...actions.map((action) => action.name),
        ...pages.map((page) => page.component),
      ].some((token) => step.toLowerCase().includes(token.toLowerCase())),
    ),
  );
  const diffFindings = analyzeDiff(changedFiles, diffText);
  const tests = [
    ...new Set(reportTests(manifest, changedFiles, pages, actions, workflows, matchedRules, diffFindings)),
  ];
  const diffImpact = mapDiffImpact(
    diffFindings,
    [...affectedEntities],
    apiKeys,
    entityTableAliases,
    apiEntityIndex,
    pages,
    actions,
    matchedRules,
    workflows,
    tests,
  );
  const risks = deriveRisks(diffFindings, pages, actions, matchedRules, workflows, tests);
  return {
    files: changedFiles,
    entities: [...affectedEntities],
    rules: matchedRules,
    relations: matchedRelations,
    apis,
    pages,
    actions,
    workflows,
    tests,
    diffFindings,
    diffImpact,
    risks,
    chain,
    warnings,
  };
}

function analyzeDiff(changedFiles: string[], diffText: string): DiffFinding[] {
  if (!diffText.trim()) return [];
  const findings: DiffFinding[] = [];
  const removedLines: PendingDiffLine[] = [];
  let currentFile = changedFiles[0] ?? 'unknown';
  let currentLine = 0;
  let currentTable: string | undefined;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      currentLine = 0;
      currentTable = undefined;
      removedLines.length = 0;
      continue;
    }
    if (line.startsWith('--- a/') || line.startsWith('diff --git ') || line.startsWith('index ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      currentLine = Number(hunk[1]);
      currentTable = undefined;
      removedLines.length = 0;
      continue;
    }
    const contentLine = line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') ? line.slice(1) : line;
    const contextTable = detectSqlTableContext(contentLine.trim());
    if (contextTable) currentTable = contextTable;
    if (line.startsWith(' ') || line.startsWith('\\')) continue;
    const added = line.startsWith('+');
    const removed = line.startsWith('-');
    if (!added && !removed) continue;
    const content = contentLine.trim();
    const evidence = `${added ? '+' : '-'} ${content}`;
    const lineNumber = currentLine;
    if (removed) {
      removedLines.push({ file: currentFile, line: lineNumber, content, evidence, table: currentTable });
      detectSingleLineFinding(findings, currentFile, lineNumber, content, evidence, false, currentTable);
      continue;
    }
    currentLine += 1;
    const matched = consumePairFinding(
      findings,
      removedLines,
      currentFile,
      currentLine,
      content,
      evidence,
      currentTable,
    );
    if (!matched) detectSingleLineFinding(findings, currentFile, currentLine, content, evidence, true, currentTable);
  }
  return dedupeFindings(filterNoisyFindings(findings));
}

function consumePairFinding(
  findings: DiffFinding[],
  removedLines: PendingDiffLine[],
  file: string,
  line: number,
  addedContent: string,
  addedEvidence: string,
  currentTable?: string,
): boolean {
  for (let index = 0; index < removedLines.length; index += 1) {
    const removed = removedLines[index];
    const fieldChange = matchFieldTypeChange(removed.content, addedContent);
    if (fieldChange) {
      removedLines.splice(index, 1);
      findings.push({
        kind: 'field_type_changed',
        subject: fieldChange.field,
        detail: `Field ${fieldChange.field} type changed from ${fieldChange.from} to ${fieldChange.to}`,
        file,
        line,
        evidence: `${removed.evidence} => ${addedEvidence}`,
      });
      return true;
    }
    const stateTransitionChange = matchStateTransitionChange(removed.content, addedContent);
    if (stateTransitionChange) {
      removedLines.splice(index, 1);
      findings.push({
        kind: 'state_transition_changed',
        subject: stateTransitionChange.subject,
        detail: `State transition changed from ${stateTransitionChange.from} to ${stateTransitionChange.to}`,
        file,
        line,
        evidence: `${removed.evidence} => ${addedEvidence}`,
      });
      return true;
    }
    const apiMethodChange = matchApiMethodChange(removed.content, addedContent);
    if (apiMethodChange) {
      removedLines.splice(index, 1);
      findings.push({
        kind: 'api_method_changed',
        subject: apiMethodChange.subject,
        detail: `API method changed from ${apiMethodChange.from} to ${apiMethodChange.to}`,
        file,
        line,
        evidence: `${removed.evidence} => ${addedEvidence}`,
      });
      return true;
    }
    const apiPathChange = matchApiPathChange(removed.content, addedContent);
    if (apiPathChange) {
      removedLines.splice(index, 1);
      findings.push({
        kind: 'api_path_changed',
        subject: apiPathChange.subject,
        detail: `API path changed from ${apiPathChange.from} to ${apiPathChange.to}`,
        file,
        line,
        evidence: `${removed.evidence} => ${addedEvidence}`,
      });
      return true;
    }
    const requestParamChange = matchObjectPropertyChange(removed.content, addedContent, 'params');
    if (requestParamChange) {
      removedLines.splice(index, 1);
      findings.push({
        kind: 'request_param_changed',
        subject: requestParamChange.subject,
        detail: `Request parameter ${requestParamChange.subject} changed from ${requestParamChange.from} to ${requestParamChange.to}`,
        file,
        line,
        evidence: `${removed.evidence} => ${addedEvidence}`,
      });
      return true;
    }
    const responseTypeChange = matchPromiseReturnChange(removed.content, addedContent);
    if (responseTypeChange) {
      removedLines.splice(index, 1);
      findings.push({
        kind: 'response_type_changed',
        subject: responseTypeChange.subject,
        detail: `Response type changed from ${responseTypeChange.from} to ${responseTypeChange.to}`,
        file,
        line,
        evidence: `${removed.evidence} => ${addedEvidence}`,
      });
      return true;
    }
    const databaseFieldChange = matchDatabaseFieldChange(removed.content, addedContent, removed.table ?? currentTable);
    if (databaseFieldChange) {
      removedLines.splice(index, 1);
      findings.push({
        kind: 'database_field_changed',
        subject: databaseFieldChange.subject,
        detail: `Database field changed from ${databaseFieldChange.from} to ${databaseFieldChange.to}`,
        file,
        line,
        evidence: `${removed.evidence} => ${addedEvidence}`,
      });
      return true;
    }
    const permissionChange = matchFunctionArgumentChange(
      removed.content,
      addedContent,
      /(hasPermission|permission|can[A-Z]\w*)/,
    );
    if (permissionChange) {
      removedLines.splice(index, 1);
      findings.push({
        kind: 'permission_changed',
        subject: permissionChange.subject,
        detail: `Permission changed from ${permissionChange.from} to ${permissionChange.to}`,
        file,
        line,
        evidence: `${removed.evidence} => ${addedEvidence}`,
      });
      return true;
    }
    const validationChange = matchObjectPropertyChange(removed.content, addedContent, 'rules');
    if (validationChange) {
      removedLines.splice(index, 1);
      findings.push({
        kind: 'validation_changed',
        subject: validationChange.subject,
        detail: `Validation changed from ${validationChange.from} to ${validationChange.to}`,
        file,
        line,
        evidence: `${removed.evidence} => ${addedEvidence}`,
      });
      return true;
    }
  }
  return false;
}

function detectSingleLineFinding(
  findings: DiffFinding[],
  file: string,
  line: number,
  content: string,
  evidence: string,
  added: boolean,
  table?: string,
): void {
  if (/\b(?:required|minLength|maxLength|min|max|pattern|rules?|validate)\b/i.test(content)) {
    findings.push(makeFinding('validation_changed', file, line, 'Validation rule changed', evidence));
  }
  if (/\b(?:permission|permissions|hasPermission|can[A-Z])\b/.test(content)) {
    findings.push(makeFinding('permission_changed', file, line, 'Permission condition changed', evidence));
  }
  if (/\b(?:status|state)\b.*['"`][A-Z][A-Z0-9_-]*['"`]/.test(content)) {
    findings.push(
      makeFinding(added ? 'state_added' : 'state_removed', file, line, extractStateDetail(content), evidence),
    );
  }
  if (
    /\b(?:status|state)(?:\.value)?\s*=/.test(content) ||
    /\b(?:from|to)\b.*['"`][A-Z][A-Z0-9_-]*['"`]/.test(content)
  ) {
    findings.push(makeFinding('state_transition_changed', file, line, 'State transition logic changed', evidence));
  }
  if (/\b(?:GET|POST|PUT|PATCH|DELETE)\b/.test(content)) {
    findings.push(makeFinding('api_method_changed', file, line, 'API method changed', evidence));
  }
  if (/\/api\//i.test(content)) {
    findings.push(makeFinding('api_path_changed', file, line, 'API path changed', evidence));
  }
  if (/\b(?:params?|query|payload|body)\b/i.test(content) && /\{\s*params?\s*:/i.test(content)) {
    findings.push(makeFinding('request_param_changed', file, line, 'API request parameter changed', evidence));
  }
  if (/Promise<[^>]+>/.test(content)) {
    findings.push(makeFinding('response_type_changed', file, line, 'API response type changed', evidence));
  }
  if (isDatabaseFieldLine(content)) {
    findings.push(makeFinding('database_field_changed', file, line, 'Database field changed', evidence, table));
  }
  if (/\bif\s*\(|\bdisabled\b|\bv-if\b|\bv-show\b/.test(content)) {
    findings.push(makeFinding('rule_condition_changed', file, line, 'Rule condition changed', evidence));
  }
  if (isLikelyStandaloneField(content)) {
    findings.push(
      makeFinding(added ? 'field_added' : 'field_removed', file, line, extractFieldDetail(content), evidence),
    );
  }
  if (/\.(?:test|spec)\.[jt]sx?$/i.test(file)) {
    findings.push(makeFinding('test_changed', file, line, 'Related test changed', evidence));
  }
}

function isLikelyStandaloneField(content: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\??:\s*[^=,;]+[;,]?$/.test(content);
}

function filterNoisyFindings(findings: DiffFinding[]): DiffFinding[] {
  return findings.filter((finding) => {
    if (finding.kind === 'field_added' || finding.kind === 'field_removed') {
      return !/function\s+\w+\(|return\s+\w+\(/.test(finding.evidence);
    }
    if (finding.kind === 'api_method_changed' || finding.kind === 'api_path_changed') {
      return /request\(|fetch\(|axios\.|\$http|api\./i.test(finding.evidence);
    }
    if (finding.kind === 'response_type_changed') {
      return /Promise<[^>]+>/.test(finding.evidence);
    }
    return true;
  });
}

function matchFieldTypeChange(removed: string, added: string): { field: string; from: string; to: string } | undefined {
  const before = parseTypedField(removed);
  const after = parseTypedField(added);
  if (!before || !after || before.field !== after.field || before.type === after.type) return undefined;
  return { field: before.field, from: before.type, to: after.type };
}

function matchStateTransitionChange(
  removed: string,
  added: string,
): { subject: string; from: string; to: string } | undefined {
  const before = parseStateValue(removed);
  const after = parseStateValue(added);
  if (!before || !after) return undefined;
  const sameTarget = removed.replace(before, '__STATE__') === added.replace(after, '__STATE__');
  if (!sameTarget || before === after) return undefined;
  return { subject: after, from: before, to: after };
}

function matchApiMethodChange(
  removed: string,
  added: string,
): { subject: string; from: string; to: string } | undefined {
  const before = parseHttpMethod(removed);
  const after = parseHttpMethod(added);
  if (!before || !after || before === after) return undefined;
  return { subject: parseApiPath(added) ?? parseApiPath(removed) ?? fileModuleName('api'), from: before, to: after };
}

function matchApiPathChange(removed: string, added: string): { subject: string; from: string; to: string } | undefined {
  const before = parseApiPath(removed);
  const after = parseApiPath(added);
  if (!before || !after || before === after) return undefined;
  return { subject: after, from: before, to: after };
}

function matchObjectPropertyChange(
  removed: string,
  added: string,
  objectName: string,
): { subject: string; from: string; to: string } | undefined {
  const before = parseObjectLiteralValue(removed, objectName);
  const after = parseObjectLiteralValue(added, objectName);
  if (!before || !after) return undefined;
  if (before.key === after.key && before.value !== after.value) {
    return { subject: before.key, from: before.value, to: after.value };
  }
  if (before.key !== after.key) {
    return { subject: after.key, from: `${before.key}:${before.value}`, to: `${after.key}:${after.value}` };
  }
  return undefined;
}

function matchPromiseReturnChange(
  removed: string,
  added: string,
): { subject: string; from: string; to: string } | undefined {
  const before = parsePromiseType(removed);
  const after = parsePromiseType(added);
  if (!before || !after || before.type === after.type) return undefined;
  return { subject: after.subject, from: before.type, to: after.type };
}

function matchFunctionArgumentChange(
  removed: string,
  added: string,
  namePattern: RegExp,
): { subject: string; from: string; to: string } | undefined {
  const before = parseFunctionArgument(removed, namePattern);
  const after = parseFunctionArgument(added, namePattern);
  if (!before || !after || before.name !== after.name || before.arg === after.arg) return undefined;
  return { subject: before.name, from: before.arg, to: after.arg };
}

function matchDatabaseFieldChange(
  removed: string,
  added: string,
  table?: string,
): { subject: string; from: string; to: string } | undefined {
  const before = parseDatabaseField(removed, table);
  const after = parseDatabaseField(added, table);
  if (!before || !after || before.field !== after.field || before.definition === after.definition) return undefined;
  return {
    subject: before.table ? `${before.table}.${before.field}` : before.field,
    from: before.definition,
    to: after.definition,
  };
}

function parseTypedField(content: string): { field: string; type: string } | undefined {
  const functionParamMatch = content.match(/\b\w+\s*\([^)]*\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,)]+)[^)]*\)/);
  if (functionParamMatch) {
    return { field: functionParamMatch[1], type: functionParamMatch[2].trim() };
  }
  const objectFieldMatch = content.match(/^([A-Za-z_][A-Za-z0-9_]*)\??:\s*([^=,;]+)/);
  if (!objectFieldMatch) return undefined;
  return { field: objectFieldMatch[1], type: objectFieldMatch[2].trim() };
}

function parseStateValue(content: string): string | undefined {
  return content.match(/['"`]([A-Z][A-Z0-9_-]*)['"`]/)?.[1];
}

function parseHttpMethod(content: string): string | undefined {
  return content
    .match(/['"`](GET|POST|PUT|PATCH|DELETE)['"`]|\b(GET|POST|PUT|PATCH|DELETE)\b/)
    ?.slice(1)
    .find(Boolean);
}

function parseApiPath(content: string): string | undefined {
  return content.match(/(\/api\/[^'"`\s)]+)/i)?.[1];
}

function parseObjectLiteralValue(content: string, objectName: string): { key: string; value: string } | undefined {
  const objectPattern = new RegExp(`${objectName}\\s*[:=]\\s*\\{([^}]+)\\}`);
  const objectMatch = content.match(objectPattern);
  if (!objectMatch) return undefined;
  const pairMatch = objectMatch[1].match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,}]+)/);
  if (!pairMatch) return undefined;
  return { key: pairMatch[1], value: pairMatch[2].trim() };
}

function parsePromiseType(content: string): { subject: string; type: string } | undefined {
  const promiseMatch = content.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*:\s*Promise<([^>]+)>/);
  if (!promiseMatch) return undefined;
  return { subject: promiseMatch[1], type: promiseMatch[2].trim() };
}

function parseFunctionArgument(content: string, namePattern: RegExp): { name: string; arg: string } | undefined {
  const match = content.match(new RegExp(`(${namePattern.source})\\(([^)]+)\\)`));
  if (!match) return undefined;
  return { name: match[1], arg: match[2].trim() };
}

function parseDatabaseField(
  content: string,
  tableHint?: string,
): { field: string; definition: string; table?: string } | undefined {
  const normalized = content.replace(/^[+-]\s*/, '').trim();
  const alterTableMatch = normalized.match(/ALTER\s+TABLE\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?/i);
  const createTableMatch = normalized.match(/CREATE\s+TABLE\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?/i);
  const inlineCreateTableMatch = normalized.match(/^[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s*\($/i);
  const table = alterTableMatch?.[1] ?? createTableMatch?.[1] ?? inlineCreateTableMatch?.[1] ?? tableHint;
  const alterMatch = normalized.match(/(?:ADD|ALTER|MODIFY)\s+COLUMN\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s+(.+)/i);
  if (alterMatch) return { field: alterMatch[1], definition: alterMatch[2].trim(), table };
  const createMatch = normalized.match(
    /^[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s+([A-Z]+(?:\([^)]*\))?(?:\s+NOT\s+NULL|\s+NULL|\s+DEFAULT\s+[^,]+)*)[,]?$/i,
  );
  if (createMatch) return { field: createMatch[1], definition: createMatch[2].trim(), table };
  return undefined;
}

function detectSqlTableContext(content: string): string | undefined {
  return (
    content.match(/\b(?:CREATE\s+TABLE|ALTER\s+TABLE)\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?/i)?.[1] ??
    content.match(/^[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s*\($/i)?.[1]
  );
}

function isDatabaseFieldLine(content: string): boolean {
  return (
    /\b(?:ADD|ALTER|MODIFY)\s+COLUMN\b/i.test(content) ||
    /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Z]+(?:\([^)]*\))?)/i.test(content)
  );
}

function makeFinding(
  kind: DiffFinding['kind'],
  file: string,
  line: number,
  detail: string,
  evidence: string,
  table?: string,
): DiffFinding {
  return {
    kind,
    subject: inferFindingSubject(kind, file, evidence, table),
    detail,
    file,
    line,
    evidence,
  };
}

function inferFindingSubject(kind: DiffFinding['kind'], file: string, evidence: string, table?: string): string {
  if (kind === 'database_field_changed') {
    const databaseField = parseDatabaseField(evidence.replace(/^[+-]\s*/, '').split(' => ')[0] ?? '', table);
    if (databaseField)
      return databaseField.table ? `${databaseField.table}.${databaseField.field}` : databaseField.field;
  }
  const stateMatch = evidence.match(/['"`]([A-Z][A-Z0-9_-]*)['"`]/);
  if (stateMatch) return stateMatch[1];
  const fieldMatch = evidence.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/);
  if (fieldMatch) return fieldMatch[1];
  const apiMatch = evidence.match(/(\/api\/[^'"`\s)]+)/i);
  if (apiMatch) return apiMatch[1];
  return fileModuleName(file);
}

function extractStateDetail(content: string): string {
  const match = content.match(/['"`]([A-Z][A-Z0-9_-]*)['"`]/);
  return match ? `State ${match[1]} changed` : 'State declaration changed';
}

function extractFieldDetail(content: string): string {
  const match = content.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/);
  return match ? `Field ${match[1]} changed` : 'Field definition changed';
}

function dedupeFindings(findings: DiffFinding[]): DiffFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.kind}|${finding.file}|${finding.line}|${finding.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reportTests(
  manifest: Partial<DiscoverManifest>,
  changedFiles: string[],
  pages: NonNullable<DiscoverManifest['pages']>,
  actions: NonNullable<DiscoverManifest['actions']>,
  workflows: NonNullable<DiscoverManifest['workflows']>,
  rules: BusinessRule[],
  findings: DiffFinding[],
): string[] {
  const availableTests = new Set(
    (manifest.tests ?? [])
      .map((test) => test.replaceAll('\\', '/'))
      .filter((test) => /\.(test|spec)\.[jt]sx?$/.test(test)),
  );
  const keywords = [
    ...changedFiles.map((file) => fileModuleName(file)),
    ...pages.map((page) => page.component),
    ...actions.map((action) => action.name),
    ...workflows.map((workflow) => workflow.name),
    ...rules.map((rule) => rule.name),
    ...findings.map((finding) => finding.subject),
    ...findings.map((finding) => finding.kind),
  ]
    .map((value) => value.toLowerCase())
    .filter(Boolean);
  const matchedTests = [...availableTests].filter((test) => {
    const lower = test.toLowerCase();
    return keywords.some((keyword) => lower.includes(keyword.replace(/[^a-z0-9]+/g, '')) || lower.includes(keyword));
  });
  if (matchedTests.length > 0) return matchedTests.slice(0, 20);
  return keywords.slice(0, 8).map((keyword) => `Review tests related to: ${keyword}`);
}

function mapDiffImpact(
  findings: DiffFinding[],
  entities: string[],
  apis: string[],
  entityTableAliases: Map<string, string[]>,
  apiEntityIndex: Map<string, string[]>,
  pages: FrontendPage[],
  actions: UserAction[],
  rules: BusinessRule[],
  workflows: WorkflowTemplate[],
  tests: string[],
): DiffImpactMapping[] {
  return findings.map((finding) => {
    const databaseField =
      finding.kind === 'database_field_changed'
        ? parseDatabaseField(finding.evidence.split(' => ')[0] ?? '', finding.subject.split('.')[0])
        : undefined;
    const inferredEntities = inferDatabaseEntities(databaseField, entityTableAliases);
    const inferredApis = inferDatabaseApis(inferredEntities, apiEntityIndex);
    const relatedEntities = [
      ...new Set([...(entities ?? []).filter((entity) => matchesFinding(finding, [entity])), ...inferredEntities]),
    ];
    const relatedApis = [
      ...new Set([...(apis ?? []).filter((api) => matchesFinding(finding, [api])), ...inferredApis]),
    ];
    const relatedPages = pages.filter((page) =>
      matchesFinding(finding, [page.component, page.route, ...(page.permissions ?? []), ...(page.apiCalls ?? [])]),
    );
    const relatedActions = actions.filter((action) =>
      matchesFinding(finding, [
        action.name,
        action.source,
        ...(action.preconditions ?? []),
        ...(action.stateReads ?? []),
        ...(action.stateWrites ?? []),
        ...(action.apiCalls ?? []),
      ]),
    );
    const relatedRules = rules.filter((rule) =>
      matchesFinding(finding, [
        rule.name,
        rule.entity,
        ...(rule.rule ?? []),
        ...(rule.preconditions ?? []),
        ...(rule.impact ?? []),
      ]),
    );
    const relatedWorkflows = (workflows ?? []).filter((workflow) =>
      matchesFinding(finding, [workflow.name, workflow.description, ...(workflow.steps ?? [])]),
    );
    const relatedTests = (tests ?? []).filter((test) => matchesFinding(finding, [test]));
    return {
      finding,
      pages: relatedPages.map((page) => page.component),
      actions: relatedActions.map((action) => action.name),
      rules: relatedRules.map((rule) => rule.id),
      tests: relatedTests,
      workflows: relatedWorkflows.map((workflow) => workflow.name),
      entities: relatedEntities,
      apis: relatedApis,
    };
  });
}

function buildEntityTableAliases(entities: string[]): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const entity of entities) {
    const lower = entity.toLowerCase();
    const values = new Set<string>([lower, `${lower}s`]);
    if (lower.endsWith('y')) values.add(`${lower.slice(0, -1)}ies`);
    if (lower.endsWith('s')) values.add(lower.slice(0, -1));
    aliases.set(entity, [...values]);
  }
  return aliases;
}

function buildApiEntityIndex(apis: DiscoverManifest['apis']): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const api of apis ?? []) {
    if (!api.entity) continue;
    const key = api.entity.toLowerCase();
    const value = `${api.method} ${api.path}`;
    const current = index.get(key) ?? [];
    if (!current.includes(value)) current.push(value);
    index.set(key, current);
  }
  return index;
}

function inferDatabaseEntities(
  databaseField: { field: string; definition: string; table?: string } | undefined,
  entityTableAliases: Map<string, string[]>,
): string[] {
  if (!databaseField?.table) return [];
  const table = databaseField.table.toLowerCase();
  return [...entityTableAliases.entries()].filter(([, aliases]) => aliases.includes(table)).map(([entity]) => entity);
}

function inferDatabaseApis(entities: string[], apiEntityIndex: Map<string, string[]>): string[] {
  return [...new Set(entities.flatMap((entity) => apiEntityIndex.get(entity.toLowerCase()) ?? []))];
}

function matchesFinding(finding: DiffFinding, candidates: Array<string | undefined>): boolean {
  const normalizedSubject = finding.subject.toLowerCase();
  const tokens = [finding.subject, finding.detail, finding.evidence]
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9/_/-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const terms = tokens.join(' ');
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const normalized = candidate.toLowerCase();
    const compact = normalized.replace(/[^a-z0-9/_/-]+/g, ' ');
    if (
      normalizedSubject &&
      (normalized.includes(normalizedSubject) || compact.includes(normalizedSubject.replace(/[^a-z0-9/_/-]+/g, ' ')))
    ) {
      return true;
    }
    return (
      terms.includes(normalized) ||
      terms.includes(compact) ||
      compact.split(/\s+/).some((part) => part.length > 2 && terms.includes(part)) ||
      tokens.some((token) => token.length > 2 && (normalized.includes(token) || compact.includes(token)))
    );
  });
}

function deriveRisks(
  findings: DiffFinding[],
  pages: NonNullable<DiscoverManifest['pages']>,
  actions: NonNullable<DiscoverManifest['actions']>,
  rules: BusinessRule[],
  workflows: NonNullable<DiscoverManifest['workflows']>,
  tests: string[],
): string[] {
  const risks: string[] = [];
  if (findings.some((finding) => finding.kind.startsWith('state_'))) {
    risks.push('状态变化可能导致页面显示条件、按钮禁用逻辑和状态机不一致。');
  }
  if (
    findings.some(
      (finding) =>
        finding.kind.startsWith('api_') ||
        finding.kind === 'request_param_changed' ||
        finding.kind === 'response_type_changed',
    )
  ) {
    risks.push('API 变更可能需要同步修改 API wrapper、Store 状态和页面展示。');
  }
  if (findings.some((finding) => finding.kind === 'database_field_changed')) {
    risks.push('数据库字段变化可能影响实体映射、API 返回、表单字段和数据迁移脚本。');
  }
  if (findings.some((finding) => finding.kind === 'field_type_changed')) {
    risks.push('字段类型变化可能影响序列化、表单输入和接口返回解析。');
  }
  if (findings.some((finding) => finding.kind === 'permission_changed')) {
    risks.push('权限条件变化需要复核路由守卫、菜单按钮和角色测试。');
  }
  if (findings.some((finding) => finding.kind === 'validation_changed' || finding.kind === 'rule_condition_changed')) {
    risks.push('校验或条件分支变化可能破坏既有业务规则。');
  }
  if (pages.length && actions.length && workflows.length && !tests.some((test) => /test|spec/i.test(test))) {
    risks.push('已识别到页面、动作和流程，但没有命中现有测试文件，建议补充流程测试。');
  }
  if (rules.length && findings.length) {
    risks.push(`本次变更涉及 ${rules.length} 条相关规则，请确认与现有规则保持一致。`);
  }
  return [...new Set(risks)];
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
    '## Diff Findings',
    ...(report.diffFindings.length
      ? report.diffFindings.map(
          (finding) =>
            `- ${finding.file}${finding.line ? `:${finding.line}` : ''} [${finding.kind}] ${finding.subject}: ${finding.detail}`,
        )
      : ['- No diff-level findings identified.']),
    '',
    '## Diff To Impact Mapping',
    ...(report.diffImpact.length
      ? report.diffImpact.map(
          (mapping) =>
            `- ${mapping.finding.kind}/${mapping.finding.subject}: entities=${(mapping.entities ?? []).join(', ') || 'none'}; apis=${(mapping.apis ?? []).join(', ') || 'none'}; pages=${mapping.pages.join(', ') || 'none'}; actions=${mapping.actions.join(', ') || 'none'}; rules=${mapping.rules.join(', ') || 'none'}; workflows=${mapping.workflows.join(', ') || 'none'}; tests=${mapping.tests.join(', ') || 'none'}`,
        )
      : ['- No diff mapping identified.']),
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
    '## Affected Workflows',
    ...(report.workflows.length
      ? report.workflows.map((workflow) => `- ${workflow.name}: ${workflow.steps.join(' -> ') || 'no steps'}`)
      : ['- None identified']),
    '',
    '## Suggested Tests',
    ...(report.tests.length ? report.tests.map((test) => `- ${test}`) : ['- None identified']),
    '',
    '## Risks',
    ...(report.risks.length ? report.risks.map((risk) => `- ${risk}`) : ['- None identified']),
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
