import type { Analyzer, AnalyzeResult } from '../analyzer.js';
import type { BusinessRule, Entity, Relation } from '../types.js';
import { pascal, entityId } from './parse.js';

/**
 * Frontend business-logic analyzer: Pinia / Vuex stores, composables and the
 * API wrapper layer. These files carry most of the frontend business rules
 * (state transitions, status guards, validation) that template-only analysis
 * cannot see.
 *
 * Extraction is deliberately conservative and dependency-free: brace-matched
 * bodies are scanned with the same heuristic patterns as the other analyzers,
 * and everything produced is a low-confidence candidate.
 */

const DEFINE_STORE_RE = /defineStore\s*\(\s*["'`]([^"'`]+)["'`]/g;
const CREATE_STORE_RE = /(?:createStore|new\s+Vuex\.Store)\s*\(\s*\{/g;
const COMPOSABLE_FN_RE = /export\s+(?:async\s+)?function\s+(use[A-Z][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/g;
const COMPOSABLE_CONST_RE =
  /export\s+const\s+(use[A-Z][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;
const IMPORT_USE_RE = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
const IMPORT_USE_NAME_RE = /\b(use[A-Z][A-Za-z0-9_$]*)\b/g;
const REF_RE = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*ref(?:<([^>]*)>)?\s*\(/g;
const REACTIVE_FIELDS_RE = /reactive\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
const OPTION_STATE_FIELDS_RE = /state\s*:\s*(?:\(\)\s*=>)?\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
const VUEX_STATE_FIELDS_RE = /state\s*:\s*\{([\s\S]*?)\}/g;
const FIELD_RE = /([A-Za-z_$][\w$]*)\s*:\s*([^,;\n}]+)/g;
const PROMISE_TYPE_RE = /Promise\s*<\s*([A-Z][A-Za-z0-9_$]*)(?:\[\])?\s*>/g;
const STATUS_ASSIGN_RE = /(?:[\w$.]+\.)?(?:status|state)(?:\.value)?\s*=\s*["'`]([A-Z][A-Z0-9_-]*)["'`]/g;
const SET_STATUS_CALL_RE = /\b(?:set|update|change)(?:Status|State)\s*\(\s*["'`]([A-Z][A-Z0-9_-]*)["'`]/gi;
const STATUS_GUARD_RE = /\b(?:status|state)\b[\s\S]{0,60}?===?\s*["'`]([A-Z][A-Z0-9_-]*)["'`]/g;
const THROW_RE = /\bthrow\s+new\s+\w+\s*\(\s*["'`]([^"'`]+)["'`]/g;
const API_CALL_RE = /\b(?:axios|fetch|\$http|request)\b[^;]{0,80}/g;

function matchingBlock(text: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return text.slice(openIdx + 1);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function linesAround(text: string, index: number): string {
  const line = text.slice(0, index).split(/\r?\n/).length;
  const all = text.split(/\r?\n/);
  return all
    .slice(Math.max(0, line - 2), Math.min(all.length, line + 1))
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' | ');
}

function fileSlug(file: string): string {
  return (
    file
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
      .slice(-16) || 'file'
  );
}

function bodyAfter(text: string, index: number, opener: string): string | undefined {
  const open = text.indexOf(opener, index);
  if (open === -1) return undefined;
  return matchingBlock(text, open);
}

type EntityAttribute = NonNullable<Entity['attributes']>[number];

function uniqueAttributes(attrs: EntityAttribute[]): EntityAttribute[] {
  const seen = new Set<string>();
  return attrs.filter((a) => (seen.has(a.name) ? false : (seen.add(a.name), true)));
}

/** True when the file looks like a frontend API wrapper module. */
function isApiModule(file: string, text: string): boolean {
  const base = file.split(/[\\/]/).pop() ?? '';
  if (/(?:api|service|client|request|http)/i.test(base)) return true;
  return /Promise\s*</.test(text) && API_CALL_RE.test(text);
}

function detectPiniaStore(text: string): Array<{ id: string; body: string; index: number }> {
  const found: Array<{ id: string; body: string; index: number }> = [];
  for (const m of text.matchAll(DEFINE_STORE_RE)) {
    const open = text.indexOf('{', m.index + m[0].length);
    const body = open === -1 ? undefined : matchingBlock(text, open);
    if (body) found.push({ id: m[1], body, index: open });
  }
  return found;
}

function detectVuexStore(text: string): string | undefined {
  for (const m of text.matchAll(CREATE_STORE_RE)) {
    return bodyAfter(text, m.index + m[0].length - 1, '{');
  }
  return undefined;
}

function detectComposables(text: string): Array<{ name: string; body: string }> {
  const found: Array<{ name: string; body: string }> = [];
  const add = (name: string, open: number): void => {
    const body = matchingBlock(text, open);
    if (body) found.push({ name, body });
  };
  for (const m of text.matchAll(COMPOSABLE_FN_RE)) add(m[1], m.index + m[0].length - 1);
  for (const m of text.matchAll(COMPOSABLE_CONST_RE)) add(m[1], m.index + m[0].length - 1);
  return found;
}

function attributesFromBody(body: string): EntityAttribute[] {
  const attrs: EntityAttribute[] = [];
  for (const m of body.matchAll(REF_RE)) {
    attrs.push({ name: m[1], type: m[2]?.trim() });
  }
  const fieldSources = [...body.matchAll(OPTION_STATE_FIELDS_RE), ...body.matchAll(VUEX_STATE_FIELDS_RE)];
  for (const m of fieldSources) {
    for (const f of m[1].matchAll(FIELD_RE)) {
      const value = f[2].trim();
      const type = value.startsWith('"') || value.startsWith("'") || value.startsWith('`') ? 'string' : 'unknown';
      attrs.push({ name: f[1], type });
    }
  }
  for (const m of body.matchAll(REACTIVE_FIELDS_RE)) {
    for (const f of m[1].matchAll(FIELD_RE)) attrs.push({ name: f[1], type: 'unknown' });
  }
  return uniqueAttributes(attrs);
}

function bodyRules(
  body: string,
  fullText: string,
  file: string,
  entityName: string,
  kind: string,
  rules: BusinessRule[],
): void {
  let n = 0;
  const slug = fileSlug(file);
  const base = fullText.indexOf(body);
  const push = (
    rule: Omit<BusinessRule, 'id' | 'entity' | 'confidence' | 'evidence' | 'status'> & { name: string },
    prefix: string,
    index: number,
  ): void => {
    const at = base >= 0 ? base + index : index;
    rules.push({
      id: `rule.stores.${prefix}-${slug}-${n++}`,
      entity: entityName,
      confidence: 'low',
      evidence: [file],
      context: [`${file}:${lineOf(fullText, at)}: ${linesAround(fullText, at)}`],
      status: 'candidate',
      ...rule,
    });
  };
  for (const m of body.matchAll(STATUS_ASSIGN_RE)) {
    push({ name: 'Store state transition', rule: [`State transitions to: ${m[1]}.`] }, 'set', m.index ?? 0);
  }
  for (const m of body.matchAll(SET_STATUS_CALL_RE)) {
    push(
      { name: 'Store state transition (setter call)', rule: [`State transitions to: ${m[1]} via setter call.`] },
      'set',
      m.index ?? 0,
    );
  }
  for (const m of body.matchAll(STATUS_GUARD_RE)) {
    push(
      { name: 'State-dependent action guard', rule: [`Action only proceeds when state is: ${m[1]}.`] },
      'guard',
      m.index ?? 0,
    );
  }
  for (const m of body.matchAll(THROW_RE)) {
    push(
      { name: 'Explicit validation error thrown', rule: [m[1] || 'A validation error is thrown.'] },
      'throw',
      m.index ?? 0,
    );
  }
}

function usesEntityRelations(
  body: string,
  file: string,
  sourceName: string,
  knownNames: Set<string>,
  relations: Relation[],
): void {
  for (const name of knownNames) {
    if (name === sourceName || name.length < 2) continue;
    if (new RegExp(`\\b${name}\\b`, 'i').test(body)) {
      relations.push({
        id: `relation.${sourceName.toLowerCase()}-${name.toLowerCase()}-uses-entity`,
        source: sourceName,
        target: name,
        relationship: 'uses_entity',
        cardinality: 'unknown',
        description: `${sourceName} reads or writes business entity ${name}.`,
        confidence: 'medium',
        evidence: [file],
      });
    }
  }
}

function composableRelations(body: string, file: string, sourceName: string, relations: Relation[]): void {
  for (const m of body.matchAll(IMPORT_USE_RE)) {
    for (const name of m[1].matchAll(IMPORT_USE_NAME_RE)) {
      const target = pascal(name[1]);
      if (!target || target === sourceName) continue;
      relations.push({
        id: `relation.${sourceName.toLowerCase()}-${target.toLowerCase()}-uses-composable`,
        source: sourceName,
        target,
        relationship: 'uses_composable',
        cardinality: 'unknown',
        description: `${sourceName} uses composable ${target}.`,
        confidence: 'medium',
        evidence: [file],
      });
    }
  }
}

function apiRelations(
  text: string,
  file: string,
  sourceName: string,
  knownNames: Set<string>,
  relations: Relation[],
): void {
  for (const m of text.matchAll(PROMISE_TYPE_RE)) {
    const target = pascal(m[1].replace(/\[\]/g, ''));
    if (!target || target === sourceName) continue;
    if (!knownNames.has(target)) continue;
    relations.push({
      id: `relation.${sourceName.toLowerCase()}-${target.toLowerCase()}-calls-api`,
      source: sourceName,
      target,
      relationship: 'calls_api',
      cardinality: 'unknown',
      description: `${sourceName} returns ${m[1]} data for entity ${target}.`,
      confidence: 'medium',
      evidence: [file],
    });
  }
}

export const storesAnalyzer: Analyzer = {
  name: 'stores',
  analyze(scan, ctx): AnalyzeResult {
    const entities: Entity[] = [];
    const relations: Relation[] = [];
    const rules: BusinessRule[] = [];
    const knownNames = new Set(ctx.entities.map((e) => e.name));
    const seenEntities = new Set<string>();
    const addEntity = (entity: Entity): void => {
      if (seenEntities.has(entity.name)) return;
      seenEntities.add(entity.name);
      entities.push(entity);
      knownNames.add(entity.name);
    };

    for (const sample of scan.samples) {
      if (!/\.(ts|tsx|js|jsx|vue)$/i.test(sample.file)) continue;
      const baseName = pascal((sample.file.split(/[\\/]/).pop() ?? '').replace(/\.(ts|tsx|js|jsx|vue)$/i, ''));

      // Pinia stores (option or setup style).
      for (const store of detectPiniaStore(sample.text)) {
        const name = pascal(store.id) === baseName ? baseName : pascal(store.id);
        addEntity({
          id: entityId(name),
          name,
          type: 'business_entity',
          description: `Pinia store "${store.id}" discovered in ${sample.file}.`,
          confidence: 'medium',
          attributes: attributesFromBody(store.body),
          evidence: [sample.file],
        });
        bodyRules(store.body, sample.text, sample.file, name, 'store', rules);
        usesEntityRelations(store.body, sample.file, name, knownNames, relations);
        composableRelations(store.body, sample.file, name, relations);
      }

      // Vuex stores.
      const vuexBody = detectVuexStore(sample.text);
      if (vuexBody) {
        addEntity({
          id: entityId(baseName),
          name: baseName,
          type: 'business_entity',
          description: `Vuex store discovered in ${sample.file}.`,
          confidence: 'medium',
          attributes: attributesFromBody(vuexBody),
          evidence: [sample.file],
        });
        bodyRules(vuexBody, sample.text, sample.file, baseName, 'store', rules);
        usesEntityRelations(vuexBody, sample.file, baseName, knownNames, relations);
      }

      // Composable functions.
      for (const composable of detectComposables(sample.text)) {
        const name = pascal(composable.name);
        addEntity({
          id: entityId(name),
          name,
          type: 'business_entity',
          description: `Composable ${composable.name} discovered in ${sample.file}.`,
          confidence: 'medium',
          attributes: attributesFromBody(composable.body),
          evidence: [sample.file],
        });
        bodyRules(composable.body, sample.text, sample.file, name, 'composable', rules);
        usesEntityRelations(composable.body, sample.file, name, knownNames, relations);
        composableRelations(composable.body, sample.file, name, relations);
      }

      // API wrapper modules: response types link the module to its entity.
      if (isApiModule(sample.file, sample.text)) {
        addEntity({
          id: entityId(baseName),
          name: baseName,
          type: 'business_entity',
          description: `Frontend API wrapper module discovered in ${sample.file}.`,
          confidence: 'medium',
          evidence: [sample.file],
        });
        apiRelations(sample.text, sample.file, baseName, knownNames, relations);
      }
    }

    const result: AnalyzeResult = {};
    if (entities.length) result.entities = entities;
    if (rules.length) result.rules = rules;
    if (relations.length) result.relations = relations;
    return result;
  },
};
