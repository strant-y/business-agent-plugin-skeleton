import type { Analyzer } from '../analyzer.js';
import type { ApiRoute, Entity, FieldRef } from '../types.js';
import { pascal } from './parse.js';

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'express', re: /(?:router|app)\.(get|post|put|delete|patch|all)\s*\(\s*["'`]([^"'`]+)["'`]/gi },
  { name: 'nest', re: /@(Get|Post|Put|Delete|Patch|All)\(\s*["'`]([^"'`]+)["'`]/gi },
  { name: 'vue-router', re: /\bpath\s*:\s*["'`](\/[^"'`]+)["'`]/gi },
  {
    name: 'spring',
    re: /@(?:GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
  },
];

function methodFrom(verb: string, style: string): string {
  if (style === 'vue-router') return 'ANY';
  if (style === 'spring') return 'ANY';
  return verb.toUpperCase();
}

function kindFrom(style: string): 'backend' | 'frontend' {
  return style === 'vue-router' ? 'frontend' : 'backend';
}

function buildEntityFieldIndex(entities: Entity[]): Map<string, FieldRef[]> {
  const index = new Map<string, FieldRef[]>();
  for (const entity of entities) {
    const refs = (entity.attributes ?? []).map((attribute) => ({ entity: entity.name, field: attribute.name }));
    index.set(entity.name.toLowerCase(), refs);
  }
  return index;
}

function normalizeDtoEntity(typeName: string): string {
  return pascal(typeName.replace(/DTO$/i, '').replace(/\[\]$/g, ''));
}

function apiDtoFieldRefs(text: string, entities: Entity[]): FieldRef[] {
  const refs: FieldRef[] = [];
  const add = (entityName: string): void => {
    const entity = entities.find((item) => item.name.toLowerCase() === entityName.toLowerCase());
    if (!entity) return;
    for (const attribute of entity.attributes ?? []) {
      if (!refs.some((ref) => ref.entity === entity.name && ref.field === attribute.name)) {
        refs.push({ entity: entity.name, field: attribute.name, via: entityName });
      }
    }
  };
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9_$]*DTO)(?:\[\])?\b/g)) add(normalizeDtoEntity(match[1]));
  for (const match of text.matchAll(/Promise\s*<\s*([A-Z][A-Za-z0-9_$]*)(?:\[\])?\s*>/g))
    add(normalizeDtoEntity(match[1]));
  return refs;
}

function matchEntity(path: string, entities: Entity[]): string | undefined {
  const segments = path.split('/').filter(Boolean);
  for (const seg of segments) {
    const normalized = seg.replace(/[^a-zA-Z]/g, '');
    for (const entity of entities) {
      if (normalized.toLowerCase() === entity.name.toLowerCase()) return entity.name;
      if (normalized.toLowerCase() === entity.name.toLowerCase() + 's') return entity.name;
    }
  }
  return undefined;
}

export const apiAnalyzer: Analyzer = {
  name: 'api',
  analyze(scan, ctx) {
    const apis: ApiRoute[] = [];
    const entityFieldIndex = buildEntityFieldIndex(ctx.entities);
    for (const sample of scan.samples) {
      const dtoFields = apiDtoFieldRefs(sample.text, ctx.entities);
      for (const { name: style, re } of PATTERNS) {
        for (const m of sample.text.matchAll(re)) {
          const verb = m[1] ?? 'ANY';
          const path = m[2] ?? m[1] ?? '';
          const entity = matchEntity(path, ctx.entities);
          apis.push({
            id: `api.${methodFrom(verb, style).toLowerCase()}-${path
              .replace(/[^a-zA-Z0-9]/g, '-')
              .replace(/^-|-$/g, '')
              .toLowerCase()}`,
            method: methodFrom(verb, style),
            path,
            entity,
            fields: entity
              ? [
                  ...new Map(
                    [...(entityFieldIndex.get(entity.toLowerCase()) ?? []), ...dtoFields].map((field) => [
                      `${field.entity}.${field.field}`,
                      field,
                    ]),
                  ).values(),
                ]
              : dtoFields,
            kind: kindFrom(style),
            confidence: 'low',
            evidence: [sample.file],
          });
        }
      }
    }
    return apis.length ? { apis } : {};
  },
};
