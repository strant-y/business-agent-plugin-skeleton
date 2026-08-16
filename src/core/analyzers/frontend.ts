import type { Analyzer, AnalyzeResult } from '../analyzer.js';
import type { Entity, FrontendPage, Relation, UserAction, BusinessRule } from '../types.js';
import { fileModuleName } from './linkage.js';

function entityId(name: string): string {
  return `entity.${name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

const IMPORT_RE = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
const ROUTE_RE = /(?:path|route)\s*:\s*["']([^"']+)["']/gi;
const API_RE = /\b(?:axios|fetch|\$http|request|api)\s*(?:\.\w+)?\s*\(\s*["'`]([^"'`]+)["'`]/gi;
const STORE_RE = /\b(?:use[A-Z][A-Za-z0-9_$]*Store|use[A-Z][A-Za-z0-9_$]*|[A-Za-z0-9_$]*Store)\b/g;
const ACTION_RE =
  /(?:@(?:click|submit)|onClick|onSubmit|handle[A-Z][A-Za-z0-9_$]*)\s*(?:=|\()\s*["']?([A-Za-z_$][\w$]*)?/gi;
const PERMISSION_RE =
  /(?:permission|permissions|hasPermission|can[A-Z][A-Za-z0-9_$]*)\s*(?:===?|!==?|\(|\[)?\s*["']?([A-Za-z0-9_.:-]+)?/gi;
const CONDITION_RE = /(?:v-if|v-show|disabled|:disabled|v-bind:disabled)\s*=\s*["']([^"']+)["']/gi;
const FORM_RE = /(?:required|minLength|maxLength|min|max|pattern|validate|rules?)\s*[:=(]/gi;
const STATUS_WRITE_RE = /(?:status|state)(?:\.value)?\s*=\s*["'`]([A-Z][A-Z0-9_-]*)["'`]/g;
const STATUS_READ_RE = /(?:status|state)[\s\S]{0,60}?(?:===?|!==?)\s*["'`]([A-Z][A-Z0-9_-]*)["'`]/g;

function moduleName(file: string): string {
  return fileModuleName(file);
}

function relativeModule(importPath: string): string | undefined {
  const base = importPath
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(vue|tsx|jsx|ts|js)$/i, '');
  return base ? moduleName(base) : undefined;
}

function matches(text: string, expression: RegExp): string[] {
  return [...text.matchAll(expression)].map((match) => (match[1] ?? match[0]).trim()).filter(Boolean);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function isPage(file: string, text: string): boolean {
  return (
    /(?:^|[\\/])(pages?|views?|routes?)(?:[\\/]|$)/i.test(file) ||
    /<router-view|definePageMeta|useRoute\s*\(/.test(text)
  );
}

function isReact(file: string): boolean {
  return /\.(tsx|jsx)$/i.test(file);
}

function actionTrigger(text: string, name: string): UserAction['trigger'] {
  const actionPattern = new RegExp(`(?:@click|onClick)[^\\n]{0,80}${name}`, 'i');
  if (/@submit|onSubmit/i.test(text) && !actionPattern.test(text)) return 'submit';
  if (actionPattern.test(text) || (/@click|onClick/i.test(text) && /save|delete|create|update/i.test(name)))
    return 'click';
  if (/watch\s*\(/.test(text)) return 'watch';
  if (/useEffect\s*\(/.test(text)) return 'startup';
  return name.toLowerCase().includes('route') ? 'route' : 'event';
}

function analyzeSample(
  file: string,
  text: string,
): { entities: Entity[]; pages: FrontendPage[]; actions: UserAction[]; relations: Relation[]; rules: BusinessRule[] } {
  const source = moduleName(file);
  const importedModules = unique(
    [...text.matchAll(IMPORT_RE)]
      .map((match) => relativeModule(match[2]))
      .filter((value): value is string => Boolean(value)),
  );
  const stores = unique([...matches(text, STORE_RE).filter((name) => /store|^use[A-Z]/.test(name))]);
  const apiCalls = unique(matches(text, API_RE));
  const permissions = unique(matches(text, PERMISSION_RE));
  const conditions = unique(matches(text, CONDITION_RE));
  const stateReads = unique(matches(text, STATUS_READ_RE));
  const stateWrites = unique(matches(text, STATUS_WRITE_RE));
  const actionNames = unique([
    ...matches(text, ACTION_RE),
    ...[...text.matchAll(/(?:onClick|onSubmit|@click|@submit)\s*=\s*["']?\{?\s*([A-Za-z_$][\w$]*)/gi)].map(
      (match) => match[1],
    ),
    ...importedModules.filter((name) => /handle|submit|save|delete|create|update/i.test(name)),
  ]);
  const actions = actionNames.map((name, index): UserAction => ({
    id: `action.${source.toLowerCase()}-${name.toLowerCase()}-${index}`,
    name,
    source,
    trigger: actionTrigger(text, name),
    preconditions: [...conditions, ...permissions],
    stateReads,
    stateWrites,
    apiCalls,
    successEffects: stateWrites.map((state) => `State changes to ${state}.`),
    failureEffects: matches(text, /throw\s+new\s+\w+\s*\(\s*["']([^"']+)["']/g).map((error) => error),
    evidence: [file],
  }));
  const page =
    isPage(file, text) || (/\.(vue|tsx|jsx)$/i.test(file) && (apiCalls.length > 0 || actionNames.length > 0));
  const pages: FrontendPage[] = page
    ? [
        {
          id: `page.${source.toLowerCase()}`,
          route: matches(text, ROUTE_RE)[0],
          component: source,
          permissions,
          stores,
          apiCalls,
          actions: actions.map((action) => action.id),
          evidence: [file],
        },
      ]
    : [];
  const entities: Entity[] = [];
  if (page)
    entities.push({
      id: entityId(source),
      name: source,
      type: 'page',
      description: `Frontend page discovered in ${file}.`,
      confidence: 'medium',
      evidence: [file],
    });
  if (isReact(file))
    entities.push({
      id: entityId(source),
      name: source,
      type: page ? 'page' : 'component',
      description: `React component discovered in ${file}.`,
      confidence: 'medium',
      evidence: [file],
    });
  const relations: Relation[] = [];
  for (const store of stores)
    relations.push({
      id: `relation.${source.toLowerCase()}-${store.toLowerCase()}-frontend-store`,
      source,
      target: store,
      relationship: 'uses_store',
      cardinality: 'unknown',
      confidence: 'medium',
      description: `${source} uses frontend store ${store}.`,
      evidence: [file],
    });
  for (const api of apiCalls)
    relations.push({
      id: `relation.${source.toLowerCase()}-${api.toLowerCase().replace(/[^a-z0-9]+/gi, '-')}-frontend-api`,
      source,
      target: api,
      relationship: 'calls_api_route',
      cardinality: 'unknown',
      confidence: 'low',
      description: `${source} calls API path ${api}.`,
      evidence: [file],
    });
  const rules: BusinessRule[] = [];
  if (conditions.length || permissions.length || /required|minLength|maxLength|validate|rules?\s*[:=(]/i.test(text)) {
    const conditionRules = conditions.map((value) => `Interaction condition: ${value}.`);
    const permissionRules = permissions.map((value) => `Permission condition: ${value}.`);
    rules.push({
      id: `rule.frontend.${source.toLowerCase()}`,
      name: 'Frontend interaction and validation constraints',
      entity: source,
      rule: [
        ...conditionRules,
        ...permissionRules,
        ...(FORM_RE.test(text) ? ['Form validation constraints are enforced.'] : []),
        `Frontend evidence: ${text.match(/(?:AUDIT|AUDITING|APPROVED|DRAFT|REJECT)/i)?.[0] ?? 'interaction constraint'}.`,
      ],
      confidence: 'low',
      evidence: [file],
      context: [file],
      status: 'candidate',
    });
  }
  return { entities, pages, actions, relations, rules };
}

export const frontendAnalyzer: Analyzer = {
  name: 'frontend',
  analyze(scan): AnalyzeResult {
    const entities: Entity[] = [];
    const pages: FrontendPage[] = [];
    const actions: UserAction[] = [];
    const relations: Relation[] = [];
    const rules: BusinessRule[] = [];
    for (const sample of scan.samples) {
      if (!/\.(vue|tsx|jsx|ts|js)$/i.test(sample.file)) continue;
      const result = analyzeSample(sample.file, sample.text);
      entities.push(...result.entities);
      pages.push(...result.pages);
      actions.push(...result.actions);
      relations.push(...result.relations);
      rules.push(...result.rules);
    }
    return { entities, pages, actions, relations, rules };
  },
};
