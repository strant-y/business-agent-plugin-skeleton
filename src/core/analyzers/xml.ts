import type { Analyzer, AnalyzeResult } from '../analyzer.js';
import type { Entity, Relation } from '../types.js';
import { pascal, entityId } from './parse.js';
import { parseSqlRelations } from './parse.js';

const RESULT_MAP_RE = /<resultMap\b([^>]*)>([\s\S]*?)<\/resultMap>/gi;
const RESULT_PROP_RE = /<(?:id|result|association|collection)\b[^>]*\bproperty="([^"]+)"[^>]*\bcolumn="([^"]*)"/gi;
const ASSOCIATION_RE = /<association\b[^>]*\bproperty="([^"]+)"[^>]*\bjavaType="([^"]+)"[^>]*>/gi;
const SELECT_RE = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
const DML_RE = /<(insert|update|delete)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

function typeFromAttrs(attrs: string): string | undefined {
  return /type="([^"]+)"/.exec(attrs)?.[1] ?? /resultType="([^"]+)"/.exec(attrs)?.[1];
}

function addEntity(entities: Entity[], name: string, file: string, description: string): Entity {
  const existing = entities.find((e) => e.name === name);
  if (existing) {
    if (!existing.evidence.includes(file)) existing.evidence.push(file);
    return existing;
  }
  const entity: Entity = {
    id: entityId(name),
    name,
    type: 'business_entity',
    description,
    confidence: 'medium',
    attributes: [],
    evidence: [file],
  };
  entities.push(entity);
  return entity;
}

function mergeAttributes(entity: Entity, attrs: NonNullable<Entity['attributes']>): void {
  const seen = new Set((entity.attributes ?? []).map((a) => a.name));
  for (const attr of attrs) {
    if (seen.has(attr.name)) continue;
    seen.add(attr.name);
    entity.attributes = [...(entity.attributes ?? []), attr];
  }
}

export const xmlAnalyzer: Analyzer = {
  name: 'xml',
  analyze(scan) {
    const entities: Entity[] = [];
    const relations: Relation[] = [];

    for (const sample of scan.samples) {
      if (!/\.xml$/i.test(sample.file)) continue;

      for (const rm of sample.text.matchAll(RESULT_MAP_RE)) {
        const mapped = typeFromAttrs(rm[1]);
        if (!mapped) continue;
        const name = pascal(mapped);
        const entity = addEntity(
          entities,
          name,
          sample.file,
          `MyBatis resultMap discovered in ${sample.file} (type ${mapped}).`,
        );
        const props: Entity['attributes'] = [];
        for (const p of rm[2].matchAll(RESULT_PROP_RE)) {
          if (props.some((x) => x.name === p[1])) continue;
          props.push({ name: p[1], type: p[2] || undefined, description: `Column ${p[2]}` });
        }
        mergeAttributes(entity, props);

        for (const a of rm[2].matchAll(ASSOCIATION_RE)) {
          const target = pascal(a[2]);
          if (target === name) continue;
          relations.push({
            id: `relation.${name.toLowerCase()}-${target.toLowerCase()}-association`,
            source: name,
            target,
            relationship: 'references',
            cardinality: 'N:1',
            description: `MyBatis association on ${name}.${a[1]} → ${target}.`,
            confidence: 'medium',
            evidence: [sample.file],
          });
        }
      }

      for (const sel of sample.text.matchAll(SELECT_RE)) {
        const mapped = typeFromAttrs(sel[1]);
        if (mapped) {
          addEntity(entities, pascal(mapped), sample.file, `MyBatis result type ${mapped}.`);
        }
        const parsed = parseSqlRelations(sel[2], sample.file);
        for (const e of parsed.entities) {
          addEntity(entities, e.name, sample.file, e.description);
        }
        relations.push(...parsed.relations);
      }

      for (const dml of sample.text.matchAll(DML_RE)) {
        const parsed = parseSqlRelations(dml[3], sample.file);
        for (const e of parsed.entities) {
          addEntity(entities, e.name, sample.file, e.description);
        }
        relations.push(...parsed.relations);
      }
    }

    const result: AnalyzeResult = {};
    if (entities.length) result.entities = entities;
    if (relations.length) result.relations = relations;
    return result;
  },
};
