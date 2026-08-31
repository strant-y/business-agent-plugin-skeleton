import type { Analyzer, AnalyzeResult } from '../analyzer.js';
import type { Entity, FieldRef, FrontendPage, Relation, UserAction, BusinessRule, WorkflowTemplate } from '../types.js';
import { fileModuleName } from '../module-id.js';

function entityId(name: string): string {
  return `entity.${name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

const IMPORT_RE = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
const ROUTE_RE = /(?:path|route)\s*:\s*["']([^"']+)["']/gi;
const API_CALL_RE = /\b(?:axios|fetch|\$http|request|api)\s*(?:\.\w+)?\s*\(\s*["'`]([^"'`]+)["'`]/gi;
/** Request-wrapper style: `request({ url: '/customer/identify' })`. */
const URL_PROP_RE = /\burl\s*:\s*["'`]([^"'`]+)["'`]/gi;
/** Pure template URLs like `${baseApi}${path}` carry no endpoint information. */
const TEMPLATE_NOISE_RE = /^\$\{[^}]*\}$/;

function collectApiCalls(text: string): string[] {
  return unique([...matches(text, API_CALL_RE), ...matches(text, URL_PROP_RE)]).filter(
    (call) => !TEMPLATE_NOISE_RE.test(call),
  );
}
const STORE_RE = /\b(?:use[A-Z][A-Za-z0-9_$]*Store|use[A-Z][A-Za-z0-9_$]*|[A-Za-z0-9_$]*Store)\b/g;
const ACTION_RE =
  /(?:@(?:click|submit)|onClick|onSubmit|handle[A-Z][A-Za-z0-9_$]*)\s*(?:=|\()\s*["']?([A-Za-z_$][\w$]*)?/gi;
const PERMISSION_RE =
  /(?:permission|permissions|hasPermission|can[A-Z][A-Za-z0-9_$]*)\s*(?:===?|!==?|\(|\[)?\s*["']?([A-Za-z0-9_.:-]+)?/gi;
const CONDITION_RE = /(?:v-if|v-show|disabled|:disabled|v-bind:disabled)\s*=\s*["']([^"']+)["']/gi;
const FORM_RE = /(?:required|minLength|maxLength|min|max|pattern|validate|rules?)\s*[:=(]/gi;
const STATUS_WRITE_RE = /(?:status|state)(?:\.value)?\s*=\s*["'`]([A-Z][A-Z0-9_-]*)["'`]/g;
const STATUS_READ_RE = /(?:status|state)[\s\S]{0,60}?(?:===?|!==?)\s*["'`]([A-Z][A-Z0-9_-]*)["'`]/g;
const TEST_HINT_RE = /(?:spec|test)\.(?:ts|tsx|js|jsx)$/i;
const FIELD_ACCESS_RE = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\b/g;
const TYPED_REF_RE = /\b(?:ref|reactive)\s*<\s*([A-Z][A-Za-z0-9_$]*(?:DTO)?)(?:\[\])?\s*>/g;
const DEFINE_PROPS_RE = /defineProps\s*<\s*\{([\s\S]*?)\}\s*>\s*\(/g;
const INTERFACE_RE = /interface\s+([A-Z][A-Za-z0-9_$]*(?:DTO)?)\s*\{([\s\S]*?)\}/g;
const TYPE_FIELD_RE = /([A-Za-z_$][\w$]*)\s*:\s*[^;\n]+/g;

function moduleName(file: string): string {
  return fileModuleName(file);
}

/** Normalize a store name so `useQuoteStore` and module `QuoteStore` match. */
function storeKey(name: string): string {
  return name.replace(/^use/i, '').replace(/store$/i, '').toLowerCase();
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

function inferWorkflowName(source: string): string {
  return source.replace(/(Page|View|List|Edit|Detail)$/i, '') || source;
}

function normalizeDtoEntity(typeName: string): string {
  return typeName.replace(/DTO$/i, '').replace(/\[\]$/g, '');
}

function fieldRefsForEntityName(name: string, entities: Entity[]): FieldRef[] {
  const normalized = normalizeDtoEntity(name);
  const entity = entities.find((item) => item.name.toLowerCase() === normalized.toLowerCase());
  return entity
    ? (entity.attributes?.map((attribute) => ({ entity: entity.name, field: attribute.name, via: name })) ?? [])
    : [];
}

function inferWorkflowSteps(actions: UserAction[], states: string[], apiCalls: string[], fields: FieldRef[]): string[] {
  const steps = [
    ...actions.map((action) => `Action: ${action.name}`),
    ...states.map((state) => `State: ${state}`),
    ...apiCalls.map((api) => `API: ${api}`),
    ...fields.map((field) => `Field: ${field.entity}.${field.field}`),
  ];
  return unique(steps);
}

function actionBody(text: string, name: string): string {
  const functionMatch = text.match(
    new RegExp(`(?:function\\s+${name}\\s*\\([^)]*\\)|${name}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>)\\s*\\{`),
  );
  if (!functionMatch || functionMatch.index === undefined) return text;
  const open = text.indexOf('{', functionMatch.index + functionMatch[0].length - 1);
  if (open === -1) return text;
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === '{') depth++;
    if (text[index] === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

function actionUsesStore(text: string, action: UserAction, store: string): boolean {
  const body = actionBody(text, action.name);
  const storeBase = store.replace(/^use|Store$/g, '').toLowerCase();
  const aliases = [
    ...text.matchAll(new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${store}\\s*\\(`, 'g')),
  ].map((match) => match[1]);
  return (
    aliases.some((alias) => new RegExp(`\\b${alias}\\s*(?:\\.|\\()`).test(body)) ||
    new RegExp(`\\b${store}\\s*\\(`).test(body) ||
    (storeBase.length > 1 && new RegExp(`\\b${storeBase}\\w*\\s*(?:\\.|\\()`, 'i').test(body))
  );
}

function actionUsesApi(text: string, action: UserAction, api: string): boolean {
  const body = actionBody(text, action.name);
  const path = api.split(/[?#]/)[0].replace(/\/+$/, '');
  return body.includes(path) || new RegExp(`(?:axios|fetch|request|api)\\s*(?:\\.\\w+)?\\s*\\(`, 'i').test(body);
}

function detectFieldRefs(text: string, entities: Entity[]): FieldRef[] {
  const refs: FieldRef[] = [];
  const add = (items: FieldRef[]): void => {
    for (const item of items) {
      if (!refs.some((ref) => ref.entity === item.entity && ref.field === item.field)) refs.push(item);
    }
  };
  for (const match of text.matchAll(FIELD_ACCESS_RE)) {
    const field = match[2];
    const owner = entities.find((entity) => (entity.attributes ?? []).some((attribute) => attribute.name === field));
    if (!owner) continue;
    add([{ entity: owner.name, field, via: match[0] }]);
  }
  for (const match of text.matchAll(TYPED_REF_RE)) add(fieldRefsForEntityName(match[1], entities));
  for (const match of text.matchAll(INTERFACE_RE)) add(fieldRefsForEntityName(match[1], entities));
  for (const match of text.matchAll(DEFINE_PROPS_RE)) {
    const body = match[1];
    for (const field of body.matchAll(TYPE_FIELD_RE)) {
      const owner = entities.find((entity) =>
        (entity.attributes ?? []).some((attribute) => attribute.name === field[1]),
      );
      if (owner) add([{ entity: owner.name, field: field[1], via: `props.${field[1]}` }]);
    }
  }
  return refs;
}

function analyzeSample(
  file: string,
  text: string,
  entitiesIndex: Entity[],
  apiByStore?: Map<string, string[]>,
  urlsByModule?: Map<string, string[]>,
): {
  entities: Entity[];
  pages: FrontendPage[];
  actions: UserAction[];
  relations: Relation[];
  rules: BusinessRule[];
  workflows: WorkflowTemplate[];
} {
  const source = moduleName(file);
  const importedModules = unique(
    [...text.matchAll(IMPORT_RE)]
      .map((match) => relativeModule(match[2]))
      .filter((value): value is string => Boolean(value)),
  );
  const stores = unique([...matches(text, STORE_RE).filter((name) => /store|^use[A-Z]/.test(name))]);
  const directApiCalls = collectApiCalls(text);
  // Pinia stores own the API calls; a page that uses a store inherits its calls
  // so page.apiCalls reflects the real data flow instead of staying empty.
  const indirectApiCalls = unique(
    stores.flatMap((store) => apiByStore?.get(storeKey(store)) ?? []),
  );
  // Pages (and stores) importing api-wrapper modules inherit those modules' URLs.
  const viaImports = unique(
    importedModules.flatMap((mod) => urlsByModule?.get(mod.toLowerCase()) ?? []),
  );
  const apiCalls = unique([...directApiCalls, ...indirectApiCalls, ...viaImports]);
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
  const fields = detectFieldRefs(text, entitiesIndex);
  const actions = actionNames.map((name, index): UserAction => ({
    id: `action.${source.toLowerCase()}-${name.toLowerCase()}-${index}`,
    name,
    source,
    trigger: actionTrigger(text, name),
    preconditions: [...conditions, ...permissions],
    stateReads,
    stateWrites,
    apiCalls,
    stores,
    fields,
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
          fields,
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
  if (isReact(file) && !page)
    entities.push({
      id: entityId(source),
      name: source,
      type: 'component',
      description: `React component discovered in ${file}.`,
      confidence: 'medium',
      evidence: [file],
    });
  const relations: Relation[] = [];
  if (page) {
    for (const action of actions) {
      relations.push({
        id: `relation.${source.toLowerCase()}-${action.id.toLowerCase()}-page-action`,
        source,
        target: action.id,
        relationship: 'calls',
        subtype: 'page_action_trigger',
        cardinality: 'unknown',
        confidence: 'high',
        description: `${source} triggers user action ${action.name}.`,
        evidence: [file],
      });
    }
  }
  for (const store of stores) {
    relations.push({
      id: `relation.${source.toLowerCase()}-${store.toLowerCase()}-frontend-store`,
      source,
      target: store,
      relationship: 'references',
      cardinality: 'unknown',
      confidence: 'medium',
      description: `${source} uses frontend store ${store}.`,
      evidence: [file],
    });
  }
  for (const api of apiCalls) {
    relations.push({
      id: `relation.${source.toLowerCase()}-${api.toLowerCase().replace(/[^a-z0-9]+/gi, '-')}-frontend-api`,
      source,
      target: api,
      relationship: 'calls',
      cardinality: 'unknown',
      confidence: 'low',
      description: `${source} calls API path ${api}.`,
      evidence: [file],
    });
  }
  for (const action of actions) {
    for (const store of stores) {
      if (!actionUsesStore(text, action, store)) continue;
      relations.push({
        id: `relation.${action.id}-${store.toLowerCase()}-action-store`,
        source: action.name,
        target: store,
        relationship: 'calls',
        subtype: 'action_store_update',
        provenance: 'frontend_action',
        cardinality: 'unknown',
        confidence: 'high',
        description: `${action.name} invokes ${store}.`,
        evidence: [file],
      });
    }
    for (const api of apiCalls) {
      if (!actionUsesApi(text, action, api)) continue;
      relations.push({
        id: `relation.${action.id}-${api.toLowerCase().replace(/[^a-z0-9]+/gi, '-')}-action-api`,
        source: action.name,
        target: api,
        relationship: 'calls',
        subtype: 'action_api_call',
        provenance: 'frontend_action',
        cardinality: 'unknown',
        confidence: 'high',
        description: `${action.name} calls API path ${api}.`,
        evidence: [file],
      });
    }
  }
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
      impact: [
        ...(permissions.length ? ['Review page permission checks and route guards.'] : []),
        ...(FORM_RE.test(text) ? ['Review form validators and submit actions.'] : []),
      ],
      confidence: 'low',
      evidence: [file],
      context: [file],
      status: 'candidate',
    });
  }
  const workflows: WorkflowTemplate[] =
    page && !TEST_HINT_RE.test(file) && (actions.length > 0 || stateWrites.length > 0 || apiCalls.length > 0)
      ? [
          {
            id: `workflow.${source.toLowerCase()}`,
            name: `${inferWorkflowName(source)} frontend flow`,
            description: `${source} links actions, stores, APIs and states into a frontend workflow.`,
            steps: inferWorkflowSteps(actions, [...stateReads, ...stateWrites], apiCalls, fields),
            status: 'draft',
          },
        ]
      : [];
  return { entities, pages, actions, relations, rules, workflows };
}

export const frontendAnalyzer: Analyzer = {
  name: 'frontend',
  analyze(scan, ctx): AnalyzeResult {
    const entities: Entity[] = [];
    const pages: FrontendPage[] = [];
    const actions: UserAction[] = [];
    const relations: Relation[] = [];
    const rules: BusinessRule[] = [];
    const workflows: WorkflowTemplate[] = [];
    // Pinia data flow: stores own the API calls. Pre-scan store/composable
    // modules once so pages can inherit their calls (page.apiCalls). Also index
    // every module's calls by module name so imported api-wrapper modules
    // (e.g. `import { postOrder } from '../api/orderApi'`) contribute too.
    const apiByStore = new Map<string, string[]>();
    const urlsByModule = new Map<string, string[]>();
    for (const sample of scan.samples) {
      if (!/\.(ts|js)$/i.test(sample.file)) continue;
      const apis = collectApiCalls(sample.text);
      if (!apis.length) continue;
      const moduleKey = moduleName(sample.file).toLowerCase();
      urlsByModule.set(moduleKey, apis);
      if (/store/i.test(sample.file)) apiByStore.set(storeKey(moduleName(sample.file)), apis);
    }
    for (const sample of scan.samples) {
      if (!/\.(vue|tsx|jsx|ts|js)$/i.test(sample.file)) continue;
      const result = analyzeSample(sample.file, sample.text, ctx.entities, apiByStore, urlsByModule);
      entities.push(...result.entities);
      pages.push(...result.pages);
      actions.push(...result.actions);
      relations.push(...result.relations);
      rules.push(...result.rules);
      workflows.push(...result.workflows);
    }
    return { entities, pages, actions, relations, rules, workflows };
  },
};
