import type { Analyzer, AnalyzeResult } from '../analyzer.js';
import type { ApiRoute, BusinessRule, Entity, Relation } from '../types.js';
import { pascal, entityId } from './parse.js';

const CLASS_RE = /(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|static\s+)*class\s+([A-Za-z_$][\w$]*)/g;
type EntityAttribute = NonNullable<Entity['attributes']>[number];
const COLUMN_FIELD_RE =
  /@Column\s*\(([^)]*)\)[\s\S]*?\b([A-Za-z_$][\w$]*(?:<[^>]+>)?(?:\[\])*)\s+([a-zA-Z_$][\w$]*)\s*;/g;
const RELATION_FIELD_RE =
  /@(ManyToOne|OneToMany|OneToOne|ManyToMany)(?:\([^)]*\))?[\s\S]*?\b([A-Za-z_$][\w$]*(?:<[^>]+>)?(?:\[\])*)\s+([a-zA-Z_$][\w$]*)\s*;/g;
const PLAIN_FIELD_RE =
  /(?:private|protected|public|static|final|transient|volatile|@\w+\([^)]*\))\s+(?:<[^>]+>\s+)?([A-Za-z_$][\w$]*(?:<[^>]+>)?(?:\[\])*)\s+([a-zA-Z_$][\w$]*)\s*(?:=|;)/g;
const TABLE_RE = /@Table\s*(?:\(\s*name\s*=\s*"([^"]+)"\s*\)|\(\s*"([^"]+)"\s*\))/i;
const METHOD_MAPPING_RE =
  /@(?:GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*(?:\(\s*"([^"]+)"\s*\))?/g;
const CLASS_MAPPING_RE = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']?([^"')]+)["']?/i;
const THROW_RE =
  /throw\s+new\s+(?:RuntimeException|IllegalArgumentException|IllegalStateException|BusinessException|ValidationException|\w*(?:Business|Service|Biz)\w*Exception)\s*\(\s*["']([^"']+)["']\s*\)/g;
const STATUS_THROW_RE = /if\s*\(([^)]*status[^)]*)\)\s*\{?\s*throw\s+new\s+\w+\s*\(\s*["']([^"']+)["']\s*\)/gi;
const IF_COND_RE = /if\s*\(((?:[^()]|\([^)]*\))*)\)/g;
const STATUS_STATES = /(AUDIT|AUDITING|APPROVED|DRAFT|REJECT|SUBMIT|PENDING)/i;
const VALIDATION_FIELD_RE =
  /@((?:NotNull|NotBlank|NotEmpty|Size|Min|Max|Valid))(?:\(([^)]*)\))?[\s\S]{0,200}?\b([A-Za-z_$][\w$]*(?:<[^>]+>)?(?:\[\])*)\s+([a-zA-Z_$][\w$]*)\s*;/g;
const PREAUTHORIZE_RE = /@(PreAuthorize|PreFilter)\s*\(\s*"([^"]+)"\s*\)/g;

function hasStatusCondition(body: string): boolean {
  for (const m of body.matchAll(IF_COND_RE)) {
    const cond = m[1];
    if (/status/i.test(cond) && STATUS_STATES.test(cond)) return true;
  }
  return false;
}

const CARDINALITY: Record<string, Relation['cardinality']> = {
  ManyToOne: 'N:1',
  OneToMany: '1:N',
  OneToOne: '1:1',
  ManyToMany: 'N:M',
};

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

function removeBlocks(body: string): string {
  let result = '';
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf('{', i);
    if (open === -1) {
      result += body.slice(i);
      break;
    }
    const before = body.slice(Math.max(0, open - 160), open);
    if (/\)\s*$/.test(before) || /^\s*(if|for|while|switch|try|catch|else|synchronized)\b/.test(before.trim())) {
      result += body.slice(i, open);
      i = open;
      let depth = 0;
      for (; i < body.length; i++) {
        if (body[i] === '{') depth++;
        else if (body[i] === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
    } else {
      result += body.slice(i, open + 1);
      i = open + 1;
    }
  }
  return result;
}

function classBody(text: string, matchStart: number): string {
  const open = text.indexOf('{', matchStart);
  if (open === -1) return '';
  return matchingBlock(text, open);
}

function classEntityName(className: string, body: string, entities: Entity[]): string {
  const referenced = entities.find((entity) => new RegExp(`\\b${entity.name}\\b`).test(body));
  if (referenced) return referenced.name;
  const reduced = ruleEntityName(className);
  return entities.find((entity) => entity.name.toLowerCase() === reduced.toLowerCase())?.name ?? reduced;
}

function beforeAnnotation(text: string, index: number, annotation: string): boolean {
  const before = text.slice(Math.max(0, index - 600), index);
  return new RegExp(`@${annotation}\\b`).test(before);
}

function targetFromType(type: string): string {
  const generic = /<([^<>]+)>/.exec(type);
  if (generic) return pascal(generic[1].trim());
  return pascal(type.replace(/\[\]/g, ''));
}

function ruleEntityName(className: string): string {
  const reduced = className.replace(/ServiceImpl$/, '').replace(/(Service|Controller|Manager)$/, '');
  return reduced || className;
}

function verbFromMapping(annotation: string): string {
  const verb = annotation.replace('Mapping', '').toUpperCase();
  return verb === 'REQUEST' ? 'ANY' : verb;
}

function routeId(method: string, path: string): string {
  return `api.java.${method.toLowerCase()}-${path
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()}`;
}

function matchRouteEntity(path: string, entities: Entity[]): string | undefined {
  const segments = path.split('/').filter((s) => !s.startsWith('{') && !s.startsWith(':'));
  for (const seg of segments) {
    const normalized = seg.replace(/[^a-zA-Z]/g, '');
    for (const entity of entities) {
      if (normalized.toLowerCase() === entity.name.toLowerCase()) return entity.name;
      if (normalized.toLowerCase() === entity.name.toLowerCase() + 's') return entity.name;
    }
  }
  return undefined;
}

function validationRuleText(annotation: string, args: string | undefined, entity: string, field: string): string {
  const target = `${entity}.${field}`;
  if (annotation === 'Valid') return `Field constraint on ${target}: nested value must be valid.`;
  const normalizedArgs = args?.replace(/\s+/g, ' ').trim();
  if (!normalizedArgs) return `Field constraint on ${target}: @${annotation}.`;
  return `Field constraint on ${target}: @${annotation}(${normalizedArgs}).`;
}

export const javaAnalyzer: Analyzer = {
  name: 'java',
  analyze(scan, ctx) {
    const entities: Entity[] = [];
    const relations: Relation[] = [];
    const rules: BusinessRule[] = [];
    const apis: ApiRoute[] = [];

    for (const sample of scan.samples) {
      if (!/\.java$/i.test(sample.file)) continue;

      for (const cm of sample.text.matchAll(CLASS_RE)) {
        const className = cm[1];
        const body = classBody(sample.text, cm.index);
        const isEntity =
          beforeAnnotation(sample.text, cm.index, 'Entity') ||
          beforeAnnotation(sample.text, cm.index, 'Table') ||
          beforeAnnotation(sample.text, cm.index, 'MappedSuperclass');
        const isEndpoint =
          beforeAnnotation(sample.text, cm.index, 'RestController') ||
          beforeAnnotation(sample.text, cm.index, 'Controller');
        const isService =
          beforeAnnotation(sample.text, cm.index, 'Service') || beforeAnnotation(sample.text, cm.index, 'Component');

        const before = sample.text.slice(Math.max(0, cm.index - 600), cm.index);
        const tableMatch = TABLE_RE.exec(before);
        const tableName = tableMatch?.[1] ?? tableMatch?.[2] ?? className.toLowerCase();

        if (isEntity) {
          entities.push({
            id: entityId(className),
            name: className,
            type: 'business_entity',
            description: `JPA entity discovered from class ${className} mapped to table ${tableName}.`,
            confidence: 'medium',
            attributes: [],
            evidence: [sample.file],
          });
        }

        const cleaned = removeBlocks(body);
        const attrs = new Map<string, EntityAttribute>();

        for (const fm of cleaned.matchAll(PLAIN_FIELD_RE)) {
          const attr = { name: fm[2], type: fm[1].replace(/\[\]/g, '') };
          if (!attrs.has(attr.name)) attrs.set(attr.name, attr);
        }
        for (const fm of body.matchAll(COLUMN_FIELD_RE)) {
          const columnAttrs = fm[1];
          const attr: EntityAttribute = {
            name: fm[3],
            type: fm[2].replace(/\[\]/g, ''),
            required: /\bnullable\s*=\s*false/.test(columnAttrs),
            description: /name\s*=\s*"([^"]+)"/.test(columnAttrs)
              ? `Column ${/name\s*=\s*"([^"]+)"/.exec(columnAttrs)![1]}`
              : undefined,
          };
          attrs.set(attr.name, attr);
        }

        const entity = entities.find((e) => e.name === className);
        if (entity) entity.attributes = [...attrs.values()];

        for (const rm of body.matchAll(RELATION_FIELD_RE)) {
          const relKind = rm[1];
          const target = targetFromType(rm[2]);
          if (target === className) continue;
          relations.push({
            id: `relation.${className.toLowerCase()}-${target.toLowerCase()}-jpa`,
            source: className,
            target,
            relationship: 'references',
            cardinality: CARDINALITY[relKind] ?? 'unknown',
            description: `JPA ${relKind} on ${className}.${rm[3]} → ${target}.`,
            confidence: 'medium',
            evidence: [sample.file],
          });
        }

        if (isEntity) {
          let validationIndex = 0;
          for (const vm of body.matchAll(VALIDATION_FIELD_RE)) {
            const annotation = vm[1];
            const args = vm[2];
            const field = vm[4];
            rules.push({
              id: `rule.java.validation-${sample.file
                .replace(/[^a-z0-9]/gi, '')
                .toLowerCase()
                .slice(-12)}-${validationIndex++}`,
              name: `Field constraint via @${annotation}`,
              entity: className,
              rule: [validationRuleText(annotation, args, className, field)],
              confidence: 'low',
              evidence: [sample.file],
              status: 'candidate',
            });
          }
        }

        if (isEndpoint || isService) {
          const ruleEntity = isEntity ? className : classEntityName(className, body, ctx.entities);
          let n = 0;
          for (const tm of body.matchAll(THROW_RE)) {
            if (!tm[1]?.trim()) continue;
            rules.push({
              id: `rule.java.throw-${sample.file
                .replace(/[^a-z0-9]/gi, '')
                .toLowerCase()
                .slice(-12)}-${n++}`,
              name: 'Explicit validation error thrown',
              entity: ruleEntity,
              rule: [tm[1] || 'A validation error is thrown.'],
              confidence: 'low',
              evidence: [sample.file],
              status: 'candidate',
            });
          }
          for (const sm of body.matchAll(STATUS_THROW_RE)) {
            rules.push({
              id: `rule.java.status-throw-${sample.file
                .replace(/[^a-z0-9]/gi, '')
                .toLowerCase()
                .slice(-12)}-${n++}`,
              name: 'State-dependent validation error',
              entity: ruleEntity,
              preconditions: [sm[1].trim()],
              rule: [`When ${sm[1].trim()}, reject the operation: ${sm[2].trim()}.`],
              confidence: 'medium',
              evidence: [sample.file],
              status: 'candidate',
            });
          }
          if (hasStatusCondition(body)) {
            rules.push({
              id: `rule.java.status-${sample.file
                .replace(/[^a-z0-9]/gi, '')
                .toLowerCase()
                .slice(-12)}`,
              name: 'State-dependent service constraint',
              entity: ruleEntity,
              rule: ['Service logic branches on status values (AUDIT/AUDITING/APPROVED/DRAFT/REJECT/SUBMIT/PENDING).'],
              confidence: 'low',
              evidence: [sample.file],
              context: [`${sample.file}: service logic checks order status before proceeding.`],
              status: 'candidate',
            });
          }
        }

        if (isEndpoint) {
          let authIndex = 0;
          for (const pm of body.matchAll(PREAUTHORIZE_RE)) {
            rules.push({
              id: `rule.java.auth-${sample.file
                .replace(/[^a-z0-9]/gi, '')
                .toLowerCase()
                .slice(-12)}-${authIndex++}`,
              name: `${pm[1]} authorization guard`,
              entity: ruleEntityName(className),
              preconditions: [pm[2]],
              rule: [`Endpoint access requires: ${pm[2]}.`],
              confidence: 'low',
              evidence: [sample.file],
              context: [`${sample.file}: ${pm[1]}("${pm[2]}") on ${className}.`],
              status: 'candidate',
            });
          }

          let base = '';
          const cmm = CLASS_MAPPING_RE.exec(before);
          if (cmm?.[1]) base = cmm[1].replace(/^\/|\/$/g, '');
          for (const mm of body.matchAll(METHOD_MAPPING_RE)) {
            const verb = verbFromMapping(mm[0].match(/@(\w+)/)?.[1] ?? '');
            const sub = (mm[1] ?? '').replace(/^\/|\/$/g, '');
            const path = '/' + [base, sub].filter(Boolean).join('/');
            apis.push({
              id: routeId(verb, path),
              method: verb,
              path,
              entity: matchRouteEntity(path, ctx.entities),
              kind: 'backend',
              confidence: 'low',
              evidence: [sample.file],
            });
          }
        }
      }
    }

    const result: AnalyzeResult = {};
    if (entities.length) result.entities = entities;
    if (relations.length) result.relations = relations;
    if (rules.length) result.rules = rules;
    if (apis.length) result.apis = apis;
    return result;
  },
};
